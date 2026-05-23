import type { AlertItem } from "./tdf.js";

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

export function formatAlertMessage(item: AlertItem): string {
  const date = formatPerformanceDate(item.performanceDate);
  const tags = [...item.promotions, ...item.categories].filter(Boolean);
  const tagsLine = tags.length > 0 ? `\n${escapeHtml(tags.join(" | "))}` : "";

  return [
    "<b>New TDF offer</b>",
    `<b>${escapeHtml(item.title)}</b>`,
    `${escapeHtml(item.facility)} - ${escapeHtml(date)}`,
    `Performance ID: ${item.performanceId}${tagsLine}`,
    item.thumbnail
  ].join("\n");
}

export function formatAuthFailureMessage(reason: string): string {
  return [
    "<b>TDF login needs attention</b>",
    "The scheduled checker could not access the authenticated TDF offers endpoint.",
    escapeHtml(reason),
    "Refresh the Browserbase persistent context by logging in manually, then rerun the workflow."
  ].join("\n");
}

function formatPerformanceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York"
  }).format(date);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
