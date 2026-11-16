import { validateBridge } from "../src/exit-bridge.ts";
import { type JsonObject, object, objects, parseJson } from "../src/json-value.ts";
import { parseSubscription } from "../src/subscription-format.ts";
import { LOCAL, preparePrivateDirectory, readPrivate, writePrivate } from "./private-files.ts";

function forwardProxy(url: URL): JsonObject {
  if (!["", "/"].includes(url.pathname) || url.search !== "" || url.hash !== "") {
    throw new Error("invalid-forward-proxy-url");
  }
  const isTls = url.protocol === "https:";
  const isSocks = url.protocol.startsWith("socks");
  const address = url.hostname.replaceAll(/^\[|\]$/gu, "");
  const port = url.port === "" ? (isSocks ? 1080 : isTls ? 443 : 80) : Number(url.port);
  const users =
    url.username === "" && url.password === ""
      ? []
      : [{ user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }];
  return {
    protocol: isSocks ? "socks" : "http",
    settings: { servers: [{ address, port, users }] },
    ...(isTls && { streamSettings: { security: "tls", tlsSettings: { serverName: address } } }),
  };
}

function readBridge(raw: string): JsonObject | undefined {
  const input = raw.trim();
  if (/^(?:https?|socks5h?):\/\//iu.test(input)) {
    return forwardProxy(new URL(input));
  }
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
  console.error("Usage: bun scripts/prepare-secrets.ts <outbound.json or proxy-link.txt>");
  process.exit(2);
}
try {
  await preparePrivateDirectory();
  const bridge = readBridge(await Bun.file(bridgePath).text());
  const upstreams = object(parseJson(await readPrivate("upstreams.json")));
  if (bridge === undefined || upstreams === undefined) {
    throw new Error("invalid-settings");
  }
  validateBridge(bridge);
  const localSecrets = Bun.file(`${LOCAL}/worker-secrets.json`);
  const existing = (await localSecrets.exists())
    ? object(parseJson(await readPrivate("worker-secrets.json")))
    : undefined;
  const token =
    existing?.SUB_ACCESS_TOKEN ??
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  await writePrivate(
    "worker-secrets.json",
    JSON.stringify({
      ...upstreams,
      EXIT_OUTBOUND: JSON.stringify(bridge),
      SUB_ACCESS_TOKEN: token,
    }),
  );
  console.log("Prepared .local/worker-secrets.json");
} catch {
  console.error("Could not prepare the Worker secrets");
  process.exitCode = 1;
}
