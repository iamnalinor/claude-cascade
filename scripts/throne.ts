import { Database } from "bun:sqlite";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { validateBridge } from "../src/exit-bridge.ts";
import { object, parseJson } from "../src/json-value.ts";
import { LOCAL, preparePrivateDirectory, readPrivate, writePrivate } from "./private-files.ts";

type Candidate = { gid: number; outbound_json: string };
type Group = { id: number; url: string };
const DB_PATH = path.join(homedir(), ".config/Throne/config/throne.db");

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

async function hasSupportedStagingBridge(): Promise<boolean> {
  try {
    const outbound = object(parseJson(await readPrivate("staging-outbound.json")));
    if (outbound === undefined) {
      return false;
    }
    validateBridge(outbound);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (Bun.argv.includes("--probe")) {
    throw new Error("subscription-probes-disabled-use-real-client");
  }
  const fromWorker = Bun.argv.indexOf("--worker");
  if (fromWorker !== -1) {
    const origin = Bun.argv[fromWorker + 1];
    if (origin === undefined) {
      throw new Error("missing-worker-origin");
    }
    await smokeWorker(origin);
    return;
  }
  await preparePrivateDirectory();
  await access(DB_PATH);
  using database = new Database(DB_PATH, { readonly: true });
  const groups = readGroups(database);
  if (groups.length !== 2) {
    throw new Error("two-active-throne-subscriptions-required");
  }
  const bindings = Object.fromEntries(
    groups.map((group, index) => [`UPSTREAM_${index === 0 ? "A" : "B"}`, group.url]),
  );
  if (Object.values(bindings).some((url) => URL.parse(url)?.protocol !== "https:")) {
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
      stagingBridge: isStagingExists ? await hasSupportedStagingBridge() : bridge !== undefined,
    }),
  );
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

async function smokeWorker(origin: string): Promise<void> {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".workers.dev") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("workers-dev-origin-required");
  }
  const health = await workerHealth(url);
  console.log(JSON.stringify({ health: health.status }));
  if (!health.ok) {
    process.exitCode = 1;
  }
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

try {
  await main();
} catch {
  console.error(
    Bun.argv.includes("--worker")
      ? "Could not check Worker health"
      : "Could not read the two active Throne subscriptions",
  );
  process.exitCode = 1;
}
