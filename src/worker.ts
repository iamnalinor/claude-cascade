import { type Compiled, compileSource, mergeSources } from "./compile-source.ts";
import { validateBridge } from "./exit-bridge.ts";
import { object, parseJson } from "./json-value.ts";
import { type SourceCache, type TaskContext } from "./source-cache.ts";
import { type Bindings, sources, textBinding } from "./source-config.ts";
import { type Fetcher, IncompatibleSource } from "./source-request.ts";

const MAX_PARALLEL = 3;
const NO_STORE = "private, no-store";
const TOKEN_PATTERN = /^[\w-]{32,128}$/iu;
const URL_PATTERN = /^\/sub\/(?<token>[\w-]{32,128})$/iu;
const REFRESH_HOURS = "6";

type RuntimeDependencies = { cache?: SourceCache; fetcher?: Fetcher };

export function createWorker(dependencies: RuntimeDependencies = {}): {
  fetch(request: Request, environment: Bindings, context?: TaskContext): Promise<Response>;
} {
  return {
    async fetch(request, environment, context): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ status: "ok" }, 200);
      }
      const provided = URL_PATTERN.exec(url.pathname)?.groups?.token;
      if (request.method !== "GET" || url.search !== "" || provided === undefined) {
        return json({ error: "not-found" }, 404);
      }
      try {
        const token = textBinding(environment, "SUB_ACCESS_TOKEN");
        if (!TOKEN_PATTERN.test(token) || !(await isEqualToken(provided, token))) {
          return json({ error: "not-found" }, 404);
        }
        return await subscription(request, environment, {
          ...dependencies,
          ...(context !== undefined && { context }),
          token,
        });
      } catch {
        return json({ error: "subscription-unavailable" }, 503);
      }
    },
  };
}

async function isEqualToken(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [candidate, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  let difference = 0;
  const expectedBytes = new Uint8Array(expected);
  const candidateBytes = new Uint8Array(candidate);
  for (const [index, byte] of candidateBytes.entries()) {
    difference |= byte ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}

function json(value: unknown, status: number, headers?: Headers): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", NO_STORE);
  responseHeaders.set("x-content-type-options", "nosniff");
  return Response.json(value, { headers: responseHeaders, status });
}

async function subscription(
  request: Request,
  environment: Bindings,
  options: RuntimeDependencies & { context?: TaskContext; token: string },
): Promise<Response> {
  const bridge = object(parseJson(textBinding(environment, "EXIT_OUTBOUND")));
  if (bridge === undefined) {
    throw new Error("missing-bridge");
  }
  validateBridge(bridge);
  const configured = sources(environment);
  const { fetcher = fetch } = options;
  const results: Compiled[] = [];
  let incompatible = 0;
  for (let index = 0; index < configured.length; index += MAX_PARALLEL) {
    const batch = configured.slice(index, index + MAX_PARALLEL);
    const completed = await Promise.allSettled(
      batch.map(
        async (source) =>
          await compileSource(
            source,
            { bridge, env: environment, request, token: options.token },
            {
              ...options,
              fetcher,
            },
          ),
      ),
    );
    for (const result of completed) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else if (result.reason instanceof IncompatibleSource) {
        incompatible++;
      }
    }
  }
  const profiles = mergeSources(results);
  if (profiles.length === 0) {
    return json(
      { error: incompatible > 0 ? "source-incompatible" : "subscription-unavailable" },
      502,
    );
  }
  const rejected = results.reduce((total, result) => total + result.rejected, 0);
  return json(
    profiles,
    200,
    new Headers({
      "profile-title": "Happ Cascade",
      "profile-update-interval": REFRESH_HOURS,
      "x-subscription-rejected": String(rejected),
      "x-subscription-sources-failed": String(configured.length - results.length),
      "x-subscription-sources-incompatible": String(incompatible),
    }),
  );
}

export default {
  async fetch(request: Request, environment: Bindings, context: TaskContext): Promise<Response> {
    const cache = Reflect.get(globalThis.caches, "default") as SourceCache | undefined;
    const worker = createWorker(cache === undefined ? {} : { cache });
    return await worker.fetch(request, environment, context);
  },
};
