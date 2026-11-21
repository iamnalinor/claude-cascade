import { expect, test } from "bun:test";

import { object, objects, parseJson } from "../src/json-value.ts";
import { createWorker } from "../src/worker.ts";
import { env, LINK, request } from "./fixtures.ts";

test("imports all third-source nodes while ignoring the provider's routing header", async () => {
  const third = [1, 2, 3].map((index) =>
    LINK.replace("main.example.com", () => `third-${index}.example.com`).replace(
      "#Fixture",
      () => `#Third-${index}`,
    ),
  );
  const worker = createWorker({
    fetcher: (input) =>
      Promise.resolve(
        new URL(input instanceof Request ? input.url : input).hostname === "three.example.com"
          ? new Response(Buffer.from(third.join("\n")).toString("base64"), {
              headers: { routing: "happ://routing/provider-rules" },
            })
          : new Response(LINK),
      ),
  });
  const configured = env();
  const response = await worker.fetch(request(), {
    ...configured,
    SOURCES: [
      { id: "a", urlSecret: "UPSTREAM_A" },
      { id: "b", urlSecret: "UPSTREAM_B" },
      { id: "c", urlSecret: "UPSTREAM_C" },
    ],
    UPSTREAM_C: "https://three.example.com/secret-c",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-subscription-sources-failed")).toBe("0");
  expect(response.headers.has("routing")).toBe(false);
  const profiles = objects(parseJson(await response.text()));
  expect(profiles.map((profile) => profile.remarks)).toEqual([
    "Fixture",
    "Third-1",
    "Third-2",
    "Third-3",
    "Все → EXIT2",
  ]);
  const thirdProfile = profiles[1];
  expect(objects(object(thirdProfile?.routing)?.rules)[0]?.outboundTag).toBe("cascade-exit2");
});
