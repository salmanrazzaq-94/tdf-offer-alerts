import { readEnv } from "./env.js";
import {
  findNewAlerts,
  flattenOffers,
  markSeen,
  parseTdfOffers,
  readSeenState,
  TDF_OFFERS_URL,
  TDF_PERFORMANCES_URL,
  writeSeenState
} from "./tdf.js";
import {
  formatAlertMessage,
  formatAuthFailureMessage,
  sendTelegramMessage
} from "./telegram.js";

async function main(): Promise<void> {
  const env = readEnv();

  try {
    const offers = await fetchTdfOffers(env.tdfCookie);
    const alertItems = flattenOffers(offers);
    const previousState = await readSeenState(env.seenStatePath);
    const newAlerts = findNewAlerts(alertItems, previousState);

    if (newAlerts.length === 0) {
      console.log(`Fetched ${alertItems.length} TDF performances. No new offers.`);
      return;
    }

    console.log(`Fetched ${alertItems.length} TDF performances. Sending ${newAlerts.length} alerts.`);
    for (const item of newAlerts) {
      await sendTelegramMessage(
        { botToken: env.telegramBotToken, chatId: env.telegramChatId },
        formatAlertMessage(item)
      );
    }

    await writeSeenState(env.seenStatePath, markSeen(previousState, newAlerts));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await notifyAuthFailure(reason);
    throw error;
  }
}

async function fetchTdfOffers(cookie: string) {
  const response = await fetch(TDF_PERFORMANCES_URL, {
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      Cookie: cookie,
      Referer: TDF_OFFERS_URL,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
      "X-Requested-With": "XMLHttpRequest"
    },
    signal: AbortSignal.timeout(60_000)
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`TDF performances endpoint returned ${response.status}: ${body.slice(0, 300)}`);
  }

  if (!contentType.includes("application/json")) {
    throw new Error(
      `TDF performances endpoint returned non-JSON content (${contentType}): ${body.slice(0, 300)}`
    );
  }

  const parsed = JSON.parse(body) as unknown;
  return parseTdfOffers(parsed);
}

async function notifyAuthFailure(reason: string): Promise<void> {
  const env = readEnv();
  try {
    await sendTelegramMessage(
      { botToken: env.telegramBotToken, chatId: env.telegramChatId },
      formatAuthFailureMessage(reason)
    );
  } catch (telegramError) {
    console.error("Could not send Telegram failure notice:", telegramError);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
