type Env = {
  TDF_ALERTS: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  COOKIE_FORM_TOKEN: string;
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
  event: "delta" | "daily" | "command" | "cookie" | "status";
  status: "success" | "failure" | "skipped";
  trigger: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
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
};

const cookieKey = "TDF_COOKIE";
const seenKey = "SEEN_OFFERS";
const logsKey = "RUN_LOGS";
const authStateKey = "AUTH_STATE";
const tdfOffersUrl = "https://nycgw47.tdf.org/TDFCustomOfferings/Current";
const tdfPerformancesUrl = "https://nycgw47.tdf.org/TDFCustomOfferings/Current?handler=Performances";
const authFailureNotifyIntervalMs = 12 * 60 * 60 * 1000;
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
      const cookie = normalizeCookie(String(form.get("cookie") ?? ""));
      const run = createRun("cookie", "cookie-form");
      try {
        const offers = await fetchTdfOffers(cookie, run);
        await env.TDF_ALERTS.put(cookieKey, cookie);
        finishRun(run, "success", {
          shows: offers.length,
          performances: countPerformances(offers)
        });
        await appendLog(env, run);
        return html(cookieForm(`Saved. ${offers.length} shows available.`));
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
      const update = (await request.json()) as TelegramUpdate;
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

  if (text === "/logs" || text === "/logs@tdf_alert_watcher_bot") {
    const logs = await readLogs(env);
    await sendMessage(env, formatLogs(logs.slice(-8)));
    return;
  }

  if (text === "/help" || text === "/start") {
    await sendMessage(env, "Commands: /offers, /status, /logs, /cookie");
  }
}

async function runDeltaCheck(env: Env, trigger: string): Promise<RunLog> {
  const run = createRun("delta", trigger);
  let notificationSent = false;

  try {
    const cookie = await readCookie(env, run);
    const offers = await fetchTdfOffers(cookie, run);
    const items = flattenOffers(offers);
    const seen = await readSeen(env, run);
    const newItems = items.filter((item) => !seen.has(item.id));
    addStep(run, "diff-offers", "success", {
      seenBefore: seen.size,
      currentPerformances: items.length,
      newPerformances: newItems.length
    });

    if (newItems.length > 0) {
      const sendStarted = Date.now();
      await sendMessage(env, formatSummary(offers, newItems));
      addStep(run, "send-telegram-summary", "success", { durationMs: Date.now() - sendStarted });
      const documentStarted = Date.now();
      await sendDocument(
        env,
        timestampedFilename("tdf-offers-delta"),
        formatDetails(offers, newItems),
        "Full TDF availability details"
      );
      addStep(run, "send-telegram-document", "success", {
        durationMs: Date.now() - documentStarted
      });
      notificationSent = true;
      for (const item of newItems) {
        seen.add(item.id);
      }
      await writeSeen(env, seen, run);
    } else {
      addStep(run, "send-delta-alert", "skipped", { reason: "No new performances." });
    }

    await clearAuthState(env, run);
    finishRun(run, "success", {
      shows: offers.length,
      performances: items.length,
      newPerformances: newItems.length,
      notificationSent
    });
  } catch (error) {
    await handleCheckFailure(env, run, error);
  }

  await appendLog(env, run);
  return run;
}

