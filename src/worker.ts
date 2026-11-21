import { collectSources } from "./collect-sources.ts";
import { exitConfiguration } from "./exit-bridge.ts";
import { renderSubscription } from "./render-subscription.ts";
import { type SourceCache, type TaskContext } from "./source-cache.ts";
import { type Bindings, sources, textBinding } from "./source-config.ts";
import { type Fetcher } from "./source-request.ts";
import { diagnosticLines, subscriptionAnnouncement } from "./subscription-announcement.ts";

const NO_STORE = "private, no-store";
const TOKEN_PATTERN = /^[\w-]{32,128}$/iu;
const URL_PATTERN = /^\/sub\/(?<token>[\w-]{32,128})(?:\/report)?$/iu;
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
      const match = URL_PATTERN.exec(url.pathname);
      const provided = match?.groups?.token;
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
  const exit = exitConfiguration(environment);
  const configured = sources(environment);
  const results = await collectSources(
    configured,
    {
      ...exit,
      env: environment,
      request,
      token: options.token,
    },
    { ...options, fetcher: options.fetcher ?? fetch },
  );
  const { profiles, report } = renderSubscription(results, request, exit);
  const diagnostics = diagnosticLines(report);
  if (profiles.length === 0) {
    return json(
      {
        error: results.incompatible > 0 ? "source-incompatible" : "subscription-unavailable",
        diagnostics,
      },
      502,
    );
  }
  const { rejected, failedSources } = report.summary;
  const warnings = rejected + failedSources;
  const announce = subscriptionAnnouncement(diagnostics, profiles);
  return json(
    profiles,
    200,
    new Headers({
      "profile-title": warnings > 0 ? `Claude Cascade [warnings: ${warnings}]` : "Claude Cascade",
      "profile-update-interval": REFRESH_HOURS,
      "x-subscription-rejected": String(rejected),
      "x-subscription-sources-failed": String(failedSources),
      "x-subscription-sources-incompatible": String(results.incompatible),
      ...(announce !== undefined && { announce }),
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
