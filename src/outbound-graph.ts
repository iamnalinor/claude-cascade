import { validateTransportSecurity } from "./endpoints.ts";
import { type JsonObject, object, string } from "./json-value.ts";

const MAX_OUTBOUNDS = 128;
const OUTBOUND_FIELDS = new Set([
  "mux",
  "protocol",
  "proxySettings",
  "sendThrough",
  "settings",
  "streamSettings",
  "tag",
  "targetStrategy",
]);
export function assertExactKey(record: JsonObject | undefined, field: string): void {
  const normalized = field.toUpperCase();
  if (
    record !== undefined &&
    Object.keys(record).some((key) => key !== field && key.toUpperCase() === normalized)
  ) {
    throw new Error("noncanonical-field");
  }
}

export function indexOutbounds(outbounds: JsonObject[]): Map<string, string[]> {
  if (outbounds.length > MAX_OUTBOUNDS) {
    throw new Error("too-many-outbounds");
  }
  const graph = new Map<string, string[]>();
  for (const outbound of outbounds) {
    if (Object.keys(outbound).some((key) => !OUTBOUND_FIELDS.has(key))) {
      throw new Error("unsupported-outbound-fields");
    }
    validateTransportSecurity(outbound);
    const targets = linkTargets(outbound);
    const tag = string(outbound.tag);
    if (tag === undefined) {
      if (targets.length > 0) {
        throw new Error("untagged-dialer");
      }
      continue;
    }
    if (graph.has(tag)) {
      throw new Error("conflicting-outbound-tag");
    }
    graph.set(tag, targets);
  }
  return graph;
}

export function linkTargets(outbound: JsonObject): string[] {
  const stream = object(outbound.streamSettings);
  const proxy = object(outbound.proxySettings);
  const socket = object(stream?.sockopt);
  assertExactKey(stream, "sockopt");
  assertExactKey(proxy, "tag");
  assertExactKey(socket, "dialerProxy");
  const tags = [string(proxy?.tag), string(socket?.dialerProxy)];
  return tags.filter((tag) => tag !== undefined);
}

export function validateChains(
  graph: ReadonlyMap<string, string[]>,
  outbounds: JsonObject[],
): void {
  const loopbacks = new Set(
    outbounds
      .filter((outbound) => outbound.protocol === "loopback")
      .map((outbound) => string(outbound.tag)),
  );
  const active = new Set<string>();
  const checked = new Set<string>();
  function visit(tag: string): void {
    if (checked.has(tag)) {
      return;
    }
    const next = graph.get(tag);
    if (next === undefined || active.has(tag)) {
      throw new Error("broken-outbound-chain");
    }
    active.add(tag);
    for (const target of next) {
      if (loopbacks.has(target)) {
        throw new Error("loopback-dialer");
      }
      visit(target);
    }
    active.delete(tag);
    checked.add(tag);
  }
  for (const tag of graph.keys()) {
    visit(tag);
  }
}
