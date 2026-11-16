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
  const stream = object(bridge.streamSettings);
  const endpointTransport = [stream?.network, stream?.method];
  if (
    bridge.protocol !== "vless" ||
    stream === undefined ||
    Object.keys(stream).some((key) => !BRIDGE_STREAM_FIELDS.has(key)) ||
    endpointTransport.some(
      (value) => value !== undefined && !RAW_NETWORKS.has(string(value) ?? ""),
    ) ||
    !["reality", "tls"].includes(string(stream.security) ?? "") ||
    object(stream.tlsSettings)?.allowInsecure === true ||
    linkTargets(bridge).length > 0
  ) {
    throw new Error("invalid-bridge");
  }
  assertExactKey(object(stream.tlsSettings), "allowInsecure");
  if (stream.security === "reality") {
    validateRealityClient(object(stream.realitySettings));
  }
  validateTransportSecurity(bridge);
  endpoints(bridge);
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
