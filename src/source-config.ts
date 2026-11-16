import { z } from "zod";

const SECRET_NAME = /^[A-Z][A-Z_0-9]{0,47}$/u;
const SOURCE_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const IDENTITY_HEADERS = [
  "user-agent",
  "x-hwid",
  "x-device-os",
  "x-ver-os",
  "x-device-model",
] as const;
const optionalIdentity = [...IDENTITY_HEADERS, "installid", "x-install-id", "providerid"] as const;
const SOURCE_CONFIG = z.strictObject({
  authSecret: z.string().regex(SECRET_NAME).optional(),
  cache: z.boolean().default(false),
  format: z.enum(["auto", "base64", "links", "xray"]).default("auto"),
  id: z.string().regex(SOURCE_ID),
  identityHeaders: z
    .array(z.enum(optionalIdentity))
    .max(optionalIdentity.length)
    .default([...IDENTITY_HEADERS]),
  mainTag: z.string().min(1).optional(),
  requiresHwid: z.boolean().default(false),
  urlSecret: z.string().regex(SECRET_NAME),
});

export type Bindings = Record<string, unknown>;
export type Source = z.output<typeof SOURCE_CONFIG>;

export function sources(environment: Bindings): Source[] {
  const entries = z.array(SOURCE_CONFIG).min(1).max(10).parse(environment.SOURCES);
  if (new Set(entries.map((source) => source.id)).size !== entries.length) {
    throw new Error("duplicate-source");
  }
  return entries;
}

export function textBinding(environment: Bindings, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("missing-binding");
  }
  return value;
}
