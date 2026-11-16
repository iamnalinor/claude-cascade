import { expect, test } from "bun:test";

import { object, objects, parseJson, string } from "../src/json-value.ts";
import { createWorker } from "../src/worker.ts";
import { env, LINK, MAIN, request } from "./fixtures.ts";

test("appends one automatic profile that measures complete cascades and blocks foreign traffic on failure", async () => {
  const second = {
    ...MAIN,
    settings: { ...MAIN.settings, address: "second.example.com" },
    streamSettings: { ...MAIN.streamSettings, sockopt: { dialerProxy: "fragment" } },
    tag: "second",
  };
  const group = {
    outbounds: [MAIN, second, { protocol: "freedom", tag: "fragment" }],
    remarks: "Original group",
  };
  const worker = createWorker({
    fetcher: (url) =>
      Promise.resolve(
        new URL(url instanceof Request ? url.url : url).hostname === "one.example.com"
          ? Response.json([group, { outbounds: [MAIN], remarks: "Individual" }])
          : new Response(LINK),
      ),
  });
  const response = await worker.fetch(request(), env());
  expect(response.status).toBe(200);
  const profiles = objects(parseJson(await response.text()));
  expect(profiles.map((profile) => profile.remarks)).toEqual([
    "Original group",
    "Individual",
    "Fixture",
    "Все → EXIT2",
  ]);
  const automatic = profiles.at(-1);
  if (automatic === undefined) {
    throw new Error("missing automatic profile");
  }
  const outbounds = objects(automatic.outbounds);
  const routing = object(automatic.routing);
  const [balancer] = objects(routing?.balancers);
  if (balancer === undefined) {
    throw new Error("missing automatic balancer");
  }
  const [prefix] = balancer.selector as [string];
  const exits = outbounds.filter((entry) => string(entry.tag)?.startsWith(prefix) === true);
  expect(exits).toHaveLength(3);
  for (const exit of exits) {
    const stream = object(exit.streamSettings);
    const first = outbounds.find((entry) => entry.tag === object(stream?.sockopt)?.dialerProxy);
    expect(first?.protocol).toBe("vless");
    expect(exit.settings).toMatchObject({ address: "exit.example.com" });
  }
  expect(automatic.burstObservatory).toMatchObject({
    pingConfig: { destination: "https://www.gstatic.com/generate_204" },
    subjectSelector: [prefix],
  });
  expect(balancer.strategy).toEqual({ type: "leastPing" });
  expect(outbounds[0]).toEqual({ protocol: "blackhole", tag: string(balancer.fallbackTag) ?? "" });
  const rules = objects(routing?.rules);
  expect(rules).toContainEqual({
    ip: ["geoip:ru"],
    outboundTag: "cascade-ru-direct",
    type: "field",
  });
  expect(rules.at(-1)).toEqual({
    balancerTag: string(balancer.tag) ?? "",
    network: "tcp,udp",
    type: "field",
  });
  const secondHop = outbounds.find(
    (entry) => object(entry.settings)?.address === "second.example.com",
  );
  const fragment = object(object(secondHop?.streamSettings)?.sockopt)?.dialerProxy;
  expect(outbounds.find((entry) => entry.tag === fragment)?.protocol).toBe("freedom");
});

test("modern Xray keeps convertible and independent candidates when a provider uses legacy proxySettings", async () => {
  const transport = {
    ...MAIN,
    proxySettings: { tag: "fragment", transportLayer: true },
    settings: { ...MAIN.settings, address: "transport.example.com" },
    tag: "transport",
  };
  const legacy = {
    ...MAIN,
    proxySettings: { tag: "fragment" },
    settings: { ...MAIN.settings, address: "legacy.example.com" },
    tag: "legacy",
  };
  const fragment = { protocol: "freedom", tag: "fragment" };
  const worker = createWorker({
    fetcher: () =>
      Promise.resolve(
        Response.json([
          { outbounds: [MAIN, transport, legacy, fragment], remarks: "Provider group" },
          { outbounds: [transport, fragment], remarks: "Transport detour" },
        ]),
      ),
  });
  const response = await worker.fetch(request(), env());
  expect(response.status).toBe(200);
  const profiles = objects(parseJson(await response.text()));
  expect(profiles.map((profile) => profile.remarks)).toEqual(["Transport detour", "Все → EXIT2"]);
  expect(objects(profiles[0]?.outbounds)[0]).toMatchObject({
    streamSettings: { sockopt: { dialerProxy: "fragment" } },
  });
  const automatic = objects(profiles.at(-1)?.outbounds);
  expect(automatic.some((entry) => entry.proxySettings !== undefined)).toBe(false);
  expect(
    automatic.filter((entry) => string(entry.tag)?.startsWith("auto-exit-") === true),
  ).toHaveLength(2);
  const converted = automatic.find(
    (entry) => object(entry.settings)?.address === "transport.example.com",
  );
  const dialer = object(object(converted?.streamSettings)?.sockopt)?.dialerProxy;
  expect(automatic.find((entry) => entry.tag === dialer)?.protocol).toBe("freedom");

  const throne = request();
  throne.headers.set("user-agent", "Throne/1.2.4");
  const oldResponse = await worker.fetch(throne, env());
  expect(oldResponse.status).toBe(200);
  const oldProfiles = objects(parseJson(await oldResponse.text()));
  expect(oldProfiles[0]?.remarks).toBe("Provider group");
  const oldAutomatic = objects(oldProfiles.at(-1)?.outbounds);
  expect(
    oldAutomatic.filter((entry) => string(entry.tag)?.startsWith("auto-exit-") === true),
  ).toHaveLength(3);
  const legacyLeg = oldAutomatic.find(
    (entry) => object(entry.settings)?.address === "legacy.example.com",
  );
  expect(
    oldAutomatic.find((entry) => entry.tag === object(legacyLeg?.proxySettings)?.tag)?.protocol,
  ).toBe("freedom");
});
