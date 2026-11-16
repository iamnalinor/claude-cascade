import { type JsonObject, object, parseJson } from "./json-value.ts";

const SUPPORTED_PARAMETERS = new Set([
  "allowInsecure",
  "alpn",
  "authority",
  "ech",
  "encryption",
  "extra",
  "flow",
  "fm",
  "fp",
  "headerType",
  "host",
  "mode",
  "mtu",
  "path",
  "pbk",
  "pcs",
  "pqv",
  "security",
  "seed",
  "serviceName",
  "sid",
  "sni",
  "spx",
  "tti",
  "type",
]);

export function linkTransport(parameters: URLSearchParams, defaultSecurity: string): JsonObject {
  const type = parameters.get("type") ?? "raw";
  const network = type === "tcp" ? "raw" : type === "splithttp" ? "xhttp" : type;
  const security = parameters.get("security") ?? defaultSecurity;
  validateParameters(network, parameters);
  return {
    network,
    security,
    ...serverSecurity(security, parameters),
    ...transportSettings(network, parameters),
  };
}

function integerParameter(parameters: URLSearchParams, key: string): JsonObject {
  const raw = parameters.get(key);
  if (raw === null) {
    return {};
  }
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("invalid-numeric-parameter");
  }
  return { [key]: number };
}

function optional(name: string, value: null | string): JsonObject {
  return value === null || value === "" ? {} : { [name]: value };
}

function rawSettings(parameters: URLSearchParams): JsonObject {
  const header = parameters.get("headerType");
  const host = parameters.get("host");
  const path = parameters.get("path");
  if (header === "http") {
    return {
      rawSettings: {
        header: {
          request: {
            ...(host !== null && { headers: { Host: host.split(",") } }),
            ...(path !== null && { path: path.split(",") }),
          },
          type: "http",
        },
      },
    };
  }
  if ((header !== null && header !== "none") || host !== null || path !== null) {
    throw new Error("unsupported-raw-header");
  }
  return {};
}

function reality(parameters: URLSearchParams, identity: JsonObject): JsonObject {
  const key = parameters.get("pbk");
  if (
    key === null ||
    key === "" ||
    ["allowInsecure", "ech", "pcs", "alpn"].some((name) => parameters.has(name))
  ) {
    throw new Error("unsupported-reality-settings");
  }
  return {
    realitySettings: {
      ...identity,
      ...optional("mldsa65Verify", parameters.get("pqv")),
      ...optional("shortId", parameters.get("sid")),
      ...optional("spiderX", parameters.get("spx")),
      publicKey: key,
    },
  };
}

function serverSecurity(security: string, parameters: URLSearchParams): JsonObject {
  if (security === "none") {
    if (
      ["alpn", "allowInsecure", "ech", "fp", "pbk", "pqv", "sid", "sni", "spx"].some((key) =>
        parameters.has(key),
      )
    ) {
      throw new Error("unexpected-security-settings");
    }
    return {};
  }
  const serverName = optional("serverName", parameters.get("sni"));
  const fingerprint = optional("fingerprint", parameters.get("fp"));
  const identity = { ...serverName, ...fingerprint };
  return security === "reality"
    ? reality(parameters, identity)
    : tls(security, parameters, identity);
}

function tls(security: string, parameters: URLSearchParams, identity: JsonObject): JsonObject {
  if (
    security !== "tls" ||
    ["pbk", "pqv", "sid", "spx", "pcs"].some((name) => parameters.has(name))
  ) {
    throw new Error("unsupported-security");
  }
  const alpn = parameters.get("alpn");
  const allowInsecure = parameters.get("allowInsecure");
  if (allowInsecure !== null && allowInsecure !== "0" && allowInsecure !== "1") {
    throw new Error("invalid-tls-verification");
  }
  return {
    tlsSettings: {
      ...identity,
      ...optional("echConfigList", parameters.get("ech")),
      ...(!(alpn === null || alpn === "") && { alpn: alpn.split(",") }),
      ...(allowInsecure !== null && { allowInsecure: allowInsecure === "1" }),
    },
  };
}

function transportSettings(network: string, parameters: URLSearchParams): JsonObject {
  const hostPath = {
    ...optional("host", parameters.get("host")),
    ...optional("path", parameters.get("path")),
  };
  switch (network) {
    case "grpc": {
      const mode = parameters.get("mode");
      if (mode !== null && mode !== "gun" && mode !== "multi") {
        throw new Error("unsupported-grpc-mode");
      }
      return {
        grpcSettings: {
          ...optional("authority", parameters.get("authority")),
          ...optional("serviceName", parameters.get("serviceName")),
          ...(mode !== null && { multiMode: mode === "multi" }),
        },
      };
    }
    case "httpupgrade": {
      return { httpupgradeSettings: hostPath };
    }
    case "kcp": {
      return {
        kcpSettings: {
          ...integerParameter(parameters, "mtu"),
          ...integerParameter(parameters, "tti"),
        },
      };
    }
    case "raw": {
      return rawSettings(parameters);
    }
    case "ws": {
      return { wsSettings: hostPath };
    }
    case "xhttp": {
      return { xhttpSettings: xhttpSettings(parameters) };
    }
    default: {
      throw new Error("unsupported-transport");
    }
  }
}

function validateParameters(network: string, parameters: URLSearchParams): void {
  const groups: [string[], string[]][] = [
    [
      ["host", "path"],
      ["raw", "xhttp", "ws", "httpupgrade"],
    ],
    [["mode"], ["xhttp", "grpc"]],
    [["extra"], ["xhttp"]],
    [["authority", "serviceName"], ["grpc"]],
    [["mtu", "tti", "seed"], ["kcp"]],
    [["headerType"], ["raw", "kcp"]],
  ];
  for (const [key] of parameters) {
    if (!SUPPORTED_PARAMETERS.has(key) || parameters.getAll(key).length !== 1) {
      throw new Error("unsupported-link-parameter");
    }
  }
  if (
    network === "kcp" &&
    (parameters.has("seed") || !["none", null].includes(parameters.get("headerType")))
  ) {
    throw new Error("legacy-kcp-obfuscation");
  }
  if (
    groups.some(
      ([keys, networks]) => keys.some((key) => parameters.has(key)) && !networks.includes(network),
    )
  ) {
    throw new Error("incompatible-link-parameter");
  }
}

function xhttpSettings(parameters: URLSearchParams): JsonObject {
  const rawExtra = parameters.get("extra");
  const extra = rawExtra === null || rawExtra === "" ? {} : object(parseJson(rawExtra));
  if (extra === undefined) {
    throw new Error("invalid-xhttp-extra");
  }
  const mode = parameters.get("mode");
  if (mode !== null && !["auto", "packet-up", "stream-one", "stream-up"].includes(mode)) {
    throw new Error("invalid-xhttp-mode");
  }
  return {
    ...optional("host", parameters.get("host")),
    ...optional("path", parameters.get("path")),
    ...optional("mode", mode),
    ...(Object.keys(extra).length > 0 && { extra }),
  };
}
