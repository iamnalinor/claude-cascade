import { endpoints, validateTransportSecurity } from "./endpoints.ts";
import { type JsonObject, object, string } from "./json-value.ts";
import { assertExactKey, linkTargets } from "./outbound-graph.ts";

const BRIDGE_STREAM_FIELDS = new Set([
  "method",
  "network",
  "rawSettings",
  "realitySettings",
  "security",
  "sockopt",
  "tcpSettings",
  "tlsSettings",
]);
const RAW_NETWORKS = new Set(["raw", "tcp"]);
const HYSTERIA_OPTIONS = new Set(["auth", "version"]);
const HYSTERIA_SERVER_FIELDS = new Set(["address", "port", "version"]);
const HYSTERIA_STREAM_FIELDS = new Set(["hysteriaSettings", "network", "security", "tlsSettings"]);
const PROXY_STREAM_FIELDS = new Set(["method", "network", "security", "tlsSettings"]);
const REALITY_CLIENT_FIELDS = new Set([
  "fingerprint",
  "mldsa65Verify",
  "password",
  "publicKey",
  "serverName",
  "shortId",
  "show",
  "spiderX",
]);

export function validateBridge(bridge: JsonObject): void {
  const stream = object(bridge.streamSettings) ?? {};
  const tls = object(stream.tlsSettings);
  assertExactKey(tls, "allowInsecure");
  if (
    (bridge.streamSettings !== undefined && object(bridge.streamSettings) === undefined) ||
    tls?.allowInsecure === true ||
    linkTargets(bridge).length > 0
  ) {
    throw new Error("invalid-bridge");
  }
  if (bridge.protocol === "hysteria") {
    validateHysteria(bridge, stream);
  } else if (bridge.protocol === "http" || bridge.protocol === "socks") {
    validateProxyBridge(bridge, stream);
  } else {
    validateVless(bridge, stream);
  }
  validateTransportSecurity(bridge);
  endpoints(bridge);
}

function isRaw(stream: JsonObject): boolean {
  return [stream.network, stream.method].every(
    (value) => value === undefined || RAW_NETWORKS.has(string(value) ?? ""),
  );
}

function validateHysteria(bridge: JsonObject, stream: JsonObject): void {
  const server = object(bridge.settings);
  const options = object(stream.hysteriaSettings);
  if (
    stream.network !== "hysteria" ||
    stream.security !== "tls" ||
    Object.keys(stream).some((key) => !HYSTERIA_STREAM_FIELDS.has(key)) ||
    string(object(stream.tlsSettings)?.serverName) === undefined ||
    server?.version !== 2 ||
    Object.keys(server).some((key) => !HYSTERIA_SERVER_FIELDS.has(key)) ||
    options?.version !== 2 ||
    Object.keys(options).some((key) => !HYSTERIA_OPTIONS.has(key)) ||
    string(options.auth) === undefined
  ) {
    throw new Error("invalid-hysteria-bridge");
  }
}

function validateProxyBridge(bridge: JsonObject, stream: JsonObject): void {
  if (
    Object.keys(stream).some((key) => !PROXY_STREAM_FIELDS.has(key)) ||
    !isRaw(stream) ||
    !["none", "tls"].includes(string(stream.security ?? "none") ?? "") ||
    endpoints(bridge).length !== 1
  ) {
    throw new Error("invalid-forward-proxy-bridge");
  }
}

function validateRealityClient(settings: JsonObject | undefined): void {
  if (
    settings === undefined ||
    Object.keys(settings).some((field) => !REALITY_CLIENT_FIELDS.has(field))
  ) {
    throw new Error("invalid-reality-client-fields");
  }
  const key = string(settings.password) ?? string(settings.publicKey) ?? "";
  const { shortId = "" } = settings;
  if (
    key.length !== 43 ||
    /[^\w-]/u.test(key) ||
    typeof shortId !== "string" ||
    shortId.length > 16 ||
    shortId.length % 2 !== 0 ||
    /[^\da-f]/iu.test(shortId)
  ) {
    throw new Error("invalid-reality-client-settings");
  }
}

function validateVless(bridge: JsonObject, stream: JsonObject): void {
  if (
    bridge.protocol !== "vless" ||
    Object.keys(stream).some((key) => !BRIDGE_STREAM_FIELDS.has(key)) ||
    !isRaw(stream) ||
    !["reality", "tls"].includes(string(stream.security) ?? "")
  ) {
    throw new Error("invalid-bridge");
  }
  if (stream.security === "reality") {
    validateRealityClient(object(stream.realitySettings));
  }
}
