import { endpoints, isKnown, isProxy } from "./endpoints.ts";
import { type JsonObject, object, objects, string } from "./json-value.ts";
import { adaptXdns } from "./xdns-compat.ts";

const EXIT_TAG = "cascade-exit2";
const RU_TAG = "cascade-ru-direct";
const TARGETS = [
  "domain:anthropic.com",
  "domain:claude.ai",
  "domain:claude.com",
  "domain:claude.app",
  "domain:claudeusercontent.com",
  "domain:claudemcpcontent.com",
  "domain:withpersona.com",
];
const RU_DOMAINS = ["geosite:category-ru", "domain:ru", "domain:su", "domain:xn--p1ai"];
const SNIFF_FOR_ROUTING = ["http", "tls", "quic"];

type CascadeOptions = { legacyXdns?: boolean; mainTag?: string };

export function cascade(
  profile: JsonObject,
  bridge: JsonObject,
  options: CascadeOptions = {},
): JsonObject {
  const original = objects(profile.outbounds);
  const main = selectMain(original, options.mainTag);
  const graph = indexOutbounds(original);
  const tagged = withMainTag(main, graph);
  const mainEndpoints = endpoints(main);
  const exitEndpoints = endpoints(bridge);
  if (
    exitEndpoints.some(([host, port]) =>
      mainEndpoints.some(([mainHost, mainPort]) => host === mainHost && port === mainPort),
    )
  ) {
    throw new Error("same-first-and-second-hop");
  }
  const routing = object(profile.routing) ?? {};
  const rules = validateRules(routing, graph, main);
  for (const tag of graph.keys()) {
    visit(tag, graph, new Set());
  }
  const inbounds = objects(profile.inbounds ?? defaultInbounds());
  const entry = mainEndpoints[0];
  const outbounds = original.map((outbound) => (outbound === main ? tagged : outbound));
  outbounds.push(makeExit(bridge, string(tagged.tag) ?? "cascade-main"), {
    protocol: "freedom",
    tag: RU_TAG,
  });
  return {
    ...profile,
    ...(entry !== undefined && { remarks: labelProfile(profile, main, entry) }),
    inbounds: (inbounds.length === 0 ? defaultInbounds() : inbounds).map(enableSniffing),
    outbounds: outbounds.map((outbound) => adaptXdns(outbound, options.legacyXdns === true)),
    routing: {
      ...routing,
      domainStrategy: "IPOnDemand",
      rules: [
        { domain: TARGETS, outboundTag: EXIT_TAG, type: "field" },
        { domain: ["full:ip.net.coffee"], outboundTag: EXIT_TAG, type: "field" },
        { domain: RU_DOMAINS, outboundTag: RU_TAG, type: "field" },
        { ip: ["geoip:ru"], outboundTag: RU_TAG, type: "field" },
        ...rules,
      ],
    },
  };
}

export function validateBridge(bridge: JsonObject): JsonObject {
  const stream = object(bridge.streamSettings);
  if (
    bridge.protocol !== "vless" ||
    !["reality", "tls"].includes(string(stream?.security) ?? "") ||
    linkTargets(bridge).length > 0
  ) {
    throw new Error("invalid-bridge");
  }
  endpoints(bridge);
  return bridge;
}

function defaultInbounds(): JsonObject[] {
  return [
    { listen: "127.0.0.1", port: 10_808, protocol: "socks", settings: { udp: true }, tag: "socks" },
    { listen: "127.0.0.1", port: 10_809, protocol: "http", tag: "http" },
  ];
}

function enableSniffing(inbound: JsonObject): JsonObject {
  if (
    !["dokodemo-door", "http", "mixed", "socks", "tun"].includes(string(inbound.protocol) ?? "")
  ) {
    return inbound;
  }
  const sniffing = object(inbound.sniffing) ?? {};
  const existing = Array.isArray(sniffing.destOverride) ? sniffing.destOverride : [];
  return {
    ...inbound,
    sniffing: {
      ...sniffing,
      destOverride: [...new Set([...existing, ...SNIFF_FOR_ROUTING])],
      enabled: true,
      routeOnly: sniffing.enabled === true ? (sniffing.routeOnly ?? false) : true,
    },
  };
}

function indexOutbounds(outbounds: JsonObject[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const outbound of outbounds) {
    const tag = string(outbound.tag);
    if (tag === undefined) {
      continue;
    }
    if (graph.has(tag) || tag === EXIT_TAG || tag === RU_TAG) {
      throw new Error("conflicting-outbound-tag");
    }
    graph.set(tag, linkTargets(outbound));
  }
  return graph;
}

