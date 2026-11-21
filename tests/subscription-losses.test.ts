import { expect, test } from "bun:test";

import { objects, parseJson } from "../src/json-value.ts";
import { parseSubscription } from "../src/subscription-format.ts";
import { createWorker } from "../src/worker.ts";
import { env, MAIN, request } from "./fixtures.ts";

test("preserves a Hysteria2 link's QUIC final mask", () => {
  const mask = { quicParams: { congestion: "bbr" } };
  const parsed = parseSubscription(
    `hysteria2://fixture-auth@hy.example.com:443?sni=hy.example.com&fm=${encodeURIComponent(JSON.stringify(mask))}#Germany`,
    "links",
  );
  expect(parsed.rejected).toBe(0);
  expect(parsed.profiles[0]?.outbounds).toMatchObject([
    { streamSettings: { finalmask: mask, network: "hysteria" } },
  ]);
});

test("keeps all three legitimate JSON profiles when their combined size exceeds 2 MiB", async () => {
  const profiles = [1, 2, 3].map((index) => ({
    meta: { providerData: "a".repeat(750_000) },
    outbounds: [{ ...MAIN, settings: { ...MAIN.settings, address: `node-${index}.example.com` } }],
    remarks: `Large profile ${index}`,
  }));
  const worker = createWorker({ fetcher: () => Promise.resolve(Response.json(profiles)) });
  const response = await worker.fetch(request(), env());
  expect(response.status).toBe(200);
  expect(response.headers.get("x-subscription-rejected")).toBe("0");
  expect(objects(parseJson(await response.text())).map((profile) => profile.remarks)).toEqual([
    "Large profile 1",
    "Large profile 2",
    "Large profile 3",
    "Все → EXIT2",
  ]);
});
