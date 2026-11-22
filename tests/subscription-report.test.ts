import { expect, test } from "bun:test";

import { type JsonObject, objects, parseJson } from "../src/json-value.ts";
import { type SourceCache } from "../src/source-cache.ts";
import { subscriptionAnnouncement } from "../src/subscription-announcement.ts";
import { createWorker } from "../src/worker.ts";
import { env, LINK, MAIN, request } from "./fixtures.ts";

const config = { ...env(), SOURCES: [{ id: "a", urlSecret: "UPSTREAM_A" }] };

function announcement(response: Response): string {
  const header = response.headers.get("announce") ?? "";
  expect(header).toStartWith("base64:");
  return Buffer.from(header.slice(7), "base64").toString("utf8");
}

function memoryCache(): SourceCache {
  const saved = new Map<string, Response>();
  return {
    match: (input) =>
      Promise.resolve(saved.get(input instanceof Request ? input.url : String(input))?.clone()),
    put: (input, response) => {
      saved.set(input instanceof Request ? input.url : String(input), response.clone());
      return Promise.resolve();
    },
  };
}

test("ordinary subscriptions show every rejected name and Russian reason immediately", async () => {
  const broken = {
    ...MAIN,
    streamSettings: { ...MAIN.streamSettings, sockopt: { dialerProxy: "missing" } },
  };
  const worker = createWorker({
    fetcher: () =>
      Promise.resolve(
        Response.json([
          { remarks: "Working", outbounds: [MAIN] },
          { remarks: "Broken OBS", outbounds: [broken] },
          { remarks: "Второй узел", outbounds: [broken] },
        ]),
      ),
  });
  const response = await worker.fetch(request(), config);
  expect(response.status).toBe(200);
  const text = announcement(response);
  expect(text).toContain("Broken OBS");
  expect(text).toContain("Второй узел");
  expect(text).toContain("цепочк");
  expect(text).toContain("a");
  expect(text).not.toContain("/report");
  expect(objects(parseJson(await response.text())).map((profile) => profile.remarks)).toContain(
    "Working",
  );
});

test.each(["report", "RePoRt", "REPORT", "unknown"])(
  "rejects unexpected /%s suffix without fetching subscriptions",
  async (suffix) => {
    let calls = 0;
    const worker = createWorker({
      fetcher: () => {
        calls++;
        return Promise.resolve(new Response(LINK));
      },
    });
    const response = await worker.fetch(
      new Request(`${request().url}/${suffix}`, request()),
      config,
    );
    expect(response.status).toBe(404);
    expect(parseJson(await response.text())).toEqual({ error: "not-found" });
    expect(calls).toBe(0);
  },
);

test("inline parsing diagnostics never reveal URL credentials or client identity", async () => {
  const worker = createWorker({
    fetcher: () =>
      Promise.resolve(
        new Response(`${LINK}\nunknown://private-password@secret.example:443#Hidden%20node`),
      ),
  });
  const response = await worker.fetch(request(), config);
  const text = announcement(response);
  expect(text).toContain("Hidden node");
  expect(text).toContain("формат");
  for (const secret of ["private-password", "secret.example", "secret-a", "fixture-device"]) {
    expect(text).not.toContain(secret);
  }
});

test("all rejected nodes produce sanitized diagnostic detail directly in the 502 body", async () => {
  const worker = createWorker({
    fetcher: () =>
      Promise.resolve(new Response("unknown://credential@private.example#Unsupported")),
  });
  const response = await worker.fetch(request(), config);
  expect(response.status).toBe(502);
  const raw = await response.text();
  expect(raw).toContain("Unsupported");
  expect(raw).toContain("формат");
  expect(raw).not.toContain("credential");
  expect(raw).not.toContain("private.example");
});

test("missing client HWID and provider rejection name the source and explain the cause", async () => {
  const worker = createWorker({
    fetcher: () =>
      Promise.resolve(new Response(LINK, { headers: { "x-hwid-not-supported": "true" } })),
  });
  const response = await worker.fetch(new Request(request().url), {
    ...env(),
    SOURCES: [
      { id: "required", requiresHwid: true, urlSecret: "UPSTREAM_A" },
      { id: "rejected", urlSecret: "UPSTREAM_B" },
    ],
  });
  expect(response.status).toBe(502);
  const raw = await response.text();
  expect(raw).toContain("required");
  expect(raw).toContain("missing-client-hwid");
  expect(raw).toContain("rejected");
  expect(raw).toContain("provider-rejected-hwid");
  expect(raw).toContain("HWID");
  expect(raw).not.toContain("secret-a");
});

