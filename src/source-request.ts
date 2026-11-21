import { type Bindings, type Source, textBinding } from "./source-config.ts";
import { MAX_SUBSCRIPTION_BYTES } from "./subscription-limits.ts";

const MAX_REDIRECTS = 2;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

export type Fetcher = (input: RequestInfo | URL, options?: RequestInit) => Promise<Response>;

export class IncompatibleSource extends Error {}

export async function fetchSource(request: Request, fetcher: Fetcher): Promise<Response> {
  const signal = AbortSignal.timeout(8000);
  const initial = new URL(request.url);
  let target = initial;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const response = await fetcher(target, {
      cache: "no-store",
      headers: request.headers,
      redirect: "manual",
      signal,
    });
    if (!REDIRECT.has(response.status)) {
      return await checkStatus(response);
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    const url = location === null ? null : URL.parse(location, target);
    if (
      url?.origin !== initial.origin ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new IncompatibleSource("unapproved-source-redirect");
    }
    target = url;
  }
  throw new Error("redirect-limit");
}

export async function readSource(response: Response): Promise<string> {
  if (
    Number(response.headers.get("content-length")) > MAX_SUBSCRIPTION_BYTES ||
    response.headers.get("content-type")?.toLowerCase().includes("text/html") === true
  ) {
    await response.body?.cancel();
    throw new Error("invalid-source-response");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("empty-source");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let content = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return content + decoder.decode();
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_SUBSCRIPTION_BYTES) {
        throw new Error("source-limit");
      }
      content += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Keep the original read error if the stream is already closed.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function sourceRequest(environment: Bindings, source: Source, request: Request): Request {
  const headers = new Headers();
  for (const name of source.identityHeaders) {
    const value = request.headers.get(name);
    if (value !== null && value !== "" && value.length < 2048) {
      headers.set(name, value);
    }
  }
  if (source.requiresHwid && !headers.has("x-hwid")) {
    throw new IncompatibleSource("missing-client-hwid");
  }
  if (source.authSecret !== undefined) {
    headers.set("authorization", `Bearer ${textBinding(environment, source.authSecret)}`);
  }
  return new Request(sourceUrl(environment, source), { headers, redirect: "manual" });
}

async function checkStatus(response: Response): Promise<Response> {
  if (response.headers.get("x-hwid-not-supported")?.toLowerCase() === "true") {
    await response.body?.cancel();
    throw new IncompatibleSource("provider-rejected-hwid");
  }
  if (response.ok) {
    return response;
  }
  await response.body?.cancel();
  if ([401, 403, 410, 451].includes(response.status)) {
    throw new IncompatibleSource("source-denied");
  }
  throw new Error("source-unavailable");
}

function sourceUrl(environment: Bindings, source: Source): URL {
  const url = new URL(textBinding(environment, source.urlSecret));
  if (url.hash !== "") {
    throw new IncompatibleSource("subscription-url-fragment");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !url.hostname.includes(".") ||
    url.hostname.endsWith(".localhost")
  ) {
    throw new Error("invalid-source-url");
  }
  return url;
}
