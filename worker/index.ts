type Env = {
  TDF_ALERTS: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  COOKIE_FORM_TOKEN: string;
  GITHUB_REFRESH_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_REFRESH_REF?: string;
};

type TelegramUpdate = {
  message?: {
    text?: string;
    chat: {
      id: number;
    };
  };
};

type TdfPerformance = {
  performanceId: number;
  performanceDate: string;
};

type TdfOffer = {
  productionSeasonId: number;
  title: string;
  facility: string;
  thumbnail?: string;
  performances: TdfPerformance[];
};

type TdfFetchResult = {
  offers: TdfOffer[];
  cookie: string;
};

type AlertItem = {
  id: string;
  title: string;
  facility: string;
  performanceDate: string;
};

type RunStep = {
  name: string;
  status: "success" | "failure" | "skipped";
  at: string;
  durationMs?: number;
  details?: Record<string, unknown>;
};

type RunLog = {
  id: string;
  event: "delta" | "daily" | "command" | "cookie" | "status" | "verify" | "debug" | "logs" | "refresh";
  status: "success" | "failure" | "skipped";
  trigger: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  version: string;
  shows?: number;
  performances?: number;
  newPerformances?: number;
  notificationSent?: boolean;
  failureKind?: "auth" | "transient" | "unexpected";
  message?: string;
  steps: RunStep[];
};

type AuthState = {
  lastFailureNotifiedAt: string | null;
  lastFailureKind: string | null;
  lastFailureReason: string | null;
  lastRefreshAttemptedAt: string | null;
  lastRefreshAttemptStatus: BrowserbaseRefreshResult["status"] | null;
};

type CookieMeta = {
  savedAt: string | null;
  source: string | null;
  cookieBytes: number;
  hasSessionCookie: boolean;
  hasTnewCookie: boolean;
};

type HealthState = {
  lastStaleNotifiedAt: string | null;
};

type BrowserbaseRefreshResult = {
  status: "started" | "throttled" | "not-auth" | "not-configured" | "dispatch-failed";
  attemptedAt?: string;
  failureReason?: string;
};

type DebugSnapshot = {
  version: string;
  generatedAt: string;
  cookie: CookieMeta;
  auth: AuthState;
  health: HealthState;
  lastSuccess: RunLog | null;
  lastFailure: RunLog | null;
  lastRun: RunLog | null;
  recentRuns: Array<{
    finishedAt: string;
    event: RunLog["event"];
    status: RunLog["status"];
    trigger: string;
    shows: number | undefined;
    performances: number | undefined;
    newPerformances: number | undefined;
    failureKind: RunLog["failureKind"] | undefined;
    message: string | undefined;
  }>;
};

const cookieKey = "TDF_COOKIE";
const cookieMetaKey = "TDF_COOKIE_META";
const seenKey = "SEEN_OFFERS";
const logsKey = "RUN_LOGS";
const authStateKey = "AUTH_STATE";
const healthStateKey = "HEALTH_STATE";
const deltaLockKey = "DELTA_LOCK";
const workerVersion = "2026-05-27.production-hardening-v1";
const tdfOffersUrl = "https://nycgw47.tdf.org/TDFCustomOfferings/Current";
const tdfPerformancesUrl = "https://nycgw47.tdf.org/TDFCustomOfferings/Current?handler=Performances";
const tdfMemberHomeUrl = "https://my.tdf.org/";
const authFailureNotifyIntervalMs = 12 * 60 * 60 * 1000;
const browserbaseRefreshAttemptIntervalMs = 6 * 60 * 60 * 1000;
const browserbaseDispatchFailureRetryMs = 30 * 60 * 1000;
const staleSuccessAlertAfterMs = 30 * 60 * 1000;
const deltaLockTtlMs = 8 * 60 * 1000;
const maxLogs = 200;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/logs") {
      if (!isAuthorized(url, env)) {
        return new Response("Not found", { status: 404 });
      }
      return json(await readLogs(env));
    }

    if (request.method === "GET" && url.pathname === "/debug") {
      if (!isAuthorized(url, env)) {
        return new Response("Not found", { status: 404 });
      }
      return json(await buildDebugSnapshot(env));
    }

    if (request.method === "GET" && url.pathname === "/verify-cookie") {
      if (!isAuthorized(url, env)) {
        return new Response("Not found", { status: 404 });
      }
      const result = await runCookieVerification(env, "manual-http");
      return json(result);
    }

    if (request.method === "GET" && url.pathname === "/run-delta") {
      if (!isAuthorized(url, env)) {
        return new Response("Not found", { status: 404 });
      }
      const result = await runDeltaCheck(env, "manual-http");
      return json(result);
    }

    if (request.method === "GET" && url.pathname === "/run-daily") {
      if (!isAuthorized(url, env)) {
        return new Response("Not found", { status: 404 });
      }
      const result = await runDailyDigest(env, "manual-http");
      return json(result);
    }

    if (request.method === "POST" && url.pathname === "/refresh-failed") {
      if (!isAuthorized(url, env)) {
        return new Response("Not found", { status: 404 });
      }
      const result = await recordBrowserbaseRefreshFailure(request, env);
      return json(result);
    }

    if (request.method === "GET" && url.pathname === "/cookie") {
      if (!isAuthorized(url, env)) {
        return new Response("Not found", { status: 404 });
      }
      return html(cookieForm(""));
    }

    if (request.method === "POST" && url.pathname === "/cookie") {
      if (!isAuthorized(url, env)) {
        return new Response("Not found", { status: 404 });
      }
      const form = await request.formData();
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
        return html(cookieForm(`Saved. ${result.offers.length} shows available.`));
      } catch (error) {
        finishRun(run, "failure", {
          failureKind: classifyError(error),
          message: errorMessage(error)
        });
        await appendLog(env, run);
        return html(cookieForm(`Cookie did not work. ${escapeHtml(errorMessage(error))}`), 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      const update: TelegramUpdate = await request.json();
      ctx.waitUntil(handleTelegram(update, env, request.url));
      return json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === "0 13 * * *" || controller.cron === "0 14 * * *") {
      if (newYorkHour() === "09") {
        await runDailyDigest(env, `cron:${controller.cron}`);
      } else {
        const run = createRun("daily", `cron:${controller.cron}`);
        addStep(run, "new-york-9am-guard", "skipped", { newYorkHour: newYorkHour() });
        finishRun(run, "skipped", { message: "Not 9am America/New_York." });
        await appendLog(env, run);
      }
      return;
    }

    await runDeltaCheck(env, `cron:${controller.cron}`);
  }
};

