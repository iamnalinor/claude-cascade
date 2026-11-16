import { z } from "zod";

export type JsonObject = Record<string, JsonValue>;
export type JsonValue = z.infer<ReturnType<typeof z.json>>;

export function canonical(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const record = object(value);
  if (record === undefined) {
    return JSON.stringify(value);
  }
  const pairs = Object.entries(record)
    .toSorted(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`);
  return `{${pairs.join(",")}}`;
}

export function object(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function objects(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new TypeError("expected-array");
  }
  return value.map((item) => {
    const result = object(item);
    if (result === undefined) {
      throw new Error("expected-object");
    }
    return result;
  });
}

export function parseJson(text: string): JsonValue {
  return z.json().parse(JSON.parse(text));
}

export function string(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
