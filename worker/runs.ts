import { newYorkHour, timestampedFilename } from "./formatters.js";
import { checkStaleHealth } from "./health.js";
import { addStep, appendLog, createRun, finishRun } from "./logging.js";
import { sendOfferNotification } from "./notifications.js";
import { handleCheckFailure } from "./recovery.js";
import {
  acquireDeltaLock,
  clearAuthState,
  normalizeCookie,
  persistRefreshedCookie,
  readCookie,
  readSeen,
  recordDeltaSuccess,
  releaseDeltaLock,
  saveCookie,
  writeSeen
} from "./state.js";
import { countPerformances, fetchTdfOffers, flattenOffers } from "./tdf.js";
import type { Env, RunLog } from "./types.js";
import { classifyError, errorMessage, escapeHtml } from "./utils.js";

export async function runDeltaCheck(env: Env, trigger: string): Promise<RunLog> {
  const run = createRun("delta", trigger);
  let notificationSent = false;
  let lock = { acquired: !trigger.startsWith("cron:"), owner: "manual" };

  try {
    if (trigger.startsWith("cron:")) {
      lock = await acquireDeltaLock(env, run);
    }
    if (!lock.acquired) {
      finishRun(run, "skipped", {
        message: "Another recent delta check is already running."
      });
      appendLog(run);
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
    await recordDeltaSuccess(env, run);
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
      try {
        await releaseDeltaLock(env, run);
      } catch (error) {
        addStep(run, "release-delta-lock", "failure", {
          message: errorMessage(error)
        });
        if (run.status === "success") {
          finishRun(run, "failure", {
            failureKind: "unexpected",
            message: `Failed to release delta lock: ${errorMessage(error)}`,
            notificationSent
          });
        }
      }
    }
  }

  appendLog(run);
  return run;
}

type CookieVerificationOptions = {
  persist?: boolean;
};

export async function runCookieVerification(
  env: Env,
  trigger: string,
  options: CookieVerificationOptions = {}
): Promise<RunLog> {
  const run = createRun("verify", trigger);
  const shouldPersist = options.persist !== false;
  try {
    const cookie = await readCookie(env, run);
    const result = await fetchTdfOffers(cookie, run);
    if (shouldPersist) {
      await persistRefreshedCookie(env, cookie, result.cookie, run);
    } else {
      addStep(run, "persist-refreshed-cookie", "skipped", {
        reason: "Read-only verification requested."
      });
    }
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
  appendLog(run);
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

  appendLog(run);
  return run;
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
    appendLog(run);
    return { message: `Saved. ${result.offers.length} shows available.`, status: 200 };
  } catch (error) {
    finishRun(run, "failure", {
      failureKind: classifyError(error),
      message: errorMessage(error)
    });
    appendLog(run);
    return { message: `Cookie did not work. ${escapeHtml(errorMessage(error))}`, status: 400 };
  }
}

export function appendDailyGuardSkip(trigger: string): RunLog {
  const run = createRun("daily", trigger);
  addStep(run, "new-york-9am-guard", "skipped", { newYorkHour: newYorkHour() });
  finishRun(run, "skipped", { message: "Not 9am America/New_York." });
  appendLog(run);
  return run;
}