async function handleTelegram(update: TelegramUpdate, env: Env, requestUrl: string): Promise<void> {
  const message = update.message;
  const text = message?.text?.trim().toLowerCase();
  if (!message || String(message.chat.id) !== env.TELEGRAM_CHAT_ID || !text) {
    return;
  }

  if (text === "/cookie" || text === "/cookie@tdf_alert_watcher_bot") {
    const url = new URL("/cookie", requestUrl);
    url.searchParams.set("token", env.COOKIE_FORM_TOKEN);
    await sendMessage(env, `Paste a fresh TDF cookie here:\n${url.toString()}`);
    return;
  }

  if (text === "/offers" || text === "/offers@tdf_alert_watcher_bot" || text === "offers") {
    await runCommandOffers(env);
    return;
  }

  if (text === "/status" || text === "/status@tdf_alert_watcher_bot") {
    await runStatus(env);
    return;
  }

  if (text === "/debug" || text === "/debug@tdf_alert_watcher_bot") {
    await runDebug(env);
    return;
  }

  if (text === "/logs" || text === "/logs@tdf_alert_watcher_bot") {
    await runLogs(env);
    return;
  }

  if (text === "/help" || text === "/start") {
    await sendMessage(env, "Commands: /offers, /status, /debug, /logs, /cookie");
  }
}

