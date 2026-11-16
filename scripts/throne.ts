import { Database } from "bun:sqlite";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import path from "node:path";

import { object, parseJson } from "../src/json-value.ts";
import { validateBridge } from "../src/routing.ts";
import { sources } from "../src/source-config.ts";
import { fetchSource, IncompatibleSource, readSource } from "../src/source-request.ts";
import { parseSubscription } from "../src/subscription-format.ts";

type Candidate = { gid: number; outbound_json: string };
type Group = { id: number; url: string };
const LOCAL = ".local";
const DB_PATH = path.join(homedir(), ".config/Throne/config/throne.db");
const HEADERS = {
  hwid: "x-hwid",
  os: "x-device-os",
  osversion: "x-ver-os",
  model: "x-device-model",
};

function findBridge(database: Database, groups: Group[]): Candidate | undefined {
  const [first, ...others] = groups;
  const candidates = database
    .query<Candidate, [number]>(`
    SELECT gid, outbound_json FROM profiles WHERE type = 'xrayvless' AND gid != ?
    ORDER BY CASE WHEN latency > 0 THEN 0 ELSE 1 END, latency, id
  `)
    .all(first?.id ?? -1);
  return candidates.find((candidate) => {
    if (others.every(({ id }) => candidate.gid !== id)) {
      return false;
    }
    try {
      const outbound = object(parseJson(candidate.outbound_json));
      if (outbound !== undefined) {
        validateBridge(outbound);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  });
}

async function machineId(): Promise<string> {
  for (const name of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const text = await readFile(name, "utf8");
      const id = text.trim();
      if (/^[\da-f]{32}$/iu.test(id)) {
        return id;
      }
    } catch {
      continue;
    }
  }
  throw new Error("no-registered-machine-id");
}

async function main(): Promise<void> {
  await mkdir(LOCAL, { mode: 0o700, recursive: true });
  await access(DB_PATH);
  using database = new Database(DB_PATH, { readonly: true });
  const fromWorker = Bun.argv.indexOf("--worker");
  if (fromWorker !== -1) {
    const origin = Bun.argv[fromWorker + 1];
    if (origin === undefined) {
      throw new Error("missing-worker-origin");
    }
    await smokeWorker(origin, await throneIdentity(database));
    return;
  }
  const groups = readGroups(database);
  if (groups.length !== 2) {
    throw new Error("two-active-throne-subscriptions-required");
  }
  const bindings = Object.fromEntries(
    groups.map((group, index) => [`UPSTREAM_${index === 0 ? "A" : "B"}`, group.url]),
  );
  const configured = sources({
    SOURCES: [
      { id: "throne-a", urlSecret: "UPSTREAM_A" },
      { id: "throne-b", urlSecret: "UPSTREAM_B" },
    ],
  });
  if (
    configured.some(({ urlSecret }) => URL.parse(bindings[urlSecret] ?? "")?.protocol !== "https:")
  ) {
    throw new Error("unsupported-throne-url");
  }
  await writePrivate("upstreams.json", JSON.stringify(bindings));
  const bridge = findBridge(database, groups);
  const isStagingExists = await Bun.file(path.join(LOCAL, "staging-outbound.json")).exists();
  if (bridge !== undefined && !isStagingExists) {
    await writePrivate("staging-outbound.json", bridge.outbound_json);
  }
  console.log(
    JSON.stringify({
      groups: groups.map(({ id }) => id),
      stagingBridge: isStagingExists || bridge !== undefined,
    }),
  );
  if (Bun.argv.includes("--probe")) {
    await probe(groups, await throneIdentity(database));
  }
}

async function probe(groups: Group[], headers: Headers): Promise<void> {
  for (const group of groups) {
    try {
      const request = new Request(group.url, { headers });
      if (new URL(request.url).protocol !== "https:") {
        throw new Error("invalid-source");
      }
      const response = await fetchSource(request, fetch);
      const body = await readSource(response);
      await writePrivate(`probe-${group.id}.txt`, body);
      const parsed = parseSubscription(body, "auto");
      const shape = /^\s*[{[]/u.test(body)
        ? "json"
        : body.includes("://")
          ? "links"
          : "base64-or-unknown";
      const controls = ["providerid", "installid", "subscription-always-hwid-enable"].filter(
        (name) => response.headers.has(name) || parsed.metadata.has(name),
      );
      console.log(
        JSON.stringify({
          controls,
          group: group.id,
          parsed: parsed.profiles.length,
          rejected: parsed.rejected,
          shape,
          status: response.status,
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          group: group.id,
          result:
            error instanceof IncompatibleSource ? error.message : "unavailable-or-unsupported",
        }),
      );
    }
  }
}

function readGroups(database: Database): Group[] {
  return database
    .query<Group, []>(`
    SELECT groups.id, trim(groups.url) AS url FROM groups
    LEFT JOIN groups_order ON groups_order.group_id = groups.id
    WHERE NOT groups.archive AND trim(coalesce(groups.url,'')) <> ''
    ORDER BY groups_order.display_order, groups.id LIMIT 2
  `)
    .all();
}

async function smokeWorker(origin: string, identity: Headers): Promise<void> {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".workers.dev") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("workers-dev-origin-required");
  }
  const secrets = object(parseJson(await Bun.file(path.join(LOCAL, "worker-secrets.json")).text()));
  const token = secrets?.SUB_ACCESS_TOKEN;
  if (typeof token !== "string") {
    throw new TypeError("missing-subscription-token");
  }
  const health = await workerHealth(url);
  console.log(JSON.stringify({ health: health.status }));
  const response = await fetch(new URL(`/sub/${token}`, url), {
    headers: identity,
    redirect: "error",
    signal: AbortSignal.timeout(25_000),
  });
  const body = await response.text();
  let decoded: ReturnType<typeof parseJson>;
  try {
    decoded = parseJson(body);
  } catch {
    console.log(JSON.stringify({ status: response.status, error: "non-JSON response" }));
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      failed: response.headers.get("x-subscription-sources-failed"),
      incompatible: response.headers.get("x-subscription-sources-incompatible"),
      rejected: response.headers.get("x-subscription-rejected"),
      status: response.status,
      profiles: Array.isArray(decoded) ? decoded.length : 0,
    }),
  );
  if (!response.ok || !Array.isArray(decoded) || decoded.length === 0) {
    process.exitCode = 1;
    return;
  }
  await writePrivate("worker-smoke.json", JSON.stringify(decoded));
}

