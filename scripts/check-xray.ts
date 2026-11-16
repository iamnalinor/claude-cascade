import { type JsonObject, objects, parseJson } from "../src/json-value.ts";

function isValid(profile: JsonObject, binary: string): boolean {
  const result = Bun.spawnSync([binary, "run", "-test", "-config", "stdin:"], {
    stdin: Buffer.from(JSON.stringify(profile)),
    stderr: "pipe",
    stdout: "pipe",
  });
  return result.success;
}

const path = Bun.argv[2];
if (path === undefined) {
  console.error("Usage: XRAY_BIN=xray bun scripts/check-xray.ts subscription.json");
  process.exit(2);
}
try {
  const profiles = objects(parseJson(await Bun.file(path).text()));
  const invalid: number[] = [];
  for (const [index, profile] of profiles.entries()) {
    if (!isValid(profile, process.env.XRAY_BIN ?? "xray")) {
      invalid.push(index + 1);
    }
  }
  console.log(JSON.stringify({ invalid, valid: profiles.length - invalid.length }));
  if (profiles.length === 0 || invalid.length > 0) {
    process.exitCode = 1;
  }
} catch {
  console.error("Unable to read the subscription or invoke Xray");
  process.exitCode = 1;
}
