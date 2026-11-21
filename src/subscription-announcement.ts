import { type JsonObject, object } from "./json-value.ts";
import { isRejectedIssue, type SubscriptionReport } from "./subscription-diagnostics.ts";

const MAX_ANNOUNCEMENT_BYTES = 6000;
const REASONS: Readonly<Record<string, string>> = {
  "broken-outbound-chain": "цепочка подключений содержит отсутствующий узел или цикл",
  "empty-source": "источник вернул пустой ответ",
  "invalid-endpoint": "некорректный адрес сервера",
  "legacy-proxy-settings": "этот клиент не поддерживает устаревшую цепочку proxySettings",
  "missing-client-hwid": "клиент не передал HWID, обязательный для источника",
  "no-usable-nodes": "в ответе источника нет пригодных узлов",
  "provider-bound-profile": "профиль привязан к приложению провайдера",
  "provider-bound-subscription": "подписка привязана к приложению провайдера",
  "provider-rejected-hwid": "провайдер отклонил HWID устройства",
  "same-first-and-second-hop": "выбранный узел совпадает с EXIT2",
  "source-denied": "провайдер запретил доступ к подписке",
  "source-unavailable": "источник недоступен или вернул ошибку HTTP",
  "unapproved-source-redirect": "источник перенаправил запрос на недопустимый адрес",
  "unsupported-link": "формат ссылки не поддерживается",
};

export function diagnosticLines(report: SubscriptionReport): string[] {
  return report.sources.flatMap((source) => [
    ...(source.status === "failed"
      ? [
          `Источник «${source.id}» недоступен: ${reasonText(source.error ?? "source-or-profile-error")}.`,
        ]
      : []),
    ...source.issues
      .filter(isRejectedIssue)
      .map(
        (issue) =>
          `Источник «${source.id}», исключён узел «${issue.title}»: ${reasonText(issue.reason)}.`,
      ),
  ]);
}

export function subscriptionAnnouncement(
  lines: string[],
  profiles: JsonObject[],
): string | undefined {
  if (lines.length === 0) {
    return undefined;
  }
  const full = lines.join("\n");
  if (new TextEncoder().encode(full).length <= MAX_ANNOUNCEMENT_BYTES) {
    return encodeAnnouncement(full);
  }
  const location = storeDiagnostics(lines, profiles);
  const truncation =
    "\nОбъявление сокращено." +
    (location === "" ? "" : ` Полные причины: ${location} в профиле подписки.`);
  let shortened = "";
  for (const line of lines) {
    if (new TextEncoder().encode(shortened + line + truncation).length > MAX_ANNOUNCEMENT_BYTES) {
      break;
    }
    shortened += `${line}\n`;
  }
  return encodeAnnouncement(shortened.trimEnd() + truncation);
}

function encodeAnnouncement(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return `base64:${btoa(Array.from(bytes, (byte) => String.fromCodePoint(byte)).join(""))}`;
}

function reasonText(reason: string): string {
  const known = REASONS[reason];
  const explanation =
    known ??
    (reason.startsWith("unsupported-")
      ? "формат или параметр узла не поддерживается"
      : "данные источника или параметры узла некорректны");
  return `${explanation} (${reason})`;
}

function storeDiagnostics(lines: string[], profiles: JsonObject[]): string {
  const profile =
    profiles.find((item) => item.meta === undefined || object(item.meta) !== undefined) ??
    profiles[0];
  if (profile === undefined) {
    return "";
  }
  const metadata = object(profile.meta);
  const target = profile.meta === undefined || metadata !== undefined ? { ...metadata } : profile;
  let field = "cascadeDiagnostics";
  while (Object.hasOwn(target, field)) {
    field += "_";
  }
  target[field] = lines;
  if (target === profile) {
    return field;
  }
  profile.meta = target;
  return `meta.${field}`;
}