async function throneIdentity(database: Database): Promise<Headers> {
  const settings = new Map(
    database
      .query<{ key: string; value: string }, []>(
        "SELECT key, value FROM settings WHERE key IN ('user_agent', 'user_agent2', 'sub_send_hwid', 'sub_custom_hwid_params')",
      )
      .all()
      .map(({ key, value }) => [key, value]),
  );
  const osRelease = await readFile("/etc/os-release", "utf8");
  const model = /^PRETTY_NAME=(?<name>.*)$/mu
    .exec(osRelease)
    ?.groups?.name?.replaceAll(/^"|"$/gu, "");
  const ua = [settings.get("user_agent2"), settings.get("user_agent")].find(
    (value) => value !== undefined && value !== "",
  );
  if (settings.get("sub_send_hwid") !== "true") {
    throw new Error("throne-hwid-disabled");
  }
  const headers = new Headers({
    "user-agent": ua ?? "Throne/1.2.4",
    "x-hwid": await machineId(),
    "x-device-os": "Linux",
    "x-ver-os": release(),
    "x-device-model": model ?? "Linux",
  });
  const overrides = (settings.get("sub_custom_hwid_params") ?? "").split(",");
  for (const pair of overrides) {
    const [name, ...parts] = pair.split("=");
    const key = name?.trim().toLowerCase();
    const value = parts.join("=").trim();
    if (key !== undefined && Object.hasOwn(HEADERS, key) && value !== "" && value.length < 1000) {
      headers.set(HEADERS[key as keyof typeof HEADERS], value);
    }
  }
  return headers;
}

async function workerHealth(origin: URL): Promise<Response> {
  const health = new URL("/health", origin);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(health, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        return response;
      }
      await response.body?.cancel();
    } catch {
      // A health request can be retried without sending the device identity.
    }
    await Bun.sleep(300);
  }
  return await fetch(health, { signal: AbortSignal.timeout(8000) });
}

async function writePrivate(name: string, content: string): Promise<void> {
  await writeFile(path.join(LOCAL, name), content, { mode: 0o600 });
}

try {
  await main();
} catch {
  console.error(
    Bun.argv.includes("--worker")
      ? "Could not check Worker health or read the protected subscription"
      : "Could not read the two active Throne subscriptions",
  );
  process.exitCode = 1;
}
