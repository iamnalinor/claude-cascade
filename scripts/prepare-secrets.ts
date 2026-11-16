import { mkdir, writeFile } from "node:fs/promises";

import { type JsonObject, object, objects, parseJson } from "../src/json-value.ts";
import { validateBridge } from "../src/routing.ts";
import { parseSubscription } from "../src/subscription-format.ts";

function readBridge(raw: string): JsonObject | undefined {
  const input = raw.trim();
  if (!input.startsWith("vless://")) {
    return object(parseJson(input));
  }
  const { profiles, rejected } = parseSubscription(input, "links");
  if (profiles.length !== 1 || rejected > 0) {
    return undefined;
  }
  const outbounds = objects(profiles[0]?.outbounds);
  return outbounds.length === 1 ? outbounds[0] : undefined;
}

const bridgePath = Bun.argv[2];
if (bridgePath === undefined) {
  console.error("Usage: bun scripts/prepare-secrets.ts <outbound.json or vless-link.txt>");
  process.exit(2);
}
const local = ".local";
try {
  const bridge = readBridge(await Bun.file(bridgePath).text());
  const upstreams = object(parseJson(await Bun.file(`${local}/upstreams.json`).text()));
  if (bridge === undefined || upstreams === undefined) {
    throw new Error("invalid-settings");
  }
  validateBridge(bridge);
  await mkdir(local, { mode: 0o700, recursive: true });
  const localSecrets = Bun.file(`${local}/worker-secrets.json`);
  const existing = (await localSecrets.exists())
    ? object(parseJson(await localSecrets.text()))
    : undefined;
  const token =
    existing?.SUB_ACCESS_TOKEN ??
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  await writeFile(
    localSecrets.name ?? `${local}/worker-secrets.json`,
    JSON.stringify({
      ...upstreams,
      EXIT_OUTBOUND: JSON.stringify(bridge),
      SUB_ACCESS_TOKEN: token,
    }),
    { mode: 0o600 },
  );
  console.log("Prepared .local/worker-secrets.json");
} catch {
  console.error("Could not prepare the Worker secrets");
  process.exitCode = 1;
}
