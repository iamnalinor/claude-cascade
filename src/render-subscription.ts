import { autoCascade } from "./auto-cascade.ts";
import { type SourceResults } from "./collect-sources.ts";
import { mergeSources } from "./compile-source.ts";
import { type ExitConfiguration } from "./exit-bridge.ts";
import { type JsonObject, objects } from "./json-value.ts";
import { isRejectedIssue, nodeIssue, type SubscriptionReport } from "./subscription-diagnostics.ts";

export function renderSubscription(
  results: SourceResults,
  request: Request,
  exit: ExitConfiguration,
): { profiles: JsonObject[]; report: SubscriptionReport } {
  const reports = new Map(results.reports.map((report) => [report.id, report]));
  const owners = new Map(
    results.compiled.flatMap((item) =>
      item.profiles.map((profile) => [profile, item.source] as const),
    ),
  );
  const merged = mergeSources(results.compiled, (item, profile) => {
    reports
      .get(item.source)
      ?.issues.push(nodeIssue("duplicate", profile.remarks, new Error("identical-runtime")));
  });
  const isLegacy = /^Throne\/1\.2\.4(?:$|[\s(/-])/iu.test(request.headers.get("user-agent") ?? "");
  const visible = merged.filter((profile) => {
    const owner = reports.get(owners.get(profile) ?? "");
    if (
      !isLegacy &&
      objects(profile.outbounds).some((outbound) => outbound.proxySettings !== undefined)
    ) {
      owner?.issues.push(nodeIssue("client", profile.remarks, new Error("legacy-proxy-settings")));
      return false;
    }
    if (owner !== undefined) {
      owner.returned++;
    }
    return true;
  });
  const automatic = autoCascade(merged, exit.bridge, {
    canUseLegacyProxy: isLegacy,
    ...(exit.via !== undefined && { via: exit.via }),
  });
  const issues = results.reports.flatMap((report) => report.issues);
  return {
    profiles: automatic === undefined ? visible : [...visible, automatic],
    report: {
      createdAt: new Date().toISOString(),
      client: {
        userAgent: request.headers.get("user-agent")?.slice(0, 160) ?? "",
        hwidProvided: request.headers.has("x-hwid"),
      },
      sources: results.reports,
      summary: {
        returned: visible.length,
        rejected: issues.filter(isRejectedIssue).length,
        duplicates: issues.filter((issue) => issue.stage === "duplicate").length,
        informational: issues.filter((issue) => issue.stage === "informational").length,
        failedSources: results.reports.filter((report) => report.status === "failed").length,
      },
    },
  };
}
