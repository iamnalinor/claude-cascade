import { endpoints, isProxy } from "./endpoints.ts";
import { canonical, type JsonObject, object, objects, string } from "./json-value.ts";
import { linkTargets } from "./outbound-graph.ts";
import { automaticInbounds, makeExit, russianRules, targetRules } from "./routing.ts";

const EXIT_PREFIX = "auto-exit-";
const BALANCER_TAG = "auto-cascade";
const BLOCK_TAG = "auto-block";
const RU_TAG = "cascade-ru-direct";

export function autoCascade(
  profiles: JsonObject[],
  bridge: JsonObject,
  canUseLegacyProxy = false,
): JsonObject | undefined {
  const outbounds: JsonObject[] = [{ protocol: "blackhole", tag: BLOCK_TAG }];
  const seen = new Set<string>();
  const exitEndpoints = new Set(endpoints(bridge).map((endpoint) => JSON.stringify(endpoint)));
  for (const profile of profiles) {
    for (const chain of firstHops(profile, exitEndpoints, canUseLegacyProxy)) {
      const key = canonical(chain);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const index = seen.size;
      const tags = new Map(
        chain.map((_outbound, offset) => [`leg-${offset}`, `auto-hop-${index}-${offset}`]),
      );
      outbounds.push(
        ...chain.map((outbound, offset) => remap(outbound, tags, `auto-hop-${index}-${offset}`)),
        makeExit(bridge, `auto-hop-${index}-0`, `${EXIT_PREFIX}${index}`),
      );
    }
  }
  if (seen.size === 0) {
    return undefined;
  }
  outbounds.push({ protocol: "freedom", tag: RU_TAG });
  return {
    burstObservatory: {
      pingConfig: {
        connectivity: "",
        destination: "https://www.gstatic.com/generate_204",
        interval: "1m",
        sampling: 1,
        timeout: "5s",
      },
      subjectSelector: [EXIT_PREFIX],
    },
    inbounds: automaticInbounds(),
    outbounds,
    remarks: "Все → EXIT2",
    routing: {
      balancers: [
        {
          fallbackTag: BLOCK_TAG,
          selector: [EXIT_PREFIX],
          strategy: { type: "leastPing" },
          tag: BALANCER_TAG,
        },
      ],
      domainStrategy: "IPOnDemand",
      rules: [
        ...targetRules({ balancerTag: BALANCER_TAG }),
        ...russianRules(RU_TAG),
        { balancerTag: BALANCER_TAG, network: "tcp,udp", type: "field" },
      ],
    },
  };
}

function collect(
  root: JsonObject,
  byTag: ReadonlyMap<string | undefined, JsonObject>,
): JsonObject[] {
  const chain = new Set<JsonObject>();
  function visit(outbound: JsonObject): void {
    if (chain.has(outbound)) {
      return;
    }
    chain.add(outbound);
    for (const target of linkTargets(outbound)) {
      const dependency = byTag.get(target);
      if (dependency === undefined) {
        throw new Error("missing-pool-dependency");
      }
      visit(dependency);
    }
  }
  visit(root);
  const legs = [...chain];
  const tags = new Map<string, string>();
  for (const [index, leg] of legs.entries()) {
    const tag = string(leg.tag);
    if (tag !== undefined) {
      tags.set(tag, `leg-${index}`);
    }
  }
  return legs.map((leg, index) => remap(leg, tags, `leg-${index}`));
}

function firstHops(
  profile: JsonObject,
  exitEndpoints: ReadonlySet<string>,
  canUseLegacyProxy: boolean,
): JsonObject[][] {
  // The final two outbounds of each compiled profile are the injected EXIT2 and Russian direct.
  const original = objects(profile.outbounds).slice(0, -2);
  const byTag = new Map(original.map((outbound) => [string(outbound.tag), outbound]));
  const chains: JsonObject[][] = [];
  for (const outbound of original) {
    if (!isProxy(outbound)) {
      continue;
    }
    try {
      const chain = collect(outbound, byTag);
      if (!canUseLegacyProxy && chain.some((leg) => leg.proxySettings !== undefined)) {
        continue;
      }
      const proxyEndpoints = chain.filter(isProxy).flatMap(endpoints);
      if (proxyEndpoints.some((endpoint) => exitEndpoints.has(JSON.stringify(endpoint)))) {
        continue;
      }
      chains.push(chain);
    } catch {
      // A secondary provider outbound may be unusable as an independent first hop.
    }
  }
  return chains;
}

function remap(outbound: JsonObject, tags: ReadonlyMap<string, string>, tag: string): JsonObject {
  const proxy = object(outbound.proxySettings);
  const stream = object(outbound.streamSettings);
  const socket = object(stream?.sockopt);
  const proxyTag = tags.get(string(proxy?.tag) ?? "");
  const dialerTag = tags.get(string(socket?.dialerProxy) ?? "");
  return {
    ...outbound,
    ...(proxyTag !== undefined && { proxySettings: { ...proxy, tag: proxyTag } }),
    ...(dialerTag !== undefined && {
      streamSettings: { ...stream, sockopt: { ...socket, dialerProxy: dialerTag } },
    }),
    tag,
  };
}
