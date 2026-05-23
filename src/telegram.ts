import type { AlertItem, TdfOffer } from "./tdf.js";

export type TelegramConfig = {
  botToken: string;
  chatId: string;
};

export async function sendTelegramMessage(
  config: TelegramConfig,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false
      })
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram send failed with ${response.status}: ${body}`);
  }
}

export async function sendTelegramDocument(
  config: TelegramConfig,
  filename: string,
  content: string,
  caption: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const formData = new FormData();
  formData.set("chat_id", config.chatId);
  formData.set("caption", caption);
  formData.set("parse_mode", "HTML");
  formData.set("document", new Blob([content], { type: "text/plain" }), filename);

  const response = await fetchImpl(
    `https://api.telegram.org/bot${config.botToken}/sendDocument`,
    {
      method: "POST",
      body: formData
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram document send failed with ${response.status}: ${body}`);
  }
}

export function formatDigestSummary(offers: TdfOffer[], newItems: AlertItem[]): string {
  const productionCount = offers.length;
  const performanceCount = offers.reduce((total, offer) => total + offer.performances.length, 0);
  const summary = offers
    .map((offer) => `- ${offer.title} (${offer.performances.length})`)
    .join("\n");

  return [
    `<b>TDF Offers Update</b>`,
    `${newItems.length} new performances. ${productionCount} shows, ${performanceCount} performances available.`,
    "",
    `<b>Available shows</b>`,
    escapeHtml(summary)
  ].join("\n");
}

export function formatOfferDetailsFile(offers: TdfOffer[], newItems: AlertItem[]): string {
  const lines = [
    "TDF OFFERS",
    `${offers.length} shows | ${offers.reduce((total, offer) => total + offer.performances.length, 0)} performances | ${newItems.length} new`,
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
      const marker = newItems.some((item) => item.id === id) ? "NEW " : "";
      lines.push(`${marker}${formatPerformanceDate(performance.performanceDate)}`);
    }
  }

  return lines.join("\n");
}

export function timestampedDetailsFilename(prefix: string, date = new Date()): string {
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

export function formatAuthFailureMessage(reason: string): string {
  return [
    "<b>TDF login needs attention</b>",
    "The scheduled checker could not access the authenticated TDF offers endpoint.",
    escapeHtml(reason),
    "Send /cookie to the Telegram bot and paste a fresh TDF cookie, then rerun the workflow."
  ].join("\n");
}

export function formatTransientFailureMessage(reason: string): string {
  return [
    "<b>TDF checker temporary failure</b>",
    "TDF or the GitHub runner returned a retryable error. The next scheduled run will try again.",
    escapeHtml(reason)
  ].join("\n");
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
