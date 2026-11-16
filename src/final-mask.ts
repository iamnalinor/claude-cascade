import { type JsonObject, object, parseJson } from "./json-value.ts";

type LinkMask = { dialer?: JsonObject; finalmask?: JsonObject };

export function linkMask(raw: null | string, network: string): LinkMask {
  if (raw === null || raw === "") {
    return {};
  }
  const value = object(parseJson(raw));
  if (value === undefined) {
    throw new Error("invalid-final-mask");
  }
  if (Object.keys(value).every((key) => ["quicParams", "tcp", "udp"].includes(key))) {
    return { finalmask: value };
  }
  if (network === "kcp" && value.type === "xdns" && object(value.settings) !== undefined) {
    return { finalmask: { udp: [value] } };
  }
  const settings = object(value.settings);
  if (value.protocol === "freedom" && object(settings?.fragment) !== undefined) {
    return { dialer: { ...value, tag: "main-transport-mask" } };
  }
  throw new Error("unsupported-final-mask");
}
