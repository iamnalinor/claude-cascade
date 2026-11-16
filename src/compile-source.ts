import { canonical, type JsonObject, object, parseJson } from "./json-value.ts";
import { cascade } from "./routing.ts";
import { cacheKey, saveCache, type SourceCache, type TaskContext } from "./source-cache.ts";
import { type Bindings, type Source } from "./source-config.ts";
import {
  type Fetcher,
  fetchSource,
  IncompatibleSource,
  readSource,
  sourceRequest,
} from "./source-request.ts";
import { parseSubscription } from "./subscription-format.ts";

const PROVIDER_BINDINGS = new Set(["install-id", "installid", "provider-id", "providerid"]);
const RESPONSE_CONTROLS = [...PROVIDER_BINDINGS, "subscription-always-hwid-enable", "routing"];
const MAX_COMPILED_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

export type Compiled = { profiles: JsonObject[]; rejected: number };
type Dependencies = {
  cache?: SourceCache;
  context?: TaskContext;
  fetcher: Fetcher;
};
type RequestContext = { bridge: JsonObject; env: Bindings; request: Request; token: string };

export async function compileSource(
  source: Source,
  context: RequestContext,
  dependencies: Dependencies,
): Promise<Compiled> {
  const upstream = sourceRequest(context.env, source, context.request);
  const storage = dependencies.cache;
  const key =
    storage === undefined
      ? undefined
      : await cacheKey({
          bridge: context.bridge,
          config: source,
          incoming: context.request,
          key: context.token,
          upstream,
        });
  if (storage !== undefined && key !== undefined) {
    const result = await cached(storage, key);
    if (result !== undefined) {
      return result;
    }
  }
  const response = await fetchSource(upstream, dependencies.fetcher);
  supportedHeaders(response.headers);
  const result = fromBody(await readSource(response), source, context);
  const control = response.headers.get("cache-control") ?? "";
  if (
    storage !== undefined &&
    key !== undefined &&
    !/no-store|no-cache/iu.test(control) &&
    !response.headers.has("set-cookie")
  ) {
    saveCache(storage, { key, payload: result }, dependencies.context);
  }
  return result;
}

export function mergeSources(items: Compiled[]): JsonObject[] {
  const seen = new Set<string>();
  const profiles: JsonObject[] = [];
  for (const item of items) {
    for (const profile of item.profiles) {
      const { meta = null, remarks: _remarks, ...runtime } = profile;
      // Leave records with client-facing settings distinct when those settings differ.
      const key = canonical({ ...runtime, metadata: meta });
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      profiles.push(profile);
    }
  }
  return profiles;
}

async function cached(storage: SourceCache, key: Request): Promise<Compiled | undefined> {
  try {
    const result = await storage.match(key);
    if (result === undefined) {
      return undefined;
    }
    const envelope = object(parseJson(await result.text()));
    if (
      envelope === undefined ||
      !Array.isArray(envelope.profiles) ||
      typeof envelope.rejected !== "number"
    ) {
      return undefined;
    }
    const profiles = envelope.profiles.map(object).filter((item) => item !== undefined);
    return profiles.length === 0 ? undefined : { profiles, rejected: envelope.rejected };
  } catch {
    return undefined;
  }
}

function fromBody(body: string, source: Source, context: RequestContext): Compiled {
  const userAgent = context.request.headers.get("user-agent") ?? "";
  const options = {
    legacyXdns: /^(?:Happ\/4\.8\.0|Throne\/1\.2\.4)(?:$|[\s(/-])/iu.test(userAgent),
    ...(source.mainTag !== undefined && { mainTag: source.mainTag }),
  };
  const parsed = parseSubscription(body, source.format);
  supportedHeaders(parsed.metadata);
  const profiles: JsonObject[] = [];
  let rejected = parsed.rejected;
  let remaining = MAX_COMPILED_BYTES;
  for (const profile of parsed.profiles) {
    verifyProfileIdentity(profile);
    try {
      const result = cascade(profile, context.bridge, options);
      const bytes = encoder.encode(JSON.stringify(result)).byteLength;
      if (bytes > remaining) {
        throw new Error("compiled-source-limit");
      }
      profiles.push(result);
      remaining -= bytes;
    } catch {
      rejected++;
    }
  }
  if (profiles.length === 0) {
    throw new Error("no-usable-nodes");
  }
  return { profiles, rejected };
}

function supportedHeaders(headers: Pick<Headers, "has">): void {
  if (RESPONSE_CONTROLS.some((name) => headers.has(name))) {
    throw new IncompatibleSource("provider-bound-subscription");
  }
}

function verifyProfileIdentity(profile: JsonObject): void {
  for (const record of [profile, object(profile.meta) ?? {}]) {
    if (Object.keys(record).some((name) => PROVIDER_BINDINGS.has(name.toLowerCase()))) {
      throw new IncompatibleSource("provider-bound-profile");
    }
  }
}
