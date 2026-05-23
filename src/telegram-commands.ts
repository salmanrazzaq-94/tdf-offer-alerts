import { readEnv } from "./env.js";
import { fetchTdfOffersWithCookie } from "./tdf-fetch.js";
import { flattenOffers } from "./tdf.js";
import { readJsonFile, writeJsonFile } from "./json-file.js";
import {
  formatAuthFailureMessage,
  formatDigestSummary,
  formatOfferDetailsFile,
  sendTelegramDocument,
  sendTelegramMessage,
  timestampedDetailsFilename
} from "./telegram.js";

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat: {
      id: number;
    };
  };
};

type TelegramResponse = {
  ok: boolean;
  result?: TelegramUpdate[];
};

type TelegramState = {
  lastUpdateId: number;
};

const statePath = "data/telegram-state.json";

async function main(): Promise<void> {
  const env = readEnv();
  const telegram = { botToken: env.telegramBotToken, chatId: env.telegramChatId };
  const state = await readJsonFile<TelegramState>(statePath, { lastUpdateId: 0 });
  const updates = await getUpdates(env.telegramBotToken, state.lastUpdateId + 1);
  let lastUpdateId = state.lastUpdateId;

  for (const update of updates) {
    lastUpdateId = Math.max(lastUpdateId, update.update_id);
    const message = update.message;
    const text = message?.text?.trim().toLowerCase();
    if (!message || String(message.chat.id) !== env.telegramChatId || !text) {
      continue;
    }

    if (text === "/offers" || text === "/offers@tdf_alert_watcher_bot" || text === "offers") {
      await sendCurrentOffers(env, telegram);
      continue;
    }

    if (text === "/help" || text === "/start") {
      await sendTelegramMessage(telegram, "Send /offers to get the latest TDF availability.");
    }
  }

  if (lastUpdateId !== state.lastUpdateId) {
    await writeJsonFile<TelegramState>(statePath, { lastUpdateId });
  }
}

async function sendCurrentOffers(
  env: ReturnType<typeof readEnv>,
  telegram: { botToken: string; chatId: string }
): Promise<void> {
  try {
    const offers = await fetchTdfOffersWithCookie(env.tdfCookie);
    const items = flattenOffers(offers);
    await sendTelegramMessage(telegram, formatDigestSummary(offers, []));
    await sendTelegramDocument(
      telegram,
      timestampedDetailsFilename("tdf-offers-command"),
      formatOfferDetailsFile(offers, []),
      "Latest TDF availability details"
    );
    console.log(`Answered /offers with ${offers.length} shows and ${items.length} performances.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await sendTelegramMessage(telegram, formatAuthFailureMessage(reason));
    throw error;
  }
}

async function getUpdates(token: string, offset: number): Promise<TelegramUpdate[]> {
  const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("timeout", "0");
  url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Telegram getUpdates failed with ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as TelegramResponse;
  if (!body.ok) {
    throw new Error("Telegram getUpdates returned ok=false.");
  }

  return body.result ?? [];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
