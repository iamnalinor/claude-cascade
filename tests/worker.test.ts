import { expect, test } from "bun:test";

import { object, objects, parseJson } from "../src/json-value.ts";
import { type SourceCache } from "../src/source-cache.ts";
import { createWorker } from "../src/worker.ts";

const TOKEN = "fixture-token".repeat(4);
const UUID = "9b00c97f-f841-4625-b970-719534722e9f";
const MAIN = {
  protocol: "vless",
  settings: { address: "main.example.com", id: UUID, port: 443 },
  streamSettings: { network: "xhttp", security: "tls", xhttpSettings: { path: "/test" } },
  tag: "provider-main",
};
const BRIDGE = {
  protocol: "vless",
  settings: { address: "exit.example.com", id: UUID, port: 443 },
  streamSettings: { network: "raw", security: "tls" },
};
const LINK = `vless://${UUID}@main.example.com:443?type=raw&security=tls#Fixture`;

function env(): Record<string, unknown> {
  return {
    EXIT_OUTBOUND: JSON.stringify(BRIDGE),
    SOURCES: [
      { id: "a", urlSecret: "UPSTREAM_A" },
      { id: "b", urlSecret: "UPSTREAM_B" },
    ],
    SUB_ACCESS_TOKEN: TOKEN,
    UPSTREAM_A: "https://one.example.com/secret-a",
    UPSTREAM_B: "https://two.example.com/secret-b",
  };
}

function request(hwid = "fixture-device", token = TOKEN): Request {
  return new Request(`https://worker.example.com/sub/${token}`, {
    headers: {
      Authorization: "Bearer must-not-forward",
      Cookie: "must-not-forward",
      "User-Agent": "Happ/example",
      "X-HWID": hwid,
    },
  });
}

test("rejects invalid tokens before touching upstream", async () => {
  let isCalled = false;
  const worker = createWorker({
    fetcher: () => {
      isCalled = true;
      return Promise.resolve(new Response(LINK));
    },
  });
  const response = await worker.fetch(request("fixture", "0".repeat(32)), env());
  expect(response.status).toBe(404);
  expect(isCalled).toBe(false);
});

test("merges JSON and base64 while retaining old routes and rejecting a placeholder", async () => {
  const old = { domain: ["domain:old.example"], outboundTag: "provider-main", type: "field" };
  const worker = createWorker({
    fetcher: (url) =>
      Promise.resolve(
        new URL(url instanceof Request ? url.url : url).hostname === "one.example.com"
          ? Response.json({ outbounds: [MAIN], remarks: "Original", routing: { rules: [old] } })
          : new Response(
              Buffer.from(
                `${LINK}\n${LINK}\n${LINK.replace("main.example.com", "0.0.0.0")}`,
              ).toString("base64"),
            ),
      ),
  });
  const response = await worker.fetch(request(), env());
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Subscription-Rejected")).toBe("1");
  expect(response.headers.get("profile-update-interval")).toBe("6");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const profiles = objects(parseJson(await response.text()));
  expect(profiles).toHaveLength(2);
  const original = profiles[0];
  const outbounds = objects(original?.outbounds);
  const rules = objects(object(original?.routing)?.rules);
  expect(outbounds[0]).toEqual(MAIN);
  expect(outbounds[1]?.streamSettings).toMatchObject({ sockopt: { dialerProxy: "provider-main" } });
  expect(object(original?.routing)?.domainStrategy).toBe("IPOnDemand");
  expect(rules).toEqual([
    {
      domain: [
        "domain:anthropic.com",
        "domain:claude.ai",
        "domain:claude.com",
        "domain:claude.app",
        "domain:claudeusercontent.com",
        "domain:claudemcpcontent.com",
        "domain:withpersona.com",
      ],
      outboundTag: "cascade-exit2",
      type: "field",
    },
    { domain: ["full:ip.net.coffee"], outboundTag: "cascade-exit2", type: "field" },
    {
      domain: ["geosite:category-ru", "domain:ru", "domain:su", "domain:xn--p1ai"],
      outboundTag: "cascade-ru-direct",
      type: "field",
    },
    { ip: ["geoip:ru"], outboundTag: "cascade-ru-direct", type: "field" },
    old,
  ]);
});

test("keeps an available source and blocks cross-origin redirects and provider-bound output", async () => {
  const seen: string[] = [];
  const worker = createWorker({
    fetcher: (url, options) => {
      const hostname = new URL(url instanceof Request ? url.url : url).hostname;
      seen.push(hostname);
      const headers = new Headers(options?.headers);
      expect(headers.get("x-hwid")).toBe("fixture-device");
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
      return Promise.resolve(
        hostname === "one.example.com"
          ? new Response(null, {
              headers: { location: "https://redirect.example.com" },
              status: 302,
            })
          : new Response(LINK),
      );
    },
  });
  const response = await worker.fetch(request(), env());
  expect(response.status).toBe(200);
  expect(seen).toEqual(["one.example.com", "two.example.com"]);
  expect(response.headers.get("x-subscription-sources-incompatible")).toBe("1");

  const noOutput = createWorker({
    fetcher: () => Promise.resolve(new Response(LINK, { headers: { providerid: "example" } })),
  });
  const incompatible = await noOutput.fetch(request(), env());
  expect(incompatible.status).toBe(502);
  expect(await incompatible.text()).toBe('{"error":"source-incompatible"}');
});

