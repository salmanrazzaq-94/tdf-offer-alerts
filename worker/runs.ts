import { staleSuccessAlertAfterMs, workerVersion } from "./constants.js";
import {
  formatDebug,
  formatDetails,
  formatLogs,
  formatStatus,
  formatSummary,
  newYorkHour,
  timestampedFilename
} from "./formatters.js";
import { addStep, appendLog, createRun, finishRun, readLogs } from "./logging.js";
import { handleCheckFailure } from "./recovery.js";
import {
  acquireDeltaLock,
  clearAuthState,
  normalizeCookie,
  persistRefreshedCookie,
  readAuthState,
  readCookie,
  readCookieMeta,
  readHealthState,
  readSeen,
  releaseDeltaLock,
  saveCookie,
  writeSeen
} from "./state.js";
import { countPerformances, fetchTdfOffers, flattenOffers } from "./tdf.js";
import { sendDocument, sendMessage } from "./telegram.js";
import type { DebugSnapshot, Env, RunLog, TdfOffer } from "./types.js";
import { classifyError, errorMessage, escapeHtml } from "./utils.js";

export async function runDeltaCheck(env: Env, trigger: string): Promise<RunLog> {
  const run = createRun("delta", trigger);
  let notificationSent = false;
  const lock = trigger.startsWith("cron:") ? await acquireDeltaLock(env, run) : { acquired: true };

  try {
    if (!lock.acquired) {
      finishRun(run, "skipped", {
        message: "Another recent delta check is already running."
      });
      await appendLog(env, run);
      return run;
    }
    if (trigger.startsWith("cron:")) {
      await checkStaleHealth(env, run);
    }
    const cookie = await readCookie(env, run);
    const result = await fetchTdfOffers(cookie, run);
    await persistRefreshedCookie(env, cookie, result.cookie, run);
    const offers = result.offers;
    const items = flattenOffers(offers);
    const seenResult = await readSeen(env, run);
    const newItems = seenResult.recovered
      ? []
      : items.filter((item) => !seenResult.seen.has(item.id));
    addStep(run, "diff-offers", "success", {
      seenBefore: seenResult.seen.size,
      currentPerformances: items.length,
      newPerformances: newItems.length,
      recoveredSeenState: seenResult.recovered
    });

    if (newItems.length > 0) {
      notificationSent = await sendOfferNotification(
        env,
        run,
        offers,
        newItems,
        timestampedFilename("tdf-offers-delta"),
        "Full TDF availability details"
      );
    } else {
      addStep(run, "send-delta-alert", "skipped", {
        reason: seenResult.recovered
          ? "Seen state was recovered from the current TDF snapshot."
          : "No new performances."
      });
    }

    await writeSeen(env, new Set(items.map((item) => item.id)), run);

    await clearAuthState(env, run);
    finishRun(run, "success", {
      shows: offers.length,
      performances: items.length,
      newPerformances: newItems.length,
      notificationSent
    });
  } catch (error) {
    await handleCheckFailure(env, run, error);
  } finally {
    if (lock.acquired && trigger.startsWith("cron:")) {
      await releaseDeltaLock(env, run);
    }
  }

  await appendLog(env, run);
  return run;
}

export async function runCookieVerification(env: Env, trigger: string): Promise<RunLog> {
  const run = createRun("verify", trigger);
  try {
    const cookie = await readCookie(env, run);
    const result = await fetchTdfOffers(cookie, run);
    await persistRefreshedCookie(env, cookie, result.cookie, run);
    finishRun(run, "success", {
      shows: result.offers.length,
      performances: countPerformances(result.offers),
      message: "Saved TDF cookie works end to end."
    });
  } catch (error) {
    finishRun(run, "failure", {
      failureKind: classifyError(error),
      message: errorMessage(error)
    });
  }
  await appendLog(env, run);
  return run;
}

export async function runDailyDigest(env: Env, trigger: string): Promise<RunLog> {
  const run = createRun("daily", trigger);
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
      timestampedFilename("tdf-offers-current"),
      "Current TDF availability details"
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
  return run;
}

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

