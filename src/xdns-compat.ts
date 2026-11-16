import { type JsonObject, object, objects, string } from "./json-value.ts";

const LEGACY_DOMAIN_LIMITS = { edns0: 1232, labelLimit: 63, lenLimit: 255 };
const MAX_LEGACY_ROUTES = 64;
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
  const legacy = legacyLists(settings);
  if (legacy !== undefined) {
    return fromLegacy(legacy);
  }
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

function fromLegacy(resolvers: string[]): JsonObject {
  const domains = new Map<string, JsonObject>();
  const addresses = new Set<string>();
  const pairs = new Set<string>();
  for (const resolver of resolvers) {
    const delimiter = resolver.indexOf("+");
    const domain = resolver.slice(0, delimiter).toLowerCase();
    const [name, method = "", extra] = domain.split(":", 3);
    const type = DNS_METHODS.entries().find(([, alias]) => alias === (method || "txt"))?.[0];
    if (
      delimiter < 1 ||
      name === undefined ||
      !isValidName(name) ||
      extra !== undefined ||
      type === undefined
    ) {
      throw new Error("invalid-legacy-xdns-route");
    }
    const address = udpAddress(resolver.slice(delimiter + 1));
    const nameAndType = `${name}:${type}`;
    domains.set(nameAndType, { ...LEGACY_DOMAIN_LIMITS, names: [name], types: [type] });
    addresses.add(address);
    pairs.add(`${nameAndType}+${address}`);
  }
  // The current schema chooses the domain and resolver independently.
  if (pairs.size !== resolvers.length || pairs.size !== domains.size * addresses.size) {
    throw new Error("incompatible-xdns-resolver-pairing");
  }
  return { domains: domains.values().toArray(), resolvers: [{ addrs: [...addresses] }] };
}

function isValidName(name: string): boolean {
  return /^[^\s:+]{1,253}$/u.test(name);
}

function legacyAddresses(resolver: JsonObject): string[] {
  if (!Array.isArray(resolver.addrs) || Object.keys(resolver).some((name) => name !== "addrs")) {
    throw new Error("unsupported-legacy-xdns-resolver");
  }
  return resolver.addrs.map(udpAddress);
}

function legacyLists(settings: JsonObject): string[] | undefined {
  const domains = settings.domains ?? [];
  const resolvers = settings.resolvers ?? [];
  if (
    Array.isArray(domains) &&
    domains.every((entry) => typeof entry === "string") &&
    Array.isArray(resolvers) &&
    resolvers.every((entry) => typeof entry === "string")
  ) {
    if (resolvers.length === 0 || resolvers.length > MAX_LEGACY_ROUTES) {
      throw new Error("invalid-legacy-xdns-resolvers");
    }
    return resolvers;
  }
  return undefined;
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
    if (typeof name !== "string" || !isValidName(name)) {
      throw new Error("invalid-xdns-name");
    }
    return `${name}:${method}`;
  });
}

function legacySettings(settings: JsonObject): JsonObject {
  if (legacyLists(settings) !== undefined) {
    return settings;
  }
  if (settings.extraPoll !== undefined && settings.extraPoll !== 0) {
    throw new Error("unsupported-legacy-xdns");
  }
  const current = currentSettings(settings);
  const domains = objects(current.domains).flatMap(legacyNames);
  const resolvers = objects(current.resolvers).flatMap(legacyAddresses);
  if (
    domains.length === 0 ||
    resolvers.length === 0 ||
    domains.length * resolvers.length > MAX_LEGACY_ROUTES
  ) {
    throw new Error("invalid-legacy-xdns-size");
  }
  return {
    domains,
    resolvers: domains.flatMap((name) => resolvers.map((address) => `${name}+${address}`)),
  };
}

function udpAddress(address: unknown): string {
  const url = typeof address === "string" && address.length < 128 ? URL.parse(address) : null;
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
}