test("isolates opt-in cache between identities and returns no profile on missing HWID", async () => {
  const hits: string[] = [];
  const memory = new Map<string, Response>();
  const storage: SourceCache = {
    match: (input) =>
      Promise.resolve(memory.get(String(input instanceof Request ? input.url : input))?.clone()),
    put: (input, response) => {
      memory.set(String(input instanceof Request ? input.url : input), response.clone());
      return Promise.resolve();
    },
  };
  const worker = createWorker({
    cache: storage,
    fetcher: (_url, options) => {
      hits.push(new Headers(options?.headers).get("x-hwid") ?? "");
      return Promise.resolve(new Response(LINK));
    },
  });
  const config = {
    ...env(),
    SOURCES: [{ cache: true, id: "a", requiresHwid: true, urlSecret: "UPSTREAM_A" }],
  };
  for (const device of ["A", "A", "B", "A"]) {
    const response = await worker.fetch(request(device), config);
    expect(response.status).toBe(200);
  }
  expect(hits).toEqual(["A", "B"]);
  const missing = await worker.fetch(request(""), config);
  expect(missing.status).toBe(502);
  expect(hits).toEqual(["A", "B"]);
});

test("rejects a broken chain and supports the observed masked links", async () => {
  const broken = {
    outbounds: [{ ...MAIN, streamSettings: { sockopt: { dialerProxy: "provider-main" } } }],
  };
  const maskedLink = `${LINK.split("#", 1)[0]}&fm=${encodeURIComponent(
    JSON.stringify({
      tcp: [{ settings: { length: "100-200", packets: "tlshello" }, type: "fragment" }],
    }),
  )}#Masked`;
  const worker = createWorker({
    fetcher: (url) =>
      Promise.resolve(
        new URL(url instanceof Request ? url.url : url).hostname === "one.example.com"
          ? Response.json(broken)
          : new Response(maskedLink),
      ),
  });
  const response = await worker.fetch(request(), env());
  expect(response.status).toBe(200);
  expect(response.headers.get("x-subscription-sources-failed")).toBe("1");
  const [masked] = objects(parseJson(await response.text()));
  expect(objects(masked?.outbounds)[0]?.streamSettings).toHaveProperty(
    "finalmask.tcp[0].type",
    "fragment",
  );
});

test("renders compatible XDNS and identical names across client versions", async () => {
  const mask = {
    type: "xdns",
    settings: {
      domains: [
        {
          name: "tunnel.example.com",
          types: [1],
          edns0: 1232,
          labelLimit: 63,
          lenLimit: 255,
        },
      ],
      resolvers: [{ type: "udp", settings: { addr: "192.0.2.53:53" } }],
    },
  };
  const link = `vless://${UUID}@main.example.com:443?type=kcp&fm=${encodeURIComponent(JSON.stringify(mask))}#Fixture`;
  const config = { ...env(), SOURCES: [{ id: "a", urlSecret: "UPSTREAM_A" }] };
  const worker = createWorker({ fetcher: () => Promise.resolve(new Response(link)) });

  for (const userAgent of ["Throne/1.2.4", "Happ/4.8.0 (Android)"]) {
    const legacy = request();
    legacy.headers.set("User-Agent", userAgent);
    const response = await worker.fetch(legacy, config);
    expect(response.status).toBe(200);
    const [profile] = objects(parseJson(await response.text()));
    const [main] = objects(profile?.outbounds);
    expect(profile?.remarks).toBe("Fixture · VLESS main.example.com:443");
    expect(main?.streamSettings).toHaveProperty("finalmask.udp[0].settings", {
      domains: ["tunnel.example.com:a"],
      resolvers: ["tunnel.example.com:a+udp://192.0.2.53:53"],
    });
  }

  const currentResponse = await worker.fetch(request(), config);
  expect(currentResponse.status).toBe(200);
  const [currentProfile] = objects(parseJson(await currentResponse.text()));
  const [currentMain] = objects(currentProfile?.outbounds);
  expect(currentProfile?.remarks).toBe("Fixture · VLESS main.example.com:443");
  expect(currentMain?.streamSettings).toHaveProperty("finalmask.udp[0].settings", {
    domains: [
      {
        names: ["tunnel.example.com"],
        types: [1],
        edns0: 1232,
        labelLimit: 63,
        lenLimit: 255,
      },
    ],
    resolvers: [{ addrs: ["udp://192.0.2.53:53"] }],
  });
});

test("keeps provider balancers and resolves mislabelled rules without dropping profiles", async () => {
  const domain = ["domain:foreign.example"];
  const single = {
    outbounds: [MAIN],
    routing: {
      balancers: [{ selector: ["provider-main"], tag: "balancer_actual" }],
      rules: [{ domain, outboundTag: "balancer_stale" }],
    },
  };
  const multi = {
    outbounds: [MAIN, { ...MAIN, settings: { ...MAIN.settings, port: 8443 }, tag: "provider-alt" }],
    routing: {
      balancers: [{ selector: ["provider-"], tag: "pool" }],
      rules: [{ domain, outboundTag: "pool" }],
    },
  };
  const config = { ...env(), SOURCES: [{ id: "a", urlSecret: "UPSTREAM_A" }] };
  const worker = createWorker({ fetcher: () => Promise.resolve(Response.json([single, multi])) });
  const response = await worker.fetch(request(), config);
  expect(response.status).toBe(200);
  const profiles = objects(parseJson(await response.text()));
  expect(profiles).toHaveLength(2);
  expect(objects(object(profiles[0]?.routing)?.rules).at(-1)).toEqual({
    balancerTag: "balancer_actual",
    domain,
  });
  expect(objects(object(profiles[1]?.routing)?.rules).at(-1)).toEqual({
    balancerTag: "pool",
    domain,
  });
  expect(objects(profiles[1]?.outbounds)[2]?.streamSettings).toMatchObject({
    sockopt: { dialerProxy: "provider-main" },
  });
});
