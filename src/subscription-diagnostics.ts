import { type JsonObject, object, string } from "./json-value.ts";

export type NodeIssue = {
  stage: "client" | "compile" | "duplicate" | "informational" | "parse";
  title: string;
  reason: string;
};

export type SourceReport = {
  id: string;
  status: "failed" | "ok";
  input: null | number;
  compiled: number;
  returned: number;
  issues: NodeIssue[];
  error?: string;
};

export type SubscriptionReport = {
  createdAt: string;
  client: { userAgent: string; hwidProvided: boolean };
  sources: SourceReport[];
  summary: {
    returned: number;
    rejected: number;
    duplicates: number;
    informational: number;
    failedSources: number;
  };
};

export class SourceCompilationError extends Error {
  readonly input: number;
  readonly issues: NodeIssue[];

  constructor(issues: NodeIssue[], input: number) {
    super("no-usable-nodes");
    this.issues = issues;
    this.input = input;
  }
}

export function cachedIssues(value: JsonObject[string] | undefined): NodeIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const issues: NodeIssue[] = [];
  for (const raw of value) {
    const item = object(raw);
    const stage = string(item?.stage);
    if (
      stage !== "parse" &&
      stage !== "compile" &&
      stage !== "client" &&
      stage !== "duplicate" &&
      stage !== "informational"
    ) {
      continue;
    }
    const error = new Error(string(item?.reason) ?? "unknown-rejection");
    issues.push(nodeIssue(stage, item?.title, error));
  }
  return issues;
}

export function diagnosticReason(error: unknown): string {
  return error instanceof Error && /^[a-z][\da-z-]{1,79}$/u.test(error.message)
    ? error.message
    : "source-or-profile-error";
}

export function isInformationalPlaceholder(title: unknown, error: unknown): boolean {
  return (
    diagnosticReason(error) === "invalid-endpoint" &&
    typeof title === "string" &&
    /обходы\s+ниже|wi[\s‐‑–—-]*fi\s+сервера/iu.test(title)
  );
}

export function isRejectedIssue(issue: NodeIssue): boolean {
  return issue.stage !== "duplicate" && issue.stage !== "informational";
}

export function linkTitle(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).hash.slice(1)) || "Unnamed link";
  } catch {
    return "Unnamed link";
  }
}

export function nodeIssue(stage: NodeIssue["stage"], title: unknown, error: unknown): NodeIssue {
  const safeTitle = typeof title === "string" ? sanitizedTitle(title) : "Unnamed profile";
  return { stage, title: safeTitle || "Unnamed profile", reason: diagnosticReason(error) };
}

function sanitizedTitle(title: string): string {
  const words = title.slice(0, 160).split(/\s+/u);
  const redacted = words.map((word) => (word.includes("://") ? "[redacted-url]" : word)).join(" ");
  return Array.from(redacted, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}