test("compiled source cache retains inline rejection detail without report cache writes", async () => {
  let calls = 0;
  const cache = memoryCache();
  const worker = createWorker({
    cache,
    fetcher: () => {
      calls++;
      return Promise.resolve(
        new Response(`${LINK}\nunknown://fixture@private.example#Unsupported`),
      );
    },
  });
  const cachedConfig = { ...env(), SOURCES: [{ id: "a", cache: true, urlSecret: "UPSTREAM_A" }] };
  await worker.fetch(request(), cachedConfig);
  const response = await worker.fetch(request(), cachedConfig);
  expect(calls).toBe(1);
  expect(announcement(response)).toContain("Unsupported");
});

test("duplicate nodes do not generate warnings", async () => {
  const worker = createWorker({ fetcher: () => Promise.resolve(new Response(LINK)) });
  const response = await worker.fetch(request(), env());
  expect(response.headers.get("announce")).toBeNull();
  expect(response.headers.get("x-subscription-rejected")).toBe("0");
});

test.each(["📶 Обходы ниже", "🛜 Wi-FI сервера (╯°□°)╯︵ ┻━┻"])(
  "informational placeholder %s does not generate warnings",
  async (title) => {
    const banner = {
      remarks: title,
      outbounds: [{ ...MAIN, settings: { ...MAIN.settings, address: "0.0.0.0" } }],
    };
    const worker = createWorker({
      fetcher: () =>
        Promise.resolve(Response.json([{ remarks: "Working", outbounds: [MAIN] }, banner])),
    });
    const response = await worker.fetch(request(), config);
    expect(response.status).toBe(200);
    expect(response.headers.get("announce")).toBeNull();
    expect(response.headers.get("x-subscription-rejected")).toBe("0");
    expect(await response.text()).not.toContain(title);
  },
);

test("large announcements retain full detail in existing metadata without changing names", async () => {
  const rejected = Array.from(
    { length: 70 },
    (_, index) =>
      `unknown://private-password@secret.example#${encodeURIComponent(`Исключённый узел ${index}`)}`,
  );
  const worker = createWorker({
    fetcher: () => Promise.resolve(new Response([LINK, ...rejected].join("\n"))),
  });
  const response = await worker.fetch(request(), config);
  const text = announcement(response);
  expect(text).toContain("сокращено");
  expect(text).toContain("meta.cascadeDiagnostics");
  const profiles = objects(parseJson(await response.text()));
  expect(profiles[0]?.remarks).toBe("Fixture");
  const raw = JSON.stringify(profiles[0]?.meta);
  expect(raw).toContain("Исключённый узел 69");
  expect(raw).not.toContain("private-password");
  expect(raw).not.toContain("secret.example");
});

test("overflow merges object metadata and preserves nonobject provider metadata", () => {
  const lines = Array.from(
    { length: 100 },
    (_, index) => `Источник a: исключён узел ${index}: формат не поддерживается.`,
  );
  const profiles: JsonObject[] = [
    { remarks: "First", meta: "provider-string" },
    { remarks: "Second", meta: { providerData: "retained" } },
  ];
  const header = subscriptionAnnouncement(lines, profiles);
  expect(header).toStartWith("base64:");
  expect(profiles[0]?.meta).toBe("provider-string");
  expect(profiles[1]?.meta).toEqual({ providerData: "retained", cascadeDiagnostics: lines });
  expect(profiles.map((profile) => profile.remarks)).toEqual(["First", "Second"]);
  const onlyNonobject: JsonObject[] = [{ remarks: "First", meta: "provider-string" }];
  const limited = subscriptionAnnouncement(lines, onlyNonobject) ?? "";
  const decoded = Buffer.from(limited.slice(7), "base64").toString("utf8");
  expect(Buffer.byteLength(decoded, "utf8")).toBeLessThanOrEqual(6000);
  expect(decoded).toContain("cascadeDiagnostics");
  expect(decoded).toContain("Объявление сокращено");
  expect(onlyNonobject[0]?.cascadeDiagnostics).toEqual(lines);
  expect(onlyNonobject[0]?.meta).toBe("provider-string");
});
