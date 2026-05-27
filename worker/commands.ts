import { formatDebug, formatLogs, formatStatus, timestampedFilename } from "./formatters.js";
import { addStep, appendLog, createRun, finishRun, readLogs } from "./logging.js";
import { sendOfferNotification } from "./notifications.js";
import { handleCheckFailure } from "./recovery.js";
import { clearAuthState, persistRefreshedCookie, readCookie } from "./state.js";
import { countPerformances, fetchTdfOffers, flattenOffers } from "./tdf.js";
import { sendMessage } from "./telegram.js";
import type { Env } from "./types.js";
import { classifyError, errorMessage } from "./utils.js";
import { buildDebugSnapshot } from "./debug.js";

export async function runCommandOffers(env: Env): Promise<void> {
  const run = createRun("command", "telegram:/offers");
  try {
    const cookie = await readCookie(env, run);
    const result = await fetchTdfOffers(cookie, run);
    await persistRefreshedCookie(env, cookie, result.cookie, run);
    const offers = result.offers;
    const items = flattenOffers(offers);
    const notificationSent = await sendOfferNotification(
      env,
      run,
      offers,
      items,
      timestampedFilename("tdf-offers-command"),
      "Latest TDF availability details"
    );
    await clearAuthState(env, run);
    finishRun(run, "success", {
      shows: offers.length,
      performances: items.length,
      notificationSent
    });
  } catch (error) {
    await handleCheckFailure(env, run, error);
  }
  await appendLog(env, run);
}

export async function runStatus(env: Env): Promise<void> {
  const run = createRun("status", "telegram:/status");
  try {
    const cookie = await readCookie(env, run);
    const result = await fetchTdfOffers(cookie, run);
    await persistRefreshedCookie(env, cookie, result.cookie, run);
    const snapshot = await buildDebugSnapshot(env);
    const sendStarted = Date.now();
    await sendMessage(env, formatStatus(snapshot, result.offers));
    addStep(run, "send-telegram-status", "success", { durationMs: Date.now() - sendStarted });
    await clearAuthState(env, run);
    finishRun(run, "success", {
      shows: result.offers.length,
      performances: countPerformances(result.offers),
      notificationSent: true
    });
  } catch (error) {
    await handleCheckFailure(env, run, error);
  }
  await appendLog(env, run);
}

export async function runDebug(env: Env): Promise<void> {
  const run = createRun("debug", "telegram:/debug");
  try {
    const snapshot = await buildDebugSnapshot(env);
    await sendMessage(env, formatDebug(snapshot));
    addStep(run, "send-telegram-debug", "success");
    finishRun(run, "success", {
      notificationSent: true,
      message: "Debug snapshot sent."
    });
  } catch (error) {
    finishRun(run, "failure", {
      failureKind: classifyError(error),
      message: errorMessage(error)
    });
  }
  await appendLog(env, run);
}

export async function runLogs(env: Env): Promise<void> {
  const run = createRun("logs", "telegram:/logs");
  const logs = await readLogs(env);
  try {
    const sendStarted = Date.now();
    await sendMessage(env, formatLogs(logs.slice(-8)));
    addStep(run, "send-telegram-logs", "success", { durationMs: Date.now() - sendStarted });
    finishRun(run, "success", {
      notificationSent: true,
      message: `Sent ${Math.min(logs.length, 8)} recent run logs.`
    });
  } catch (error) {
    finishRun(run, "failure", {
      failureKind: classifyError(error),
      message: errorMessage(error)
    });
  }
  await appendLog(env, run);
}