function labelProfile(
  profile: JsonObject,
  main: JsonObject,
  entry: readonly [string, number],
): string {
  const [address, port] = entry;
  const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  const protocol = (string(main.protocol) ?? "proxy").toUpperCase();
  const label = `${protocol} ${host}:${port}`;
  const title = string(profile.remarks);
  return title === undefined ? label : `${title} · ${label}`;
}

function linkTargets(outbound: JsonObject): string[] {
  const stream = object(outbound.streamSettings);
  const tags = [
    string(object(outbound.proxySettings)?.tag),
    string(object(stream?.sockopt)?.dialerProxy),
    outbound.protocol === "loopback" ? string(object(outbound.settings)?.outboundTag) : undefined,
  ];
  return tags.filter((tag) => tag !== undefined);
}

function makeExit(bridge: JsonObject, main: string): JsonObject {
  const stream = object(bridge.streamSettings);
  return {
    protocol: "vless",
    settings: bridge.settings ?? {},
    streamSettings: { ...stream, sockopt: { ...object(stream?.sockopt), dialerProxy: main } },
    tag: EXIT_TAG,
  };
}

function selectMain(outbounds: JsonObject[], preferred?: string): JsonObject {
  if (!outbounds.every(isKnown)) {
    throw new Error("unsupported-outbound");
  }
  const candidates = outbounds.filter(
    (outbound) => isProxy(outbound) && (preferred === undefined || outbound.tag === preferred),
  );
  const [main] = candidates;
  if (
    main === undefined ||
    (candidates.length !== 1 && (preferred !== undefined || main !== outbounds[0]))
  ) {
    throw new Error("ambiguous-main");
  }
  return main;
}

function singleProxyBalancer(
  balancers: JsonObject[],
  main: JsonObject,
  graph: ReadonlyMap<string, string[]>,
): string | undefined {
  const [balancer] = balancers;
  const tag = string(main.tag);
  if (
    balancers.length !== 1 ||
    balancer === undefined ||
    tag === undefined ||
    !Array.isArray(balancer.selector)
  ) {
    return undefined;
  }
  const selectors = balancer.selector.filter((value) => typeof value === "string");
  const matches = graph
    .keys()
    .filter((candidate) =>
      selectors.some((selector) => selector !== "" && candidate.startsWith(selector)),
    )
    .toArray();
  return matches.length === 1 && matches[0] === tag ? string(balancer.tag) : undefined;
}

function validateRules(
  routing: JsonObject,
  graph: ReadonlyMap<string, string[]>,
  main: JsonObject,
): JsonObject[] {
  if (string(routing.script) !== undefined) {
    throw new Error("unsupported-routing-script");
  }
  const balancers = objects(routing.balancers ?? []);
  const tags = new Set(balancers.map((balancer) => string(balancer.tag)).filter(Boolean));
  for (const balancer of balancers) {
    const fallback = string(balancer.fallbackTag);
    if (fallback !== undefined && !graph.has(fallback)) {
      throw new Error("missing-balancer-fallback");
    }
  }
  const alias = singleProxyBalancer(balancers, main, graph);
  return objects(routing.rules ?? []).map((rule) => {
    const tag = string(rule.outboundTag);
    if (tag !== undefined && graph.has(tag)) {
      return rule;
    }
    if (tag === undefined && tags.has(string(rule.balancerTag))) {
      return rule;
    }
    const balancerTag = tags.has(tag)
      ? tag
      : tag?.startsWith("balancer_") === true
        ? alias
        : undefined;
    if (balancerTag === undefined) {
      throw new Error("missing-route-target");
    }
    const { outboundTag: _outboundTag, ...rest } = rule;
    return { ...rest, balancerTag };
  });
}

function visit(tag: string, graph: ReadonlyMap<string, string[]>, path: ReadonlySet<string>): void {
  const next = graph.get(tag);
  if (next === undefined || path.has(tag)) {
    throw new Error("broken-outbound-chain");
  }
  const branch = new Set([...path, tag]);
  for (const target of next) {
    visit(target, graph, branch);
  }
}

function withMainTag(main: JsonObject, graph: ReadonlyMap<string, string[]>): JsonObject {
  if (string(main.tag) !== undefined) {
    return main;
  }
  let tag = "cascade-main";
  while (graph.has(tag)) {
    tag += "-main";
  }
  return { ...main, tag };
}
