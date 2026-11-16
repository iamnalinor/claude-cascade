import { type JsonObject, object, objects, string } from "./json-value.ts";

const LEGACY_DOMAIN_LIMITS = { edns0: 1232, labelLimit: 63, lenLimit: 255 };
const DNS_METHODS = new Map([
  [1, "a"],
  [16, "txt"],
  [28, "aaaa"],
]);

export function adaptXdns(outbound: JsonObject, isLegacySchema: boolean): JsonObject {
  const stream = object(outbound.streamSettings);
  const mask = object(stream?.finalmask);
  if (mask?.udp === undefined) {
    return outbound;
  }
  const udp = objects(mask.udp).map((entry) => {
    if (entry.type !== "xdns") {
      return entry;
    }
    const settings = object(entry.settings) ?? {};
    return {
      ...entry,
      settings: isLegacySchema ? legacySettings(settings) : currentSettings(settings),
    };
  });
  return { ...outbound, streamSettings: { ...stream, finalmask: { ...mask, udp } } };
}

function currentSettings(settings: JsonObject): JsonObject {
  const domains = objects(settings.domains ?? []).map((entry) => {
    const { name, ...options } = entry;
    return typeof name === "string" && entry.names === undefined
      ? { ...options, names: [name] }
      : entry;
  });
  const resolvers = objects(settings.resolvers ?? []).map((entry) => {
    if (entry.addrs !== undefined) {
      return entry;
    }
    const protocol = string(entry.type);
    const address = string(object(entry.settings)?.addr);
    if ((protocol !== "udp" && protocol !== "tcp") || address === undefined) {
      throw new Error("unsupported-xdns-resolver");
    }
    return { addrs: [`${protocol}://${address}`] };
  });
  return { ...settings, domains, resolvers };
}

function legacyAddresses(resolver: JsonObject): string[] {
  if (!Array.isArray(resolver.addrs) || Object.keys(resolver).some((name) => name !== "addrs")) {
    throw new Error("unsupported-legacy-xdns-resolver");
  }
  return resolver.addrs.map((address) => {
    const url = typeof address === "string" ? URL.parse(address) : null;
    if (
      url?.protocol !== "udp:" ||
      url.hostname === "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !["", "/"].includes(url.pathname)
    ) {
      throw new Error("invalid-legacy-xdns-resolver");
    }
    return `udp://${url.hostname}:${url.port || "53"}`;
  });
}

function legacyNames(domain: JsonObject): string[] {
  const { names, types } = domain;
  const type = Array.isArray(types) && types.length === 1 ? types[0] : undefined;
  const method = typeof type === "number" ? DNS_METHODS.get(type) : undefined;
  if (
    method === undefined ||
    !Array.isArray(names) ||
    Object.entries(LEGACY_DOMAIN_LIMITS).some(([key, value]) => domain[key] !== value)
  ) {
    throw new Error("unsupported-legacy-xdns-domain");
  }
  return names.map((name) => {
    if (typeof name !== "string" || name === "" || name.includes(":") || name.includes("+")) {
      throw new Error("invalid-xdns-name");
    }
    return `${name}:${method}`;
  });
}

function legacySettings(settings: JsonObject): JsonObject {
  const domainsInput = settings.domains ?? [];
  const resolversInput = settings.resolvers ?? [];
  if (
    Array.isArray(domainsInput) &&
    Array.isArray(resolversInput) &&
    domainsInput.every((entry) => typeof entry === "string") &&
    resolversInput.every((entry) => typeof entry === "string")
  ) {
    return settings;
  }
  if (settings.extraPoll !== undefined && settings.extraPoll !== 0) {
    throw new Error("unsupported-legacy-xdns");
  }
  const current = currentSettings(settings);
  const domains = objects(current.domains).flatMap(legacyNames);
  const resolvers = objects(current.resolvers).flatMap(legacyAddresses);
  if (domains.length === 0 || resolvers.length === 0) {
    throw new Error("empty-legacy-xdns");
  }
  return {
    domains,
    resolvers: domains.flatMap((name) => resolvers.map((address) => `${name}+${address}`)),
  };
}
