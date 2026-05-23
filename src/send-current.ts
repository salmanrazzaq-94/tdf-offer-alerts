import { readEnv } from "./env.js";
import { fetchTdfOffersWithCookie } from "./tdf-fetch.js";
import { flattenOffers } from "./tdf.js";
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
