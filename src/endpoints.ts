import { type JsonObject, type JsonValue, object, objects, string } from "./json-value.ts";

const UTILITY_PROTOCOLS = new Set(["blackhole", "dns", "freedom", "loopback"]);
const PROXY_PROTOCOLS = new Set([
  "http",
  "hysteria",
  "shadowsocks",
  "socks",
  "trojan",
  "vless",
  "vmess",
  "wireguard",
]);

type Endpoint = readonly [address: string, port: number];

export function endpoints(outbound: JsonObject): Endpoint[] {
  const protocol = string(outbound.protocol) ?? "";
  const settings = object(outbound.settings);
  if (!isProxy(outbound) || settings === undefined) {
    throw new Error("unsupported-main");
  }
  if (protocol === "wireguard") {
    if (string(settings.secretKey) === undefined) {
      throw new Error("invalid-wireguard-key");
    }
    return nonEmpty(objects(settings.peers).map(wireguardPeer));
  }
  const entries: JsonValue | undefined = settings.vnext ?? settings.servers;
  return nonEmpty(
    (entries === undefined ? [settings] : objects(entries)).map((server) => pin(server, protocol)),
  );
}

export function isKnown(outbound: JsonObject): boolean {
  return isProxy(outbound) || UTILITY_PROTOCOLS.has(string(outbound.protocol) ?? "");
}

export function isProxy(outbound: JsonObject): boolean {
  return PROXY_PROTOCOLS.has(string(outbound.protocol) ?? "");
}

function endpoint(server: JsonObject): Endpoint {
  const address = string(server.address);
  const port = server.port;
  if (
    address === undefined ||
    !isValidHost(address) ||
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("invalid-endpoint");
  }
  return [address.toLowerCase(), port];
}

function isValidHost(value: string): boolean {
  const host = value
    .replaceAll(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
  const bracketed = host.includes(":") ? `[${host}]` : host;
  if (/[/@?#%\\\s]/u.test(host)) {
    return false;
  }
  const parsed = URL.parse(`http://${bracketed}`);
  if (parsed?.port !== "") {
    return false;
  }
  const name = parsed.hostname;
  if (name.startsWith("[")) {
    return !["[::1]", "[::]", "[::ffff:0:0]"].includes(name) && !name.startsWith("[::ffff:7f");
  }
  if (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name.startsWith("127.") ||
    name.startsWith("0.")
  ) {
    return false;
  }
  return name
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        !label.startsWith("-") &&
        !label.endsWith("-") &&
        /^[a-z\d-]+$/iu.test(label),
    );
}

function nonEmpty(values: Endpoint[]): Endpoint[] {
  if (values.length === 0) {
    throw new Error("empty-endpoints");
  }
  return values;
}

function pin(server: JsonObject, protocol: string): Endpoint {
  if (protocol === "vless" || protocol === "vmess") {
    const users = server.users === undefined ? [server] : objects(server.users);
    if (users.length === 0 || users.some((user) => string(user.id) === undefined)) {
      throw new Error("missing-uuid");
    }
  }
  if (
    (protocol === "trojan" || protocol === "shadowsocks") &&
    string(server.password) === undefined
  ) {
    throw new Error("missing-password");
  }
  return endpoint(server);
}

function wireguardPeer(peer: JsonObject): Endpoint {
  const match = /^(?<address>\[[^\]]+\]|[^:]+):(?<port>\d+)$/u.exec(string(peer.endpoint) ?? "");
  if (match?.groups?.address === undefined || string(peer.publicKey) === undefined) {
    throw new Error("invalid-wireguard-peer");
  }
  return endpoint({ address: match.groups.address, port: Number(match.groups.port) });
}
