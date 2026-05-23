import { readEnv } from "./env.js";
import { fetchTdfOffersWithCookie } from "./tdf-fetch.js";
import { flattenOffers } from "./tdf.js";
import { appendRunLog } from "./run-log.js";
import {
  formatDigestSummary,
  formatOfferDetailsFile,
  sendTelegramDocument,
  sendTelegramMessage,
  timestampedDetailsFilename
} from "./telegram.js";

async function main(): Promise<void> {
  const env = readEnv();
  const offers = await fetchTdfOffersWithCookie(env.tdfCookie);
  const items = flattenOffers(offers);
  const telegram = { botToken: env.telegramBotToken, chatId: env.telegramChatId };

  await sendTelegramMessage(telegram, formatDigestSummary(offers, items));
  await sendTelegramDocument(
    telegram,
    timestampedDetailsFilename("tdf-offers-current"),
    formatOfferDetailsFile(offers, []),
    "Current TDF availability details"
  );

  console.log(`Sent current digest for ${offers.length} shows and ${items.length} performances.`);
  await appendRunLog({
    event: "daily-current",
    status: "success",
    shows: offers.length,
    performances: items.length,
    notificationSent: true
  });
}

main().catch((error) => {
  console.error(error);
  const reason = error instanceof Error ? error.message : String(error);
  void appendRunLog({
    event: "daily-current",
    status: "failure",
    message: reason,
    notificationSent: false
  });
  process.exitCode = 1;
});