async function runDeltaCheck(env: Env, trigger: string): Promise<RunLog> {
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

async function runCookieVerification(env: Env, trigger: string): Promise<RunLog> {
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

async function runDailyDigest(env: Env, trigger: string): Promise<RunLog> {
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

async function runCommandOffers(env: Env): Promise<void> {
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

async function runStatus(env: Env): Promise<void> {
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

async function runDebug(env: Env): Promise<void> {
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

async function runLogs(env: Env): Promise<void> {
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

async function handleCheckFailure(env: Env, run: RunLog, error: unknown): Promise<void> {
  const kind = classifyError(error);
  const message = errorMessage(error);
  const state = await readAuthState(env);
  const lastNotifiedAt = state.lastFailureNotifiedAt
    ? new Date(state.lastFailureNotifiedAt).valueOf()
    : 0;
  const shouldNotify =
    state.lastFailureKind !== kind ||
    !lastNotifiedAt ||
    Date.now() - lastNotifiedAt >= authFailureNotifyIntervalMs;
  const refreshResult = await maybeTriggerBrowserbaseRefresh(env, run, state, kind, message);
  const suppressNotification =
    kind === "auth" &&
    (refreshResult.status === "started" || refreshResult.status === "throttled");
  const notifyNow = shouldNotify && !suppressNotification;

  await env.TDF_ALERTS.put(
    authStateKey,
    JSON.stringify({
      lastFailureNotifiedAt: notifyNow ? new Date().toISOString() : state.lastFailureNotifiedAt,
      lastFailureKind: kind,
      lastFailureReason: message,
      lastRefreshAttemptedAt: refreshResult.attemptedAt ?? state.lastRefreshAttemptedAt,
      lastRefreshAttemptStatus: refreshResult.status
    })
  );
  addStep(run, "failure-notification-throttle", "success", {
    shouldNotify,
    notifyNow,
    suppressNotification,
    browserbaseRefreshStatus: refreshResult.status,
    lastFailureKind: state.lastFailureKind,
    lastFailureNotifiedAt: state.lastFailureNotifiedAt
  });

  if (notifyNow) {
    const sendStarted = Date.now();
    try {
      await sendMessage(env, formatFailureMessage(kind, message, refreshResult));
      addStep(run, "send-telegram-failure", "success", { durationMs: Date.now() - sendStarted });
    } catch (notifyError) {
      addStep(run, "send-telegram-failure", "failure", {
        durationMs: Date.now() - sendStarted,
        message: errorMessage(notifyError)
      });
    }
  } else {
    addStep(run, "send-telegram-failure", "skipped", {
      reason: suppressNotification
        ? "Automatic Browserbase recovery is handling this auth failure."
        : "Repeated failure notification is throttled."
    });
  }

  finishRun(run, "failure", {
    failureKind: kind,
    message,
    notificationSent: run.steps.some((step) => step.name === "send-telegram-failure" && step.status === "success")
  });
}

async function recordBrowserbaseRefreshFailure(request: Request, env: Env): Promise<RunLog> {
  const run = createRun("refresh", "github:refresh-cookie");
  const details = await readRefreshFailureDetails(request);
  const reason = details["reason"] || "Browserbase refresh workflow failed.";
  const sourceRunId = details["source_run_id"] || details["sourceRunId"];
  const state = await readAuthState(env);
  const lastNotifiedAt = state.lastFailureNotifiedAt
    ? new Date(state.lastFailureNotifiedAt).valueOf()
    : 0;
  const shouldNotify =
    state.lastFailureKind !== "auth" ||
    state.lastFailureReason !== reason ||
    !lastNotifiedAt ||
    Date.now() - lastNotifiedAt >= authFailureNotifyIntervalMs;

  await env.TDF_ALERTS.put(
    authStateKey,
    JSON.stringify({
      lastFailureNotifiedAt: shouldNotify ? new Date().toISOString() : state.lastFailureNotifiedAt,
      lastFailureKind: "auth",
      lastFailureReason: reason,
      lastRefreshAttemptedAt: state.lastRefreshAttemptedAt,
      lastRefreshAttemptStatus: state.lastRefreshAttemptStatus
    } satisfies AuthState)
  );

  if (shouldNotify) {
    const sendStarted = Date.now();
    await sendMessage(
      env,
      [
        "<b>Browserbase refresh failed</b>",
        "Automatic TDF login recovery did not complete.",
        escapeHtml(reason),
        sourceRunId ? `source=${escapeHtml(sourceRunId)}` : "",
        "Send /cookie to paste a fresh TDF cookie."
      ]
        .filter(Boolean)
        .join("\n")
    );
    addStep(run, "send-browserbase-refresh-failed", "success", {
      durationMs: Date.now() - sendStarted,
      sourceRunId
    });
  } else {
    addStep(run, "send-browserbase-refresh-failed", "skipped", {
      reason: "Repeated Browserbase failure notification is throttled.",
      sourceRunId,
      lastFailureNotifiedAt: state.lastFailureNotifiedAt
    });
  }

  finishRun(run, "failure", {
    failureKind: "auth",
    message: reason,
    notificationSent: shouldNotify
  });
  await appendLog(env, run);
  return run;
}

async function readRefreshFailureDetails(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed: Record<string, unknown> = await request.json();
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [
        key,
        typeof value === "string" ? value : String(value)
      ])
    );
  }

  const form = await request.formData();
  return Object.fromEntries(
    [...form.entries()].map(([key, value]) => [
      key,
      typeof value === "string" ? value : value.name
    ])
  );
}

async function readCookie(env: Env, run: RunLog): Promise<string> {
  const started = Date.now();
  const cookie = await env.TDF_ALERTS.get(cookieKey);
  if (!cookie) {
    addStep(run, "read-cookie", "failure", { durationMs: Date.now() - started });
    throw new TdfError("No TDF cookie saved in Cloudflare KV.", "auth");
  }
  addStep(run, "read-cookie", "success", {
    durationMs: Date.now() - started,
    cookieBytes: cookie.length,
    hasSessionCookie: cookie.includes(".TDFCustomOfferings.Session"),
    hasTnewCookie: cookie.includes("TNEW")
  });
  return cookie;
}

async function fetchTdfOffers(cookie: string, run: RunLog): Promise<TdfFetchResult> {
  let activeCookie = await refreshTdfMemberSession(cookie, run);
  activeCookie = await touchTdfMainPage(activeCookie, run);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(tdfPerformancesUrl, {
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/json",
          Cookie: activeCookie,
          Referer: tdfOffersUrl,
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
          "X-Requested-With": "XMLHttpRequest"
        }
      });
      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();
      const details = {
        attempt,
        status: response.status,
        contentType,
        bodyBytes: body.length,
        durationMs: Date.now() - started
      };

      if (!response.ok) {
        addStep(run, "fetch-tdf-performances", "failure", details);
        throw new TdfError(`TDF returned ${response.status}: ${body.slice(0, 200)}`, classifyStatus(response.status));
      }
      if (!contentType.includes("application/json")) {
        addStep(run, "fetch-tdf-performances", "failure", {
          ...details,
          bodyPreview: body.slice(0, 200)
        });
        throw new TdfError(
          `TDF returned non-JSON content (${contentType}): ${body.slice(0, 200)}`,
          looksLikeAuthFailure(body) ? "auth" : "unexpected"
        );
      }

      const parsed = JSON.parse(body) as unknown;
      const offers = parseOffers(parsed);
      addStep(run, "fetch-tdf-performances", "success", {
        ...details,
        shows: offers.length,
        performances: countPerformances(offers)
      });
      return { offers, cookie: activeCookie };
    } catch (error) {
      lastError = error;
      if (attempt < 3 && classifyError(error) === "transient") {
        addStep(run, "fetch-tdf-retry-wait", "success", { attempt, waitMs: attempt * 1000 });
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

async function refreshTdfMemberSession(cookie: string, run: RunLog): Promise<string> {
  const started = Date.now();
  const response = await fetch(tdfMemberHomeUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"
    }
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  const setCookies = getSetCookieHeaders(response);
  const setCookieNames = setCookies.map((value) => value.split("=", 1)[0]).filter(Boolean);
  const details = {
    status: response.status,
    finalUrl: response.url,
    contentType,
    bodyBytes: body.length,
    durationMs: Date.now() - started,
    setCookieCount: setCookies.length,
    setCookieNames
  };

  if (response.url.includes("/account/login")) {
    addStep(run, "refresh-tdf-member-session", "failure", details);
    throw new TdfError(`TDF member page redirected to login: ${response.url}`, "auth");
  }

  if (!response.ok) {
    addStep(run, "refresh-tdf-member-session", "failure", details);
    return cookie;
  }

  addStep(run, "refresh-tdf-member-session", "success", details);
  return mergeSetCookies(cookie, setCookies);
}

async function touchTdfMainPage(cookie: string, run: RunLog): Promise<string> {
  const started = Date.now();
  const response = await fetch(tdfOffersUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"
    }
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  const setCookies = getSetCookieHeaders(response);
  const setCookieNames = setCookies.map((value) => value.split("=", 1)[0]).filter(Boolean);
  const authenticated = /logged\s+in\s+as|log\s*out|current offers/i.test(body);
  const details = {
    status: response.status,
    finalUrl: response.url,
    contentType,
    bodyBytes: body.length,
    durationMs: Date.now() - started,
    authenticatedSignals: authenticated,
    setCookieCount: setCookies.length,
    setCookieNames
  };

  if (response.url.includes("/account/login") || response.url.includes("my.tdf.org/account")) {
    addStep(run, "touch-tdf-main-page", "failure", details);
    throw new TdfError(`TDF main page redirected to login: ${response.url}`, "auth");
  }
  if (!response.ok) {
    addStep(run, "touch-tdf-main-page", "failure", details);
    throw new TdfError(`TDF main page returned ${response.status}: ${body.slice(0, 200)}`, classifyStatus(response.status));
  }
  if (looksLikeAuthFailure(body) && !authenticated) {
    addStep(run, "touch-tdf-main-page", "failure", {
      ...details,
      bodyPreview: body.slice(0, 200)
    });
    throw new TdfError("TDF main page showed a login or access challenge.", "auth");
  }

  addStep(run, "touch-tdf-main-page", "success", details);
  return mergeSetCookies(cookie, setCookies);
}

async function persistRefreshedCookie(
  env: Env,
  originalCookie: string,
  refreshedCookie: string,
  run: RunLog
): Promise<void> {
  if (originalCookie === refreshedCookie) {
    addStep(run, "persist-refreshed-cookie", "skipped", {
      reason: "TDF did not send updated cookie values."
    });
    return;
  }

  const started = Date.now();
  await saveCookie(env, refreshedCookie, "tdf-set-cookie", run, started);
  addStep(run, "persist-refreshed-cookie", "success", {
    durationMs: Date.now() - started,
    oldCookieBytes: originalCookie.length,
    newCookieBytes: refreshedCookie.length
  });
}

async function saveCookie(
  env: Env,
  cookie: string,
  source: string,
  run?: RunLog,
  started = Date.now()
): Promise<void> {
  await env.TDF_ALERTS.put(cookieKey, cookie);
  await env.TDF_ALERTS.put(
    cookieMetaKey,
    JSON.stringify({
      savedAt: new Date().toISOString(),
      source,
      cookieBytes: cookie.length,
      hasSessionCookie: cookie.includes(".TDFCustomOfferings.Session"),
      hasTnewCookie: cookie.includes("TNEW")
    } satisfies CookieMeta)
  );
  if (run && source !== "tdf-set-cookie") {
    addStep(run, "save-cookie", "success", {
      durationMs: Date.now() - started,
      source,
      cookieBytes: cookie.length
    });
  }
}

async function readCookieMeta(env: Env): Promise<CookieMeta> {
  const raw = await env.TDF_ALERTS.get(cookieMetaKey);
  if (!raw) {
    const cookie = await env.TDF_ALERTS.get(cookieKey);
    return {
      savedAt: null,
      source: null,
      cookieBytes: cookie?.length ?? 0,
      hasSessionCookie: cookie?.includes(".TDFCustomOfferings.Session") ?? false,
      hasTnewCookie: cookie?.includes("TNEW") ?? false
    };
  }
  let parsed: Partial<CookieMeta>;
  try {
    parsed = JSON.parse(raw) as Partial<CookieMeta>;
  } catch {
    parsed = {};
  }
  return {
    savedAt: parsed.savedAt ?? null,
    source: parsed.source ?? null,
    cookieBytes: parsed.cookieBytes ?? 0,
    hasSessionCookie: parsed.hasSessionCookie ?? false,
    hasTnewCookie: parsed.hasTnewCookie ?? false
  };
}

async function sendOfferNotification(
  env: Env,
  run: RunLog,
  offers: TdfOffer[],
  items: AlertItem[],
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

async function readSeen(
  env: Env,
  run: RunLog
): Promise<{ seen: Set<string>; recovered: boolean }> {
  const started = Date.now();
  const raw = await env.TDF_ALERTS.get(seenKey);
  if (!raw) {
    addStep(run, "read-seen-state", "success", {
      durationMs: Date.now() - started,
      seenCount: 0,
      recovered: false
    });
    return { seen: new Set<string>(), recovered: false };
  }

  let seen: Set<string>;
  try {
    seen = parseSeen(raw);
  } catch (error) {
    addStep(run, "read-seen-state", "failure", {
      durationMs: Date.now() - started,
      message: errorMessage(error),
      recovered: true
    });
    return { seen: new Set<string>(), recovered: true };
  }

  addStep(run, "read-seen-state", "success", {
    durationMs: Date.now() - started,
    seenCount: seen.size,
    recovered: false
  });
  return { seen, recovered: false };
}

async function writeSeen(env: Env, seen: Set<string>, run: RunLog): Promise<void> {
  const started = Date.now();
  await env.TDF_ALERTS.put(seenKey, JSON.stringify([...seen].sort()));
  addStep(run, "write-seen-state", "success", {
    durationMs: Date.now() - started,
    seenCount: seen.size
  });
}

async function readAuthState(env: Env): Promise<AuthState> {
  const raw = await env.TDF_ALERTS.get(authStateKey);
  if (!raw) {
    return {
      lastFailureNotifiedAt: null,
      lastFailureKind: null,
      lastFailureReason: null,
      lastRefreshAttemptedAt: null,
      lastRefreshAttemptStatus: null
    };
  }
  let parsed: Partial<AuthState>;
  try {
    parsed = JSON.parse(raw) as Partial<AuthState>;
  } catch {
    parsed = {};
  }
  return {
    lastFailureNotifiedAt: parsed.lastFailureNotifiedAt ?? null,
    lastFailureKind: parsed.lastFailureKind ?? null,
    lastFailureReason: parsed.lastFailureReason ?? null,
    lastRefreshAttemptedAt: parsed.lastRefreshAttemptedAt ?? null,
    lastRefreshAttemptStatus: parsed.lastRefreshAttemptStatus ?? null
  };
}

async function clearAuthState(env: Env, run: RunLog): Promise<void> {
  await env.TDF_ALERTS.put(
    authStateKey,
    JSON.stringify({
      lastFailureNotifiedAt: null,
      lastFailureKind: null,
      lastFailureReason: null,
      lastRefreshAttemptedAt: null,
      lastRefreshAttemptStatus: null
    })
  );
  addStep(run, "clear-auth-state", "success");
}

async function maybeTriggerBrowserbaseRefresh(
  env: Env,
  run: RunLog,
  state: AuthState,
  kind: TdfError["kind"],
  reason: string
): Promise<BrowserbaseRefreshResult> {
  if (kind !== "auth") {
    addStep(run, "browserbase-refresh-dispatch", "skipped", {
      reason: "Only auth failures can trigger Browserbase refresh."
    });
    return { status: "not-auth" };
  }

  if (!env.GITHUB_REFRESH_TOKEN || !env.GITHUB_REPOSITORY) {
    addStep(run, "browserbase-refresh-dispatch", "skipped", {
      reason: "GITHUB_REFRESH_TOKEN or GITHUB_REPOSITORY is not configured."
    });
    return { status: "not-configured" };
  }

  const lastAttemptedAt = state.lastRefreshAttemptedAt
    ? new Date(state.lastRefreshAttemptedAt).valueOf()
    : 0;
  const throttleMs =
    state.lastRefreshAttemptStatus === "dispatch-failed"
      ? browserbaseDispatchFailureRetryMs
      : browserbaseRefreshAttemptIntervalMs;
  if (lastAttemptedAt && Date.now() - lastAttemptedAt < throttleMs) {
    addStep(run, "browserbase-refresh-dispatch", "skipped", {
      reason: "Recent Browserbase refresh attempt is still inside throttle window.",
      lastRefreshAttemptedAt: state.lastRefreshAttemptedAt,
      lastRefreshAttemptStatus: state.lastRefreshAttemptStatus,
      throttleMs
    });
    return { status: "throttled" };
  }

  const started = Date.now();
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/refresh-cookie.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_REFRESH_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "tdf-alerts-worker"
      },
      body: JSON.stringify({
        ref: env.GITHUB_REFRESH_REF ?? "main",
        inputs: {
          reason: reason.slice(0, 200),
          source_run_id: run.id
        }
      })
    }
  );

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    const attemptedAt = new Date().toISOString();
    addStep(run, "browserbase-refresh-dispatch", "failure", {
      durationMs: Date.now() - started,
      status: response.status,
      body,
      lastRefreshAttemptedAt: attemptedAt
    });
    return {
      status: "dispatch-failed",
      attemptedAt,
      failureReason: `GitHub dispatch returned ${response.status}: ${body}`
    };
  }

  const attemptedAt = new Date().toISOString();
  addStep(run, "browserbase-refresh-dispatch", "success", {
    durationMs: Date.now() - started,
    repository: env.GITHUB_REPOSITORY,
    ref: env.GITHUB_REFRESH_REF ?? "main",
    lastRefreshAttemptedAt: attemptedAt
  });

  return { status: "started", attemptedAt };
}

async function acquireDeltaLock(env: Env, run: RunLog): Promise<{ acquired: boolean; owner: string }> {
  const started = Date.now();
  const raw = await env.TDF_ALERTS.get(deltaLockKey);
  if (raw) {
    let lock: { owner?: string; acquiredAt?: string };
    try {
      lock = JSON.parse(raw) as { owner?: string; acquiredAt?: string };
    } catch (error) {
      addStep(run, "read-delta-lock", "failure", {
        durationMs: Date.now() - started,
        message: errorMessage(error),
        recovered: true
      });
      lock = {};
    }
    const acquiredAt = lock.acquiredAt ? new Date(lock.acquiredAt).valueOf() : 0;
    if (acquiredAt && Date.now() - acquiredAt < deltaLockTtlMs) {
      addStep(run, "acquire-delta-lock", "skipped", {
        durationMs: Date.now() - started,
        owner: lock.owner,
        acquiredAt: lock.acquiredAt,
        ageMs: Date.now() - acquiredAt
      });
      return { acquired: false, owner: lock.owner ?? "unknown" };
    }
  }

  await env.TDF_ALERTS.put(
    deltaLockKey,
    JSON.stringify({
      owner: run.id,
      acquiredAt: new Date().toISOString()
    })
  );
  addStep(run, "acquire-delta-lock", "success", {
    durationMs: Date.now() - started,
    owner: run.id
  });
  return { acquired: true, owner: run.id };
}

async function releaseDeltaLock(env: Env, run: RunLog): Promise<void> {
  const started = Date.now();
  await env.TDF_ALERTS.delete(deltaLockKey);
  addStep(run, "release-delta-lock", "success", { durationMs: Date.now() - started });
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

async function readHealthState(env: Env): Promise<HealthState> {
  const raw = await env.TDF_ALERTS.get(healthStateKey);
  if (!raw) {
    return { lastStaleNotifiedAt: null };
  }
  let parsed: Partial<HealthState>;
  try {
    parsed = JSON.parse(raw) as Partial<HealthState>;
  } catch {
    parsed = {};
  }
  return { lastStaleNotifiedAt: parsed.lastStaleNotifiedAt ?? null };
}

async function buildDebugSnapshot(env: Env): Promise<DebugSnapshot> {
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

async function readLogs(env: Env): Promise<RunLog[]> {
  const raw = await env.TDF_ALERTS.get(logsKey);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as RunLog[]) : [];
  } catch {
    return [];
  }
}

async function appendLog(env: Env, run: RunLog): Promise<void> {
  const logs = await readLogs(env);
  logs.push(run);
  await env.TDF_ALERTS.put(logsKey, JSON.stringify(logs.slice(-maxLogs), null, 2));
}

function createRun(event: RunLog["event"], trigger: string): RunLog {
  const startedAt = new Date().toISOString();
  return {
    id: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    event,
    status: "success",
    trigger,
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    version: workerVersion,
    steps: []
  };
}

function addStep(
  run: RunLog,
  name: string,
  status: RunStep["status"],
  details?: Record<string, unknown>
): void {
  const step: RunStep = {
    name,
    status,
    at: new Date().toISOString()
  };
  const durationMs = details?.["durationMs"];
  if (typeof durationMs === "number") {
    step.durationMs = durationMs;
  }
  if (details) {
    step.details = details;
  }
  run.steps.push(step);
}

function finishRun(
  run: RunLog,
  status: RunLog["status"],
  data: Partial<Omit<RunLog, "id" | "event" | "trigger" | "startedAt" | "finishedAt" | "durationMs" | "steps">> = {}
): void {
  run.status = status;
  Object.assign(run, data);
  run.finishedAt = new Date().toISOString();
  run.durationMs = new Date(run.finishedAt).valueOf() - new Date(run.startedAt).valueOf();
}

function parseOffers(input: unknown): TdfOffer[] {
  if (!Array.isArray(input)) {
    throw new TdfError("TDF response was not a JSON array.", "unexpected");
  }
  return input.map((item) => {
    if (!isRecord(item) || !Array.isArray(item["performances"])) {
      throw new TdfError("TDF response had an invalid offer shape.", "unexpected");
    }
    const offer: TdfOffer = {
      productionSeasonId: Number(item["productionSeasonId"]),
      title: String(item["title"]),
      facility: String(item["facility"]),
      performances: item["performances"].map((performance) => {
        if (!isRecord(performance)) {
          throw new TdfError("TDF response had an invalid performance shape.", "unexpected");
        }
        return {
          performanceId: Number(performance["performanceId"]),
          performanceDate: String(performance["performanceDate"])
        };
      })
    };
    if (typeof item["thumbnail"] === "string") {
      offer.thumbnail = item["thumbnail"];
    }
    return offer;
  });
}

function parseSeen(raw: string): Set<string> {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new TdfError("Seen state in KV is invalid.", "unexpected");
  }
  return new Set(parsed);
}

function flattenOffers(offers: TdfOffer[]): AlertItem[] {
  return offers.flatMap((offer) =>
    offer.performances.map((performance) => ({
      id: `${offer.productionSeasonId}:${performance.performanceId}`,
      title: offer.title,
      facility: offer.facility,
      performanceDate: performance.performanceDate
    }))
  );
}

function formatSummary(offers: TdfOffer[], items: AlertItem[]): string {
  const performances = countPerformances(offers);
  return [
    "<b>TDF Offers</b>",
    `${offers.length} shows, ${performances} performances available.`,
    items.length ? `${items.length} matching/new performances in this message.` : "",
    "",
    "<b>Available shows</b>",
    offers.map((offer) => `- ${escapeHtml(offer.title)} (${offer.performances.length})`).join("\n")
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDetails(offers: TdfOffer[], newItems: AlertItem[]): string {
  const newIds = new Set(newItems.map((item) => item.id));
  const lines = [
    "TDF OFFERS",
    `${offers.length} shows | ${countPerformances(offers)} performances | ${newItems.length} new`,
    "",
    "SHOWS",
    ...offers.map((offer, index) => `${index + 1}. ${offer.title} (${offer.performances.length})`),
    "",
    "DETAILS"
  ];

  for (const offer of offers) {
    lines.push("");
    lines.push(offer.title);
    lines.push(offer.facility);
    for (const performance of offer.performances) {
      const id = `${offer.productionSeasonId}:${performance.performanceId}`;
      const marker = newIds.has(id) ? "NEW " : "";
      lines.push(`${marker}${formatPerformanceDate(performance.performanceDate)}`);
    }
  }

  return lines.join("\n");
}

function formatLogs(logs: RunLog[]): string {
  if (logs.length === 0) {
    return "No run logs yet.";
  }
  return [
    "<b>Recent TDF Logs</b>",
    ...logs.map((log) =>
      [
        `${log.finishedAt} ${log.event} ${log.status}`,
        `trigger=${log.trigger}`,
        `shows=${log.shows ?? "-"} performances=${log.performances ?? "-"} new=${log.newPerformances ?? "-"}`,
        log.failureKind ? `failure=${log.failureKind}: ${escapeHtml(log.message ?? "")}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
  ].join("\n\n");
}

function formatStatus(snapshot: DebugSnapshot, offers: TdfOffer[]): string {
  const lastFailure = snapshot.lastFailure
    ? `${snapshot.lastFailure.finishedAt} (${snapshot.lastFailure.failureKind ?? "unknown"})`
    : "none";
  return [
    "<b>TDF Status</b>",
    `Cookie works now. ${offers.length} shows, ${countPerformances(offers)} performances available.`,
    `Cookie saved: ${snapshot.cookie.savedAt ?? "unknown"} (${snapshot.cookie.source ?? "unknown source"})`,
    `Last success: ${snapshot.lastSuccess?.finishedAt ?? "none"}`,
    `Last failure: ${escapeHtml(lastFailure)}`,
    `Browserbase refresh attempted: ${snapshot.auth.lastRefreshAttemptedAt ?? "none"}`,
    `Worker: ${escapeHtml(snapshot.version)}`
  ].join("\n");
}

function formatFailureMessage(
  kind: TdfError["kind"],
  message: string,
  refreshResult: BrowserbaseRefreshResult
): string {
  if (kind === "transient") {
    return [
      "<b>TDF checker temporary failure</b>",
      "The next run will try again.",
      escapeHtml(message)
    ].join("\n");
  }

  if (kind === "auth" && refreshResult.status === "dispatch-failed") {
    return [
      "<b>TDF bot needs attention</b>",
      "Automatic TDF login recovery could not start.",
      "I could not trigger the Browserbase refresh workflow.",
      refreshResult.failureReason ? escapeHtml(refreshResult.failureReason) : "",
      escapeHtml(message)
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (kind === "auth") {
    return [
      "<b>TDF login needs attention</b>",
      "Saved cookie no longer works.",
      "Automatic recovery is not configured, so Salman needs to refresh the login.",
      escapeHtml(message)
    ].join("\n");
  }

  return [
    "<b>TDF checker failed</b>",
    "The saved TDF login may still be fine, but the checker hit an unexpected error.",
    escapeHtml(message)
  ].join("\n");
}

function formatDebug(snapshot: DebugSnapshot): string {
  return [
    "<b>TDF Debug</b>",
    `generated=${escapeHtml(snapshot.generatedAt)}`,
    `version=${escapeHtml(snapshot.version)}`,
    "",
    "<b>Cookie</b>",
    `saved=${snapshot.cookie.savedAt ?? "unknown"}`,
    `source=${snapshot.cookie.source ?? "unknown"}`,
    `bytes=${snapshot.cookie.cookieBytes}`,
    `hasSession=${snapshot.cookie.hasSessionCookie}`,
    `hasTNEW=${snapshot.cookie.hasTnewCookie}`,
    "",
    "<b>Recovery</b>",
    `lastFailure=${snapshot.auth.lastFailureKind ?? "none"}`,
    `lastFailureAt=${snapshot.auth.lastFailureNotifiedAt ?? "none"}`,
    `lastRefreshAttempt=${snapshot.auth.lastRefreshAttemptedAt ?? "none"}`,
    "",
    "<b>Recent</b>",
    snapshot.recentRuns
      .slice(-5)
      .map((run) => `${run.finishedAt} ${run.event}/${run.status} shows=${run.shows ?? "-"} perf=${run.performances ?? "-"} new=${run.newPerformances ?? "-"}`)
      .join("\n") || "No runs yet."
  ].join("\n");
}

async function sendMessage(env: Env, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  });
  if (!response.ok) {
    throw new TdfError(`Telegram send failed with ${response.status}: ${await response.text()}`, "unexpected");
  }
}

async function sendDocument(env: Env, filename: string, content: string, caption: string): Promise<void> {
  const formData = new FormData();
  formData.set("chat_id", env.TELEGRAM_CHAT_ID);
  formData.set("caption", caption);
  formData.set("document", new Blob([content], { type: "text/plain" }), filename);

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: formData
  });
  if (!response.ok) {
    throw new TdfError(`Telegram document send failed with ${response.status}: ${await response.text()}`, "unexpected");
  }
}

function cookieForm(message: string): string {
  return `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TDF Cookie</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 32px auto; padding: 0 16px; }
    textarea { width: 100%; min-height: 220px; box-sizing: border-box; font-family: ui-monospace, monospace; }
    button { margin-top: 12px; padding: 10px 14px; }
    .message { color: #146c2e; font-weight: 700; }
  </style>
</head>
<body>
  <h1>TDF Cookie</h1>
  ${message ? `<p class="message">${escapeHtml(message)}</p>` : ""}
  <form method="post">
    <textarea name="cookie" placeholder="Paste full Cookie header here"></textarea>
    <button type="submit">Test and Save Cookie</button>
  </form>
</body>
</html>`;
}

function normalizeCookie(cookie: string): string {
  const cleanCookie = cookie.trim().replace(/^Cookie:\s*/i, "");
  if (!cleanCookie.includes(".TDFCustomOfferings.Session") && !cleanCookie.includes("TNEW")) {
    throw new TdfError("Cookie does not include expected TDF session cookies.", "auth");
  }
  return cleanCookie;
}

function isAuthorized(url: URL, env: Env): boolean {
  return Boolean(env.COOKIE_FORM_TOKEN) && url.searchParams.get("token") === env.COOKIE_FORM_TOKEN;
}

function countPerformances(offers: TdfOffer[]): number {
  return offers.reduce((total, offer) => total + offer.performances.length, 0);
}

function timestampedFilename(prefix: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${prefix}-${value("year")}${value("month")}${value("day")}-${value("hour")}${value("minute")}-ny.txt`;
}

function formatPerformanceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York"
  }).format(date);
}

function newYorkHour(date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false
  }).format(date);
}

function classifyStatus(status: number): TdfError["kind"] {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 408 || status === 429 || status >= 500) {
    return "transient";
  }
  return "unexpected";
}

