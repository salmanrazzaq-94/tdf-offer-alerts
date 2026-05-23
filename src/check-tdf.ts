import { readEnv } from "./env.js";
import { readJsonFile, writeJsonFile } from "./json-file.js";
import { appendRunLog } from "./run-log.js";
import {
  findNewAlerts,
  flattenOffers,
  markSeen,
  readSeenState,
  writeSeenState
} from "./tdf.js";
import { fetchTdfOffersWithCookie, TdfFetchError, type TdfFetchErrorKind } from "./tdf-fetch.js";
import {
  formatAuthFailureMessage,
  formatDigestSummary,
  formatOfferDetailsFile,
  formatTransientFailureMessage,
  sendTelegramDocument,
  sendTelegramMessage,
  timestampedDetailsFilename
} from "./telegram.js";

type AuthState = {
  lastFailureNotifiedAt: string | null;
  lastFailureReason: string | null;
  lastFailureKind?: string | null;
};

const authStatePath = "data/auth-state.json";
const authFailureNotifyIntervalMs = 12 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const env = readEnv();

  try {
    const offers = await fetchTdfOffersWithCookie(env.tdfCookie);
    await writeJsonFile<AuthState>(authStatePath, {
      lastFailureNotifiedAt: null,
      lastFailureReason: null,
      lastFailureKind: null
    });

    const alertItems = flattenOffers(offers);
    const previousState = await readSeenState(env.seenStatePath);
    const newAlerts = findNewAlerts(alertItems, previousState);

    if (newAlerts.length === 0) {
      console.log(`Fetched ${alertItems.length} TDF performances. No new offers.`);
      await appendRunLog({
        event: "delta-check",
        status: "success",
        shows: offers.length,
        performances: alertItems.length,
        newPerformances: 0,
        notificationSent: false
      });
      return;
    }

    const telegram = { botToken: env.telegramBotToken, chatId: env.telegramChatId };
    const summary = formatDigestSummary(offers, newAlerts);
    const details = formatOfferDetailsFile(offers, newAlerts);
    console.log(
      `Fetched ${alertItems.length} TDF performances. Sending one summary and one details file for ${newAlerts.length} new performances.`
    );
    await sendTelegramMessage(telegram, summary);
    await sendTelegramDocument(
      telegram,
      timestampedDetailsFilename("tdf-offers-delta"),
      details,
      "Full TDF availability details"
    );

    await writeSeenState(env.seenStatePath, markSeen(previousState, newAlerts));
    await appendRunLog({
      event: "delta-check",
      status: "success",
      shows: offers.length,
      performances: alertItems.length,
      newPerformances: newAlerts.length,
      notificationSent: true
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await notifyFailure(reason, classifyFailure(error));
    throw error;
  }
}

async function notifyFailure(reason: string, kind: TdfFetchErrorKind): Promise<void> {
  const env = readEnv();
  const state = await readJsonFile<AuthState>(authStatePath, {
    lastFailureNotifiedAt: null,
    lastFailureReason: null,
    lastFailureKind: null
  });
  const lastNotifiedAt = state.lastFailureNotifiedAt
    ? new Date(state.lastFailureNotifiedAt).valueOf()
    : 0;
  const shouldNotify =
    state.lastFailureKind !== kind ||
    !lastNotifiedAt || Date.now() - lastNotifiedAt >= authFailureNotifyIntervalMs;

  await writeJsonFile<AuthState>(authStatePath, {
    lastFailureNotifiedAt: shouldNotify ? new Date().toISOString() : state.lastFailureNotifiedAt,
    lastFailureReason: reason,
    lastFailureKind: kind
  });
  await appendRunLog({
    event: "delta-check",
    status: "failure",
    failureKind: kind,
    message: reason,
    notificationSent: shouldNotify
  });

  if (!shouldNotify) {
    console.log("Skipping repeated TDF failure Telegram notification.");
    return;
  }

  try {
    await sendTelegramMessage(
      { botToken: env.telegramBotToken, chatId: env.telegramChatId },
      kind === "transient"
        ? formatTransientFailureMessage(reason)
        : formatAuthFailureMessage(reason)
    );
  } catch (telegramError) {
    console.error("Could not send Telegram failure notice:", telegramError);
  }
}

function classifyFailure(error: unknown): TdfFetchErrorKind {
  if (error instanceof TdfFetchError) {
    return error.kind;
  }

  if (error instanceof Error && /timeout|fetch failed/i.test(error.message)) {
    return "transient";
  }

  return "unexpected";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
