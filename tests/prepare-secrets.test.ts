import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BRIDGE } from "./fixtures.ts";

test("preserves the existing subscription token when preparing exit secrets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cascade-secrets-"));
  try {
    const local = path.join(directory, ".local");
    await mkdir(local, { mode: 0o700 });
    await writeFile(
      path.join(local, "upstreams.json"),
      JSON.stringify({ UPSTREAM_A: "https://fixture.example/sub" }),
    );
    await writeFile(
      path.join(local, "worker-secrets.json"),
      JSON.stringify({ SUB_ACCESS_TOKEN: "keep-existing-token" }),
    );
    await writeFile(path.join(directory, "bridge.json"), JSON.stringify(BRIDGE));
    const process = Bun.spawn(
      [
        Bun.which("bun") ?? "bun",
        "--no-env-file",
        path.resolve("scripts/prepare-secrets.ts"),
        "bridge.json",
      ],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    );
    expect(await process.exited).toBe(0);
    const secrets = JSON.parse(
      await readFile(path.join(local, "worker-secrets.json"), "utf8"),
    ) as Record<string, string>;
    expect(secrets.SUB_ACCESS_TOKEN).toBe("keep-existing-token");
    expect(secrets.EXIT_OUTBOUND).toBe(JSON.stringify(BRIDGE));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