function classifyError(error: unknown): TdfError["kind"] {
  if (error instanceof TdfError) {
    return error.kind;
  }
  if (error instanceof Error && /timeout|fetch failed/i.test(error.message)) {
    return "transient";
  }
  return "unexpected";
}

function looksLikeAuthFailure(body: string): boolean {
  return /captcha|access denied|error 15|forbidden|unauthori[sz]ed|password|sign\s+in|log\s+in/i.test(body);
}

function getSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (setCookies.length > 0) {
    return setCookies;
  }

  const setCookie = response.headers.get("set-cookie");
  return setCookie ? [setCookie] : [];
}

function mergeSetCookies(cookie: string, setCookies: string[]): string {
  if (setCookies.length === 0) {
    return cookie;
  }

  const values = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex > 0) {
      values.set(trimmed.slice(0, separatorIndex), trimmed.slice(separatorIndex + 1));
    }
  }

  for (const setCookie of setCookies) {
    const [nameValue] = setCookie.split(";");
    if (!nameValue) {
      continue;
    }
    const separatorIndex = nameValue.indexOf("=");
    if (separatorIndex > 0) {
      values.set(nameValue.slice(0, separatorIndex).trim(), nameValue.slice(separatorIndex + 1));
    }
  }

  return [...values.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
}

class TdfError extends Error {
  readonly kind: "auth" | "transient" | "unexpected";

  constructor(message: string, kind: TdfError["kind"]) {
    super(message);
    this.name = "TdfError";
    this.kind = kind;
  }
}
