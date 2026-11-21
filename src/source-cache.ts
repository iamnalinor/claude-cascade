import { canonical, type JsonObject, type JsonValue } from "./json-value.ts";
import { type Source } from "./source-config.ts";

const encoder = new TextEncoder();
const TTL_SECONDS = 900;

export type SourceCache = Pick<Cache, "match" | "put">;
export type TaskContext = { waitUntil(promise: Promise<unknown>): void };

type KeyInputs = {
  bridge: JsonObject;
  via?: JsonObject;
  config: Source;
  incoming: Request;
  key: string;
  upstream: Request;
};

export async function cacheKey(inputs: KeyInputs): Promise<Request | undefined> {
  if (!inputs.config.cache || !inputs.upstream.headers.has("x-hwid")) {
    return undefined;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(inputs.key),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const payload: JsonValue = [
    "subscription-v12",
    inputs.incoming.headers.get("user-agent"),
    JSON.stringify(inputs.config),
    inputs.upstream.url,
    [...inputs.upstream.headers],
    inputs.bridge,
    inputs.via ?? null,
  ];
  const hash = await crypto.subtle.sign("HMAC", key, encoder.encode(canonical(payload)));
  const url = new URL(`/.internal/sub-cache/${new Uint8Array(hash).toHex()}`, inputs.incoming.url);
  return new Request(url);
}

export function saveCache(
  storage: SourceCache,
  entry: { key: Request; payload: JsonValue },
  context?: TaskContext,
): void {
  const response = Response.json(entry.payload, {
    headers: { "cache-control": `max-age=${TTL_SECONDS}` },
  });
  const task = put(storage, entry.key, response);
  context?.waitUntil(task);
}

async function put(storage: SourceCache, key: Request, response: Response): Promise<void> {
  try {
    await storage.put(key, response);
  } catch {
    // Cache writes are optional even on zones where the API is unavailable.
  }
}
