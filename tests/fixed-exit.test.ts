import { expect, test } from "bun:test";

import { object, objects, parseJson } from "../src/json-value.ts";
import { createWorker } from "../src/worker.ts";
import { BRIDGE, env, LINK, MAIN, request } from "./fixtures.ts";

const VIA = { ...MAIN, settings: { ...MAIN.settings, address: "fixed.example.com" } };

async function profilesFor(first = MAIN) {
  const worker = createWorker({
    fetcher: () => Promise.resolve(Response.json([{ remarks: "Entry", outbounds: [first] }])),
  });
  const response = await worker.fetch(request(), {
    ...env(),
    EXIT_VIA_OUTBOUND: JSON.stringify(VIA),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-subscription-rejected")).toBe("0");
  return objects(parseJson(await response.text()));
}

test("uses the fixed configured intermediate for individual and automatic profiles", async () => {
  const profiles = await profilesFor();
  expect(profiles).toHaveLength(2);
  for (const profile of profiles) {
    const outbounds = objects(profile.outbounds);
    const final = outbounds.find(
      (outbound) => JSON.stringify(outbound.settings) === JSON.stringify(BRIDGE.settings),
    );
    const intermediate = outbounds.find(
      (outbound) => JSON.stringify(outbound.settings) === JSON.stringify(VIA.settings),
    );
    expect(final).toBeDefined();
    expect(intermediate).toBeDefined();
    expect(object(object(final?.streamSettings)?.sockopt)?.dialerProxy).toBe(intermediate?.tag);
    const entryTag = object(object(intermediate?.streamSettings)?.sockopt)?.dialerProxy;
    expect(outbounds.find((outbound) => outbound.tag === entryTag)?.settings).toEqual(
      MAIN.settings,
    );
  }
});

test("keeps the full configured chain when the entry and intermediate have the same endpoint", async () => {
  const profiles = await profilesFor(VIA);
  expect(profiles).toHaveLength(2);
  for (const profile of profiles) {
    const outbounds = objects(profile.outbounds);
    const matches = outbounds.filter(
      (outbound) => JSON.stringify(outbound.settings) === JSON.stringify(VIA.settings),
    );
    expect(matches).toHaveLength(2);
    const final = outbounds.find(
      (outbound) => JSON.stringify(outbound.settings) === JSON.stringify(BRIDGE.settings),
    );
    expect(object(object(final?.streamSettings)?.sockopt)?.dialerProxy).toBe(matches[1]?.tag);
  }
});

test("rejects an intermediate containing an unresolved outbound reference", async () => {
  const worker = createWorker({ fetcher: () => Promise.resolve(new Response(LINK)) });
  const response = await worker.fetch(request(), {
    ...env(),
    EXIT_VIA_OUTBOUND: JSON.stringify({ ...VIA, proxySettings: { tag: "missing" } }),
  });
  expect(response.status).toBe(503);
});
