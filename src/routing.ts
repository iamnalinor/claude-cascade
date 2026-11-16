import { endpoints, isKnown, isProxy } from "./endpoints.ts";
import { type JsonObject, object, objects, string } from "./json-value.ts";
import { assertExactKey, indexOutbounds, validateChains } from "./outbound-graph.ts";
import { adaptXdns } from "./xdns-compat.ts";

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
const LOCAL_INBOUNDS = new Set(["dokodemo-door", "http", "mixed", "socks", "tunnel"]);
const LOOPBACK_LISTEN = new Set(["127.0.0.1", "::1", "localhost"]);
const PROFILE_FIELDS = new Set([
  "burstObservatory",
  "dns",
  "fakeDns",
  "fakedns",
  "inbounds",
  "log",
  "meta",
  "observatory",
  "outbounds",
  "policy",
  "remarks",
  "routing",
  "stats",
]);
type CascadeOptions = { legacyXdns?: boolean; mainTag?: string };

export function automaticInbounds(): JsonObject[] {
  return defaultInbounds().map(localInbound);
}

export function cascade(
  profile: JsonObject,
  bridge: JsonObject,
  options: CascadeOptions = {},
): JsonObject {
  if (Object.keys(profile).some((key) => !PROFILE_FIELDS.has(key))) {
    throw new Error("unsupported-profile-fields");
  }
  const original = objects(profile.outbounds);
  const main = selectMain(original, options.mainTag);
  const graph = indexOutbounds(original);
  const routing = object(profile.routing) ?? {};
  for (const field of ["balancers", "domainStrategy", "rules", "script"]) {
    assertExactKey(routing, field);
  }
  const [exitTag, ruTag, defaultMainTag] = cascadeTags(profile, routing, graph);
  const mainTag = string(main.tag) ?? defaultMainTag;
  const mainEndpoints = endpoints(main);
  const exitEndpoints = endpoints(bridge);
  if (
    exitEndpoints.some(([host, port]) =>
      mainEndpoints.some(([mainHost, mainPort]) => host === mainHost && port === mainPort),
    )
  ) {
    throw new Error("same-first-and-second-hop");
  }
  const rules = validateRules(routing, graph, main);
  validateChains(graph, original);
  const inbounds = objects(profile.inbounds ?? defaultInbounds());
  const outbounds = original.map((outbound) =>
    outbound === main ? { ...main, tag: mainTag } : outbound,
  );
  outbounds.push(makeExit(bridge, mainTag, exitTag), {
    protocol: "freedom",
    tag: ruTag,
  });
  const { log: _log, ...profileSettings } = profile;
  return {
    ...profileSettings,
    inbounds: (inbounds.length === 0 ? defaultInbounds() : inbounds).map(localInbound),
    outbounds: outbounds.map((outbound) => adaptXdns(outbound, options.legacyXdns === true)),
    routing: {
      ...routing,
      domainStrategy: "IPOnDemand",
      rules: [
        { domain: TARGETS, outboundTag: exitTag, type: "field" },
        { domain: ["full:ip.net.coffee"], outboundTag: exitTag, type: "field" },
        ...russianRules(ruTag),
        ...rules,
      ],
    },
  };
}

export function makeExit(bridge: JsonObject, main: string, tag: string): JsonObject {
  const stream = object(bridge.streamSettings);
  return {
    protocol: "vless",
    settings: bridge.settings ?? {},
    streamSettings: { ...stream, sockopt: { ...object(stream?.sockopt), dialerProxy: main } },
    tag,
  };
}

export function russianRules(tag: string): JsonObject[] {
  return [
    { domain: RU_DOMAINS, outboundTag: tag, type: "field" },
    { ip: ["geoip:ru"], outboundTag: tag, type: "field" },
  ];
}

function cascadeTags(
  profile: JsonObject,
  routing: JsonObject,
  graph: ReadonlyMap<string, string[]>,
): [string, string, string] {
  const monitors = [object(profile.observatory), object(profile.burstObservatory)];
  const selectors = [
    ...objects(routing.balancers ?? []).map((balancer) => fieldValue(balancer, "selector")),
    ...monitors.map((monitor) => fieldValue(monitor, "subjectSelector")),
  ]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter((value) => typeof value === "string");
  for (const prefix of ["cascade-", "happ-cascade-", "_cascade-"]) {
    const tags: [string, string, string] = [
      `${prefix}exit2`,
      `${prefix}ru-direct`,
      `${prefix}main`,
    ];
    if (
      tags.every(
        (tag) => !graph.has(tag) && selectors.every((selector) => !tag.startsWith(selector)),
      )
    ) {
      return tags;
    }
  }
  throw new Error("conflicting-cascade-tags");
}

function defaultInbounds(): JsonObject[] {
  return [
    { listen: "127.0.0.1", port: 10_808, protocol: "socks", settings: { udp: true }, tag: "socks" },
    { listen: "127.0.0.1", port: 10_809, protocol: "http", tag: "http" },
  ];
}

function fieldValue(record: JsonObject | undefined, field: string): JsonObject[string] | undefined {
  assertExactKey(record, field);
  return record?.[field];
}

function localInbound(inbound: JsonObject): JsonObject {
  const { listen = "127.0.0.1", port, protocol, settings, tag } = inbound;
  if (
    !LOCAL_INBOUNDS.has(string(protocol) ?? "") ||
    !LOOPBACK_LISTEN.has(string(listen) ?? "") ||
    inbound.streamSettings != null
  ) {
    throw new Error("unsupported-inbound");
  }
  return {
    listen,
    ...(port !== undefined && { port }),
    ...(protocol !== undefined && { protocol }),
    ...(settings !== undefined && { settings }),
    ...(tag !== undefined && { tag }),
    sniffing: routingSniffing(object(inbound.sniffing) ?? {}),
  };
}

function routingSniffing(sniffing: JsonObject): JsonObject {
  for (const field of ["destOverride", "enabled", "routeOnly"]) {
    assertExactKey(sniffing, field);
  }
  const existing = Array.isArray(sniffing.destOverride) ? sniffing.destOverride : [];
  return {
    ...sniffing,
    destOverride: [...new Set([...existing, ...SNIFF_FOR_ROUTING])],
    enabled: true,
    routeOnly: sniffing.enabled === true ? (sniffing.routeOnly ?? false) : true,
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
    .filter((candidate) => selectors.some((selector) => candidate.startsWith(selector)))
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
