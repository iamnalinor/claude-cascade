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
import {
  cachedIssues,
  isInformationalPlaceholder,
  isRejectedIssue,
  nodeIssue,
  type NodeIssue,
  SourceCompilationError,
} from "./subscription-diagnostics.ts";
import { parseSubscription } from "./subscription-format.ts";
import { MAX_SUBSCRIPTION_BYTES } from "./subscription-limits.ts";

const PROVIDER_BINDINGS = new Set(["install-id", "installid", "provider-id", "providerid"]);
// Provider routing headers are ignored; only the generated profile routing is returned.
const RESPONSE_CONTROLS = [...PROVIDER_BINDINGS, "subscription-always-hwid-enable"];
const encoder = new TextEncoder();

export type CompilationContext = {
  bridge: JsonObject;
  via?: JsonObject;
  env: Bindings;
  request: Request;
  token: string;
};
export type Compiled = {
  source: string;
  profiles: JsonObject[];
  rejected: number;
  input: number;
  issues: NodeIssue[];
};
export type CompileDependencies = {
  cache?: SourceCache;
  context?: TaskContext;
  fetcher: Fetcher;
};

export async function compileSource(
  source: Source,
  context: CompilationContext,
  dependencies: CompileDependencies,
): Promise<Compiled> {
  const upstream = sourceRequest(context.env, source, context.request);
  const storage = dependencies.cache;
  const key =
    storage === undefined
      ? undefined
      : await cacheKey({
          bridge: context.bridge,
          ...(context.via !== undefined && { via: context.via }),
          config: source,
          incoming: context.request,
          key: context.token,
          upstream,
        });
  if (storage !== undefined && key !== undefined) {
    const result = await cached(storage, key, source.id);
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

export function mergeSources(
  items: Compiled[],
  onDuplicate?: (item: Compiled, profile: JsonObject) => void,
): JsonObject[] {
  const seen = new Set<string>();
  const profiles: JsonObject[] = [];
  for (const item of items) {
    for (const profile of item.profiles) {
      const { meta = null, remarks: _remarks, ...runtime } = profile;
      // Leave records with client-facing settings distinct when those settings differ.
      const key = canonical({ ...runtime, metadata: meta });
      if (seen.has(key)) {
        onDuplicate?.(item, profile);
        continue;
      }

      seen.add(key);
      profiles.push(profile);
    }
  }
  return profiles;
}

async function cached(
  storage: SourceCache,
  key: Request,
  source: string,
): Promise<Compiled | undefined> {
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
    return profiles.length === 0
      ? undefined
      : {
          source,
          profiles,
          rejected: envelope.rejected,
          input:
            typeof envelope.input === "number"
              ? envelope.input
              : profiles.length + envelope.rejected,
          issues: cachedIssues(envelope.issues),
        };
  } catch {
    return undefined;
  }
}

function fromBody(body: string, source: Source, context: CompilationContext): Compiled {
  const userAgent = context.request.headers.get("user-agent") ?? "";
  const options = {
    ...(context.via !== undefined && { via: context.via }),
    legacyXdns: /^(?:Happ\/4\.8\.0|Throne\/1\.2\.4)(?:$|[\s(/-])/iu.test(userAgent),
    ...(source.mainTag !== undefined && { mainTag: source.mainTag }),
  };
  const parsed = parseSubscription(body, source.format);
  supportedHeaders(parsed.metadata);
  const profiles: JsonObject[] = [];
  const issues = [...parsed.issues];
  const input = parsed.profiles.length + parsed.rejected;
  let remaining = MAX_SUBSCRIPTION_BYTES;
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
    } catch (error) {
      issues.push(
        isInformationalPlaceholder(profile.remarks, error)
          ? nodeIssue("informational", profile.remarks, new Error("provider-information"))
          : nodeIssue("compile", profile.remarks, error),
      );
    }
  }
  if (profiles.length === 0) {
    throw new SourceCompilationError(issues, input);
  }
  return {
    source: source.id,
    profiles,
    rejected: issues.filter(isRejectedIssue).length,
    input,
    issues,
  };
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