async function runDailyDigest(env: Env, trigger: string): Promise<RunLog> {
  const run = createRun("daily", trigger);
  try {
    const cookie = await readCookie(env, run);
    const offers = await fetchTdfOffers(cookie, run);
    const items = flattenOffers(offers);
    const sendStarted = Date.now();
    await sendMessage(env, formatSummary(offers, items));
    addStep(run, "send-telegram-summary", "success", { durationMs: Date.now() - sendStarted });
    const documentStarted = Date.now();
    await sendDocument(
      env,
      timestampedFilename("tdf-offers-current"),
      formatDetails(offers, []),
      "Current TDF availability details"
    );
    addStep(run, "send-telegram-document", "success", {
      durationMs: Date.now() - documentStarted
    });
    await clearAuthState(env, run);
    finishRun(run, "success", {
      shows: offers.length,
      performances: items.length,
      notificationSent: true
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
    const offers = await fetchTdfOffers(cookie, run);
    const items = flattenOffers(offers);
    const sendStarted = Date.now();
    await sendMessage(env, formatSummary(offers, items));
    addStep(run, "send-telegram-summary", "success", { durationMs: Date.now() - sendStarted });
    const documentStarted = Date.now();
    await sendDocument(
      env,
      timestampedFilename("tdf-offers-command"),
      formatDetails(offers, []),
      "Latest TDF availability details"
    );
    addStep(run, "send-telegram-document", "success", {
      durationMs: Date.now() - documentStarted
    });
    finishRun(run, "success", {
      shows: offers.length,
      performances: items.length,
      notificationSent: true
    });
  } catch (error) {
    await sendMessage(env, `TDF authentication needs attention.\n${errorMessage(error)}\nUse Browserbase refresh or send /cookie.`);
    finishRun(run, "failure", {
      failureKind: classifyError(error),
      message: errorMessage(error),
      notificationSent: true
    });
  }
  await appendLog(env, run);
}

async function runStatus(env: Env): Promise<void> {
  const run = createRun("status", "telegram:/status");
  try {
    const cookie = await readCookie(env, run);
    const offers = await fetchTdfOffers(cookie, run);
    const sendStarted = Date.now();
    await sendMessage(env, `TDF cookie works. ${offers.length} shows, ${countPerformances(offers)} performances available.`);
    addStep(run, "send-telegram-status", "success", { durationMs: Date.now() - sendStarted });
    finishRun(run, "success", {
      shows: offers.length,
      performances: countPerformances(offers),
      notificationSent: true
    });
  } catch (error) {
    await sendMessage(env, `TDF cookie is not working.\n${errorMessage(error)}`);
    finishRun(run, "failure", {
      failureKind: classifyError(error),
      message: errorMessage(error),
      notificationSent: true
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

  await env.TDF_ALERTS.put(
    authStateKey,
    JSON.stringify({
      lastFailureNotifiedAt: shouldNotify ? new Date().toISOString() : state.lastFailureNotifiedAt,
      lastFailureKind: kind,
      lastFailureReason: message
    })
  );
  addStep(run, "failure-notification-throttle", "success", {
    shouldNotify,
    lastFailureKind: state.lastFailureKind,
    lastFailureNotifiedAt: state.lastFailureNotifiedAt
  });

  if (shouldNotify) {
    const sendStarted = Date.now();
    await sendMessage(
      env,
      kind === "transient"
        ? `<b>TDF checker temporary failure</b>\nThe next run will try again.\n${escapeHtml(message)}`
        : `<b>TDF login needs attention</b>\nSaved cookie no longer works.\nUse Browserbase refresh or send /cookie.\n${escapeHtml(message)}`
    );
    addStep(run, "send-telegram-failure", "success", { durationMs: Date.now() - sendStarted });
  } else {
    addStep(run, "send-telegram-failure", "skipped", {
      reason: "Repeated failure notification is throttled."
    });
  }

  finishRun(run, "failure", {
    failureKind: kind,
    message,
    notificationSent: shouldNotify
  });
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

async function fetchTdfOffers(cookie: string, run: RunLog): Promise<TdfOffer[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(tdfPerformancesUrl, {
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/json",
          Cookie: cookie,
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
      return offers;
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

async function readSeen(env: Env, run: RunLog): Promise<Set<string>> {
  const started = Date.now();
  const raw = await env.TDF_ALERTS.get(seenKey);
  const seen = raw ? parseSeen(raw) : new Set<string>();
  addStep(run, "read-seen-state", "success", {
    durationMs: Date.now() - started,
    seenCount: seen.size
  });
  return seen;
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
      lastFailureReason: null
    };
  }
  return JSON.parse(raw) as AuthState;
}

async function clearAuthState(env: Env, run: RunLog): Promise<void> {
  await env.TDF_ALERTS.put(
    authStateKey,
    JSON.stringify({
      lastFailureNotifiedAt: null,
      lastFailureKind: null,
      lastFailureReason: null
    })
  );
  addStep(run, "clear-auth-state", "success");
}

async function readLogs(env: Env): Promise<RunLog[]> {
  const raw = await env.TDF_ALERTS.get(logsKey);
  if (!raw) {
    return [];
  }
  return JSON.parse(raw) as RunLog[];
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
    steps: []
  };
}

function addStep(
  run: RunLog,
  name: string,
  status: RunStep["status"],
  details?: Record<string, unknown>
): void {
  run.steps.push({
    name,
    status,
    at: new Date().toISOString(),
    durationMs: typeof details?.durationMs === "number" ? details.durationMs : undefined,
    details
  });
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
    if (!isRecord(item) || !Array.isArray(item.performances)) {
      throw new TdfError("TDF response had an invalid offer shape.", "unexpected");
    }
    return {
      productionSeasonId: Number(item.productionSeasonId),
      title: String(item.title),
      facility: String(item.facility),
      thumbnail: typeof item.thumbnail === "string" ? item.thumbnail : undefined,
      performances: item.performances.map((performance) => {
        if (!isRecord(performance)) {
          throw new TdfError("TDF response had an invalid performance shape.", "unexpected");
        }
        return {
          performanceId: Number(performance.performanceId),
          performanceDate: String(performance.performanceDate)
        };
      })
    };
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
  return url.searchParams.get("token") === env.COOKIE_FORM_TOKEN;
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
