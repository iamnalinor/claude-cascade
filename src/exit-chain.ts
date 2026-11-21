import { type JsonObject, object, string } from "./json-value.ts";

type ExitOptions = { tag: string; via?: JsonObject };

export function exitOutbounds(
  bridge: JsonObject,
  main: string,
  options: ExitOptions,
): JsonObject[] {
  if (options.via === undefined) {
    return [makeExit(bridge, main, options.tag)];
  }
  const viaTag = `via-${options.tag}`;
  return [makeExit(options.via, main, viaTag), makeExit(bridge, viaTag, options.tag)];
}

function makeExit(bridge: JsonObject, main: string, tag: string): JsonObject {
  const stream = object(bridge.streamSettings);
  const protocol = string(bridge.protocol);
  if (protocol === undefined) {
    throw new Error("missing-exit-protocol");
  }
  return {
    protocol,
    settings: bridge.settings ?? {},
    streamSettings: { ...stream, sockopt: { ...object(stream?.sockopt), dialerProxy: main } },
    tag,
  };
}
