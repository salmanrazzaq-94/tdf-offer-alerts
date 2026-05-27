import type { AlertItem, BrowserbaseRefreshResult, DebugSnapshot, TdfOffer } from "./types.js";
import { countPerformances } from "./tdf.js";
import { escapeHtml, TdfError } from "./utils.js";

export function formatSummary(offers: TdfOffer[], items: AlertItem[]): string {
  const performances = countPerformances(offers);
  return [
    "<b>TDF Offers</b>",
    `${offers.length} shows, ${performances} performances available.`,
    items.length ? `${items.length} matching/new performances in this message.` : "",
    "",
    "<b>Available shows</b>",
    offers.map((offer) => `- ${escapeHtml(offer.title)} (${offer.performances.length})`).join("\n")
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatDetails(offers: TdfOffer[], newItems: AlertItem[]): string {
  const newIds = new Set(newItems.map((item) => item.id));
  const lines = [
    "TDF OFFERS",
    `${offers.length} shows | ${countPerformances(offers)} performances | ${newItems.length} new`,
    "",
    "SHOWS",
    ...offers.map((offer, index) => `${index + 1}. ${offer.title} (${offer.performances.length})`),
    "",
    "DETAILS"
  ];

  for (const offer of offers) {
    lines.push("");
    lines.push(offer.title);
    lines.push(offer.facility);
    for (const performance of offer.performances) {
      const id = `${offer.productionSeasonId}:${performance.performanceId}`;
      const marker = newIds.has(id) ? "NEW " : "";
      lines.push(`${marker}${formatPerformanceDate(performance.performanceDate)}`);
    }
  }

  return lines.join("\n");
}

export function formatStatus(snapshot: DebugSnapshot, offers: TdfOffer[]): string {
  const lastFailure = snapshot.lastFailure
    ? `${snapshot.lastFailure.finishedAt} (${snapshot.lastFailure.failureKind ?? "unknown"})`
    : "none";
  return [
    "<b>TDF Status</b>",
    `Cookie works now. ${offers.length} shows, ${countPerformances(offers)} performances available.`,
    `Cookie saved: ${snapshot.cookie.savedAt ?? "unknown"} (${snapshot.cookie.source ?? "unknown source"})`,
    `Last success: ${snapshot.health.lastDeltaSuccessAt ?? snapshot.lastSuccess?.finishedAt ?? "none"}`,
    `Last failure: ${escapeHtml(lastFailure)}`,
    `Browserbase refresh attempted: ${snapshot.auth.lastRefreshAttemptedAt ?? "none"}`,
    `Worker: ${escapeHtml(snapshot.version)}`
  ].join("\n");
}

export function formatFailureMessage(
  kind: TdfError["kind"],
  message: string,
  refreshResult: BrowserbaseRefreshResult
): string {
  if (kind === "transient") {
    return [
      "<b>TDF checker temporary failure</b>",
      "The next run will try again.",
      escapeHtml(message)
    ].join("\n");
  }

  if (kind === "auth" && refreshResult.status === "dispatch-failed") {
    return [
      "<b>TDF bot needs attention</b>",
      "Automatic TDF login recovery could not start.",
      "I could not trigger the Browserbase refresh workflow.",
      refreshResult.failureReason ? escapeHtml(refreshResult.failureReason) : "",
      escapeHtml(message)
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (kind === "auth") {
    return [
      "<b>TDF login needs attention</b>",
      "Saved cookie no longer works.",
      "Automatic recovery is not configured, so Salman needs to refresh the login.",
      escapeHtml(message)
    ].join("\n");
  }

  return [
    "<b>TDF checker failed</b>",
    "The saved TDF login may still be fine, but the checker hit an unexpected error.",
    escapeHtml(message)
  ].join("\n");
}

export function cookieForm(message: string): string {
  return `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TDF Cookie</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 32px auto; padding: 0 16px; }
    textarea { width: 100%; min-height: 220px; box-sizing: border-box; font-family: ui-monospace, monospace; }
    button { margin-top: 12px; padding: 10px 14px; }
    .message { color: #146c2e; font-weight: 700; }
  </style>
</head>
<body>
  <h1>TDF Cookie</h1>
  ${message ? `<p class="message">${escapeHtml(message)}</p>` : ""}
  <form method="post">
    <textarea name="cookie" placeholder="Paste full Cookie header here"></textarea>
    <button type="submit">Test and Save Cookie</button>
  </form>
</body>
</html>`;
}

export function timestampedFilename(prefix: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${prefix}-${value("year")}${value("month")}${value("day")}-${value("hour")}${value("minute")}-ny.txt`;
}

function formatPerformanceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York"
  }).format(date);
}

export function newYorkHour(date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false
  }).format(date);
}