export async function runCookieFormSave(
  env: Env,
  form: FormData
): Promise<{ message: string; status: number }> {
  const run = createRun("cookie", "cookie-form");
  try {
    const cookieValue = form.get("cookie");
    const cookie = normalizeCookie(typeof cookieValue === "string" ? cookieValue : "");
    const result = await fetchTdfOffers(cookie, run);
    await saveCookie(env, result.cookie, "cookie-form", run);
    await clearAuthState(env, run);
    finishRun(run, "success", {
      shows: result.offers.length,
      performances: countPerformances(result.offers)
    });
    await appendLog(env, run);
    return { message: `Saved. ${result.offers.length} shows available.`, status: 200 };
  } catch (error) {
    finishRun(run, "failure", {
      failureKind: classifyError(error),
      message: errorMessage(error)
    });
    await appendLog(env, run);
    return { message: `Cookie did not work. ${escapeHtml(errorMessage(error))}`, status: 400 };
  }
}

export async function appendDailyGuardSkip(env: Env, trigger: string): Promise<RunLog> {
  const run = createRun("daily", trigger);
  addStep(run, "new-york-9am-guard", "skipped", { newYorkHour: newYorkHour() });
  finishRun(run, "skipped", { message: "Not 9am America/New_York." });
  await appendLog(env, run);
  return run;
}

export async function buildDebugSnapshot(env: Env): Promise<DebugSnapshot> {
  const [logs, cookie, auth, health] = await Promise.all([
    readLogs(env),
    readCookieMeta(env),
    readAuthState(env),
    readHealthState(env)
  ]);
  const lastRun = logs.at(-1) ?? null;
  const lastSuccess = [...logs].reverse().find((log) => log.status === "success") ?? null;
  const lastFailure = [...logs].reverse().find((log) => log.status === "failure") ?? null;
  return {
    version: workerVersion,
    generatedAt: new Date().toISOString(),
    cookie,
    auth,
    health,
    lastSuccess,
    lastFailure,
    lastRun,
    recentRuns: logs.slice(-10).map((log) => ({
      finishedAt: log.finishedAt,
      event: log.event,
      status: log.status,
      trigger: log.trigger,
      shows: log.shows,
      performances: log.performances,
      newPerformances: log.newPerformances,
      failureKind: log.failureKind,
      message: log.message
    }))
  };
}

async function sendOfferNotification(
  env: Env,
  run: RunLog,
  offers: TdfOffer[],
  items: Array<{ id: string; title: string; facility: string; performanceDate: string }>,
  filename: string,
  caption: string
): Promise<boolean> {
  const sendStarted = Date.now();
  try {
    await sendMessage(env, formatSummary(offers, items));
    addStep(run, "send-telegram-summary", "success", { durationMs: Date.now() - sendStarted });
  } catch (error) {
    addStep(run, "send-telegram-summary", "failure", {
      durationMs: Date.now() - sendStarted,
      message: errorMessage(error)
    });
    throw error;
  }

  const documentStarted = Date.now();
  try {
    await sendDocument(env, filename, formatDetails(offers, items), caption);
    addStep(run, "send-telegram-document", "success", {
      durationMs: Date.now() - documentStarted
    });
  } catch (error) {
    addStep(run, "send-telegram-document", "failure", {
      durationMs: Date.now() - documentStarted,
      message: errorMessage(error)
    });
  }

  return true;
}

async function checkStaleHealth(env: Env, run: RunLog): Promise<void> {
  const logs = await readLogs(env);
  const lastSuccess = [...logs]
    .reverse()
    .find((log) => log.event === "delta" && log.status === "success");
  if (!lastSuccess) {
    addStep(run, "stale-health-check", "skipped", { reason: "No previous successful delta run." });
    return;
  }

  const ageMs = Date.now() - new Date(lastSuccess.finishedAt).valueOf();
  if (ageMs < staleSuccessAlertAfterMs) {
    addStep(run, "stale-health-check", "success", {
      lastSuccessAt: lastSuccess.finishedAt,
      ageMs
    });
    return;
  }

  addStep(run, "stale-health-check", "failure", {
    lastSuccessAt: lastSuccess.finishedAt,
    ageMs,
    reason: "Previous successful delta run is stale."
  });
}
