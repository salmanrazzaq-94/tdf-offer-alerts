import { readEnv } from "./env.js";
import {
  findNewAlerts,
  flattenOffers,
  markSeen,
  readSeenState,
  writeSeenState
} from "./tdf.js";
import { fetchTdfOffersWithCookie } from "./tdf-fetch.js";
import {
  formatAuthFailureMessage,
  formatDigestSummary,
  formatOfferDetailsFile,
  sendTelegramDocument,
  sendTelegramMessage
} from "./telegram.js";

async function main(): Promise<void> {
  const env = readEnv();

  try {
    const offers = await fetchTdfOffersWithCookie(env.tdfCookie);
    const alertItems = flattenOffers(offers);
    const previousState = await readSeenState(env.seenStatePath);
    const newAlerts = findNewAlerts(alertItems, previousState);

    if (newAlerts.length === 0) {
      console.log(`Fetched ${alertItems.length} TDF performances. No new offers.`);
      return;
    }

    const telegram = { botToken: env.telegramBotToken, chatId: env.telegramChatId };
    const summary = formatDigestSummary(offers, newAlerts);
    const details = formatOfferDetailsFile(offers, newAlerts);
    console.log(
      `Fetched ${alertItems.length} TDF performances. Sending one summary and one details file for ${newAlerts.length} new performances.`
    );
    await sendTelegramMessage(telegram, summary);
    await sendTelegramDocument(telegram, "tdf-offers.txt", details, "Full TDF availability details");

    await writeSeenState(env.seenStatePath, markSeen(previousState, newAlerts));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await notifyAuthFailure(reason);
    throw error;
  }
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
