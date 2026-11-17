import { expect, test } from "bun:test";

import { object, objects, parseJson } from "../src/json-value.ts";
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

test("chains a Hysteria2 EXIT2 through a first-hop dialer in both modes", async () => {
  const bridge = {
    protocol: "hysteria",
    settings: { address: "exit.example.com", port: 443, version: 2 },
    streamSettings: {
      hysteriaSettings: { auth: "fixture", version: 2 },
      network: "hysteria",
      security: "tls",
      tlsSettings: { serverName: "exit.example.com" },
    },
  };
  const worker = createWorker({
    fetcher: () => Promise.resolve(Response.json({ outbounds: [MAIN] })),
  });
  const response = await worker.fetch(request(), {
    ...env(),
    EXIT_OUTBOUND: JSON.stringify(bridge),
  });
  expect(response.status).toBe(200);
  const profiles = objects(parseJson(await response.text()));
  expect(profiles).toHaveLength(2);
  for (const profile of profiles) {
    const outbounds = objects(profile.outbounds);
    const exit = outbounds.find((outbound) => outbound.protocol === "hysteria");
    expect(exit).toMatchObject(bridge);
    const dialer = object(object(exit?.streamSettings)?.sockopt)?.dialerProxy;
    expect(outbounds.find((outbound) => outbound.tag === dialer)?.protocol).toBe("vless");
  }
  const unsigned = { ...bridge.streamSettings.tlsSettings, allowInsecure: true };
  const unsafe = { ...bridge, streamSettings: { ...bridge.streamSettings, tlsSettings: unsigned } };
  const rejected = await worker.fetch(request(), {
    ...env(),
    EXIT_OUTBOUND: JSON.stringify(unsafe),
  });
  expect(rejected.status).toBe(503);
});

test.each(["http", "socks"])(
  "chains a %s proxy as EXIT2 without an explicit transport",
  async (protocol) => {
    const bridge = {
      protocol,
      settings: { servers: [{ address: "proxy.example.com", port: 1080 }] },
    };
    const worker = createWorker({
      fetcher: () => Promise.resolve(Response.json({ outbounds: [MAIN] })),
    });
    const response = await worker.fetch(request(), {
      ...env(),
      EXIT_OUTBOUND: JSON.stringify(bridge),
    });
    expect(response.status).toBe(200);
    const profiles = objects(parseJson(await response.text()));
    expect(profiles).toHaveLength(2);
    for (const profile of profiles) {
      const outbounds = objects(profile.outbounds);
      const exit = outbounds.find((outbound) => outbound.protocol === protocol);
      expect(exit).toMatchObject(bridge);
      const dialer = object(object(exit?.streamSettings)?.sockopt)?.dialerProxy;
      expect(outbounds.find((outbound) => outbound.tag === dialer)?.protocol).toBe("vless");
    }
  },
);

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

test("retains provider DNS and sniffing exclusions while protecting incoming Anthropic addresses", async () => {
  const dns = { hosts: { "internal.example": "192.0.2.53" }, servers: ["localhost"] };
  const worker = createWorker({
    fetcher: () =>
      Promise.resolve(
        Response.json({
          dns,
          inbounds: [
            {
              port: 10_808,
              protocol: "socks",
              sniffing: { enabled: true, ipsExcluded: ["192.0.2.0/24"], routeOnly: true },
            },
          ],
          outbounds: [MAIN],
        }),
      ),
  });
  const result = await worker.fetch(request(), env());
  const [profile] = objects(parseJson(await result.text()));
  expect(profile?.dns).toEqual(dns);
  expect(objects(profile?.inbounds)[0]?.sniffing).toMatchObject({
    ipsExcluded: ["192.0.2.0/24", "160.79.104.0/23", "153.61.224.0/22", "2607:6bc0::/48"],
    routeOnly: true,
  });
  expect(
    objects(object(profile?.routing)?.rules).some((rule) => rule.inboundTag !== undefined),
  ).toBe(false);
});
