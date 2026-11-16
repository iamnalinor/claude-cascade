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
  return nonEmpty(servers(settings).map((server) => pin(server, protocol)));
}

export function isKnown(outbound: JsonObject): boolean {
  return isProxy(outbound) || UTILITY_PROTOCOLS.has(string(outbound.protocol) ?? "");
}

export function isProxy(outbound: JsonObject): boolean {
  return PROXY_PROTOCOLS.has(string(outbound.protocol) ?? "");
}

export function validateTransportSecurity(outbound: JsonObject): void {
  const protocol = outbound.protocol;
  if (protocol !== "vless" && protocol !== "trojan") {
    return;
  }
  const security = string(object(outbound.streamSettings)?.security)?.toLowerCase();
  const settings = object(outbound.settings);
  if (settings === undefined) {
    throw new Error("missing-proxy-settings");
  }
  for (const server of servers(settings)) {
    const accounts = users(server);
    if (protocol === "vless" && (hasReverse(server) || accounts.some(hasReverse))) {
      throw new Error("unsupported-reverse-proxy");
    }
    if (security === "tls" || security === "reality") {
      continue;
    }
    requireLocalOrEncrypted(server, protocol === "vless" ? accounts : []);
  }
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

function hasReverse(user: JsonObject): boolean {
  return Object.keys(user).some((key) => key.toLowerCase() === "reverse");
}

function isEncrypted(user: JsonObject): boolean {
  const encryption = string(user.encryption);
  return encryption !== undefined && encryption !== "none";
}

function isPrivateAddress(address: string): boolean {
  const host = address.replaceAll(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (host.includes(":")) {
    return /^(?:f[cd][\da-f]{2}|fe[89ab][\da-f]):/iu.test(host);
  }
  const ip = /^(10|172|192|169)\.(\d+)\.\d+\.\d+$/u.exec(host);
  if (ip !== null) {
    const second = Number(ip[2]);
    return (
      ip[1] === "10" ||
      (ip[1] === "172" && second >= 16 && second <= 31) ||
      (ip[1] === "192" && second === 168) ||
      (ip[1] === "169" && second === 254)
    );
  }
  return [".local", ".lan", ".home.arpa", ".localdomain"].some((suffix) => host.endsWith(suffix));
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
    const accounts = users(server);
    if (accounts.length === 0 || accounts.some((user) => string(user.id) === undefined)) {
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

function requireLocalOrEncrypted(server: JsonObject, accounts: JsonObject[]): void {
  const [address] = endpoint(server);
  if (!isPrivateAddress(address) && !(accounts.length > 0 && accounts.every(isEncrypted))) {
    throw new Error("insecure-public-endpoint");
  }
}

function servers(settings: JsonObject): JsonObject[] {
  const entries: JsonValue | undefined = settings.vnext ?? settings.servers;
  return entries === undefined ? [settings] : objects(entries);
}

function users(server: JsonObject): JsonObject[] {
  return server.users === undefined ? [server] : objects(server.users);
}

function wireguardPeer(peer: JsonObject): Endpoint {
  const match = /^(?<address>\[[^\]]+\]|[^:]+):(?<port>\d+)$/u.exec(string(peer.endpoint) ?? "");
  if (match?.groups?.address === undefined || string(peer.publicKey) === undefined) {
    throw new Error("invalid-wireguard-peer");
  }
  return endpoint({ address: match.groups.address, port: Number(match.groups.port) });
}
