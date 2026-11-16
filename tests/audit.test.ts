import { expect, test } from "bun:test";

import { objects, parseJson } from "../src/json-value.ts";
import { createWorker } from "../src/worker.ts";
import { BRIDGE, env, LINK, MAIN, request, UUID } from "./fixtures.ts";

test("requires a single verified RAW transport for EXIT2", async () => {
  let wasFetched = false;
  const worker = createWorker({
    fetcher: () => {
      wasFetched = true;
      return Promise.resolve(new Response(LINK));
    },
  });
  const unsafeStreams = [
    { network: "xhttp", security: "tls", xhttpSettings: { mode: "stream-up" } },
    { network: "raw", security: "reality" },
  ];
  for (const stream of unsafeStreams) {
    const response = await worker.fetch(request(), {
      ...env(),
      EXIT_OUTBOUND: JSON.stringify({ ...BRIDGE, streamSettings: stream }),
    });
    expect(response.status).toBe(503);
  }
  expect(wasFetched).toBe(false);
});

test("accepts local client inbounds and keeps provider control services out of profiles", async () => {
  const profiles = [
    {
      inbounds: [{ port: 10_808, protocol: "socks", settings: { udp: true } }],
      log: { loglevel: "warning" },
      outbounds: [MAIN],
    },
    { inbounds: [{ listen: "0.0.0.0", port: 10_808, protocol: "socks" }], outbounds: [MAIN] },
    { api: { services: ["HandlerService"] }, outbounds: [MAIN] },
  ];
  const worker = createWorker({ fetcher: () => Promise.resolve(Response.json(profiles)) });
  const response = await worker.fetch(request(), env());
  expect(response.status).toBe(200);
  const result = objects(parseJson(await response.text()));
  expect(result).toHaveLength(2);
  expect(result[0]?.inbounds).toMatchObject([{ listen: "127.0.0.1", protocol: "socks" }]);
  expect(result[0]?.log).toBeUndefined();
});

test("keeps UTF-8 metadata and rejects public cleartext profiles", async () => {
  const worker = createWorker({
    fetcher: () =>
      Promise.resolve(
        new Response(
          `#profile-title: Провайдер 🇷🇺\n${LINK}\n${LINK.replace("security=tls", "security=none")}`,
        ),
      ),
  });
  const response = await worker.fetch(request(), env());
  expect(response.status).toBe(200);
  expect(objects(parseJson(await response.text()))).toHaveLength(2);
  expect(response.headers.get("x-subscription-rejected")).toBe("2");
});

test("converts legacy resolver pairs for a current Xray", async () => {
  const settings = { resolvers: ["tunnel.example.com+udp://192.0.2.53:53"] };
  const mask = { type: "xdns", settings };
  const link = `vless://${UUID}@10.0.0.10:443?type=kcp&fm=${encodeURIComponent(JSON.stringify(mask))}#Fixture`;
  const worker = createWorker({ fetcher: () => Promise.resolve(new Response(link)) });
  const response = await worker.fetch(request(), env());
  expect(response.status).toBe(200);
  const [profile] = objects(parseJson(await response.text()));
  const [main] = objects(profile?.outbounds);
  expect(main?.streamSettings).toHaveProperty("finalmask.udp[0].settings", {
    domains: [
      { names: ["tunnel.example.com"], types: [16], edns0: 1232, labelLimit: 63, lenLimit: 255 },
    ],
    resolvers: [{ addrs: ["udp://192.0.2.53:53"] }],
  });
});

test("keeps generated routes outside the provider's balancer prefixes", async () => {
  const profile = {
    outbounds: [{ ...MAIN, tag: "cascade-upstream" }],
    routing: { balancers: [{ selector: ["cascade-"], tag: "pool" }] },
  };
  const worker = createWorker({ fetcher: () => Promise.resolve(Response.json(profile)) });
  const response = await worker.fetch(request(), env());
  expect(response.status).toBe(200);
  const [result] = objects(parseJson(await response.text()));
  const outbounds = objects(result?.outbounds);
  expect(
    outbounds.filter((item) => typeof item.tag === "string" && item.tag.startsWith("cascade-")),
  ).toEqual(profile.outbounds);
  expect(outbounds[1]?.streamSettings).toMatchObject({
    sockopt: { dialerProxy: "cascade-upstream" },
  });
});
