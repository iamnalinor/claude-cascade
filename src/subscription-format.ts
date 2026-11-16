import { z } from "zod";

import { linkMask } from "./final-mask.ts";
import { type JsonObject, type JsonValue, object, parseJson, string } from "./json-value.ts";
import { linkTransport } from "./link-transport.ts";

export type SourceFormat = "auto" | "base64" | "links" | "xray";
type ParsedSubscription = {
  profiles: JsonObject[];
  metadata: ReadonlySet<string>;
  rejected: number;
};

const SIZE_LIMIT = 2 * 1024 * 1024;
const MAX_NODES = 100;
const BASE64 = /^[\w+/-]+={0,2}$/iu;
const METADATA = /^#\s*(?<key>[a-z][\da-z-]*)(?::|\s)/iu;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

export function parseSubscription(body: string, format: SourceFormat): ParsedSubscription {
  const value = body.trim();
  if (value.length > SIZE_LIMIT || value === "") {
    throw new Error("invalid-subscription-size");
  }
  if (format === "xray" || (format === "auto" && /^[{[]/u.test(value))) {
    return decodeXray(value);
  }
  if (format === "base64" || (format === "auto" && BASE64.test(value.replaceAll(/\s+/gu, "")))) {
    return decodeLinks(decode64(value));
  }
  return decodeLinks(value);
}

function decode64(value: string): string {
  const compact = value.replaceAll(/\s+/gu, "");
  if (!BASE64.test(compact) || compact.length % 4 === 1) {
    throw new Error("invalid-base64");
  }
  const normalized = compact.replaceAll("-", "+").replaceAll("_", "/");
  const bytes = Uint8Array.fromBase64(normalized);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function decodeLinks(body: string): ParsedSubscription {
  const metadata = new Set<string>();
  const profiles: JsonObject[] = [];
  let rejected = 0;
  for (const value of body.split(/\r?\n/u)) {
    const line = value.trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("#")) {
      const fields = METADATA.exec(line)?.groups;
      if (fields?.key !== undefined) {
        metadata.add(fields.key.toLowerCase());
      }
      continue;
    }
    if (profiles.length + rejected >= MAX_NODES) {
      throw new Error("too-many-nodes");
    }
    try {
      profiles.push(parseLink(line));
    } catch {
      rejected++;
    }
  }
  return { metadata, profiles, rejected };
}

function decodeXray(body: string): ParsedSubscription {
  const raw = parseJson(body);
  const values: JsonValue[] = Array.isArray(raw) ? raw : [raw];
  if (values.length > MAX_NODES) {
    throw new Error("too-many-nodes");
  }
  const profiles = values
    .map(object)
    .filter((node): node is JsonObject => node !== undefined && Array.isArray(node.outbounds));
  return { metadata: new Set(), profiles, rejected: values.length - profiles.length };
}

function hysteria(uri: string): JsonObject {
  const url = new URL(uri);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const name = url.searchParams.get("sni");
  if (user === "" || url.port === "" || url.searchParams.size > (name === null ? 0 : 1)) {
    throw new Error("unsupported-hysteria-link");
  }
  return profile(
    {
      protocol: "hysteria",
      settings: { address: url.hostname, port: Number(url.port), version: 2 },
      streamSettings: {
        hysteriaSettings: { auth: password === "" ? user : `${user}:${password}`, version: 2 },
        network: "hysteria",
        security: "tls",
        tlsSettings: name === null ? {} : { serverName: name },
      },
    },
    decodeURIComponent(url.hash.slice(1)) || "Hysteria2",
  );
}

function parseLink(uri: string): JsonObject {
  if (uri.startsWith("vless://") || uri.startsWith("trojan://")) {
    return vlessOrTrojan(uri);
  }
  if (uri.startsWith("hysteria2://") || uri.startsWith("hy2://")) {
    return hysteria(uri);
  }
  if (uri.startsWith("vmess://")) {
    return vmess(uri);
  }
  if (uri.startsWith("ss://")) {
    return shadowsocks(uri);
  }
  throw new Error("unsupported-link");
}

function profile(outbound: JsonObject, title: string, dialer?: JsonObject): JsonObject {
  const main = { ...outbound, tag: "main" };
  return { outbounds: dialer === undefined ? [main] : [main, dialer], remarks: title };
}

function shadowsocks(uri: string): JsonObject {
  const url = new URL(uri);
  if (url.searchParams.size > 0 || !url.username || !url.hostname || !url.port) {
    throw new Error("unsupported-shadowsocks-link");
  }
  const user = decodeURIComponent(url.username);
  const credentials =
    url.password === "" ? decode64(user) : `${user}:${decodeURIComponent(url.password)}`;
  const separator = credentials.indexOf(":");
  if (separator < 1 || separator === credentials.length - 1) {
    throw new Error("invalid-shadowsocks-credentials");
  }
  return profile(
    {
      protocol: "shadowsocks",
      settings: {
        servers: [
          {
            address: url.hostname,
            method: credentials.slice(0, separator),
            password: credentials.slice(separator + 1),
            port: Number(url.port),
          },
        ],
      },
    },
    decodeURIComponent(url.hash.slice(1)) || "Shadowsocks",
  );
}

function vlessOrTrojan(uri: string): JsonObject {
  const url = new URL(uri);
  const protocol = url.protocol.slice(0, -1);
  const user = decodeURIComponent(url.username);
  if (
    user === "" ||
    url.password !== "" ||
    !["", "/"].includes(url.pathname) ||
    !hasValidProxyCredentials(protocol, user, url.searchParams)
  ) {
    throw new Error("invalid-proxy-link");
  }
  const address = url.hostname.replaceAll(/^\[|\]$/gu, "");
  const port = Number(url.port);
  const parameters = url.searchParams;
  const settings =
    protocol === "vless"
      ? {
          vnext: [
            {
              address,
              port,
              users: [
                {
                  encryption: parameters.get("encryption") ?? "none",
                  flow: parameters.get("flow") ?? "",
                  id: user,
                },
              ],
            },
          ],
        }
      : { servers: [{ address, password: user, port }] };
  const stream = linkTransport(parameters, protocol === "trojan" ? "tls" : "none");
  const mask = linkMask(parameters.get("fm"), string(stream.network) ?? "");
  return profile(
    {
      protocol,
      settings,
      streamSettings: {
        ...stream,
        ...(mask.finalmask !== undefined && { finalmask: mask.finalmask }),
        ...(mask.dialer !== undefined && { sockopt: { dialerProxy: mask.dialer.tag ?? "" } }),
      },
    },
    decodeURIComponent(url.hash.slice(1)) || protocol.toUpperCase(),
    mask.dialer,
  );
}

const VMESS = z.strictObject({
  add: z.string().min(1),
  aid: z.union([z.string(), z.number()]).optional(),
  alpn: z.string().optional(),
  fp: z.string().optional(),
  host: z.string().optional(),
  id: z.string().regex(UUID),
  net: z.string().default("raw"),
  path: z.string().optional(),
  port: z.union([z.string(), z.number()]),
  ps: z.string().default("VMess"),
  scy: z.string().default("auto"),
  sni: z.string().optional(),
  tls: z.string().optional(),
  type: z.string().optional(),
  v: z.union([z.literal("2"), z.literal(2)]),
});

function hasValidProxyCredentials(
  protocol: string,
  user: string,
  parameters: URLSearchParams,
): boolean {
  return protocol === "vless"
    ? UUID.test(user)
    : ["encryption", "flow"].every((name) => !parameters.has(name));
}

function vmess(uri: string): JsonObject {
  const decoded = decode64(uri.slice("vmess://".length));
  const raw = VMESS.parse(parseJson(decoded));
  const params = new URLSearchParams();
  const isGrpc = raw.net === "grpc";
  const entries = {
    alpn: raw.alpn,
    fp: raw.fp,
    host: isGrpc ? undefined : raw.host,
    path: isGrpc ? undefined : raw.path,
    security: raw.tls,
    serviceName: isGrpc ? raw.path : undefined,
    sni: raw.sni,
    type: raw.net,
  };
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== "") {
      params.set(key, value);
    }
  }
  if (raw.type !== undefined && raw.type !== "" && raw.type !== "none") {
    params.set("headerType", raw.type);
  }
  const server = {
    address: raw.add,
    port: Number(raw.port),
    users: [
      {
        alterId: Number(raw.aid ?? 0),
        id: raw.id,
        security: raw.scy,
      },
    ],
  };
  return profile(
    {
      protocol: "vmess",
      settings: { vnext: [server] },
      streamSettings: linkTransport(params, "none"),
    },
    raw.ps,
  );
}
