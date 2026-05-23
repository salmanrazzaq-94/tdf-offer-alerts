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

type TdfOffer = {
  productionSeasonId: number;
  title: string;
  facility: string;
  performances: Array<{
    performanceId: number;
    performanceDate: string;
  }>;
};

const cookieKey = "TDF_COOKIE";
const tdfOffersUrl = "https://nycgw47.tdf.org/TDFCustomOfferings/Current";
const tdfPerformancesUrl = "https://nycgw47.tdf.org/TDFCustomOfferings/Current?handler=Performances";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/tdf-cookie") {
      if (url.searchParams.get("token") !== env.COOKIE_FORM_TOKEN) {
        return new Response("Not found", { status: 404 });
      }

      const cookie = await env.TDF_ALERTS.get(cookieKey);
      if (!cookie) {
        return new Response("No TDF cookie saved", { status: 404 });
      }

      return new Response(cookie, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8"
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/cookie") {
      if (url.searchParams.get("token") !== env.COOKIE_FORM_TOKEN) {
        return new Response("Not found", { status: 404 });
      }

      return html(cookieForm(""));
    }

    if (request.method === "POST" && url.pathname === "/cookie") {
      if (url.searchParams.get("token") !== env.COOKIE_FORM_TOKEN) {
        return new Response("Not found", { status: 404 });
      }

      const form = await request.formData();
      const cookie = normalizeCookie(String(form.get("cookie") ?? ""));
      const offers = await fetchTdfOffers(cookie);
      await env.TDF_ALERTS.put(cookieKey, cookie);

      return html(cookieForm(`Saved. ${offers.length} shows available.`));
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      const update = (await request.json()) as TelegramUpdate;
      await handleTelegram(update, env, request.url);
      return json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
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
    await sendCurrentOffers(env);
    return;
  }

  if (text === "/status" || text === "/status@tdf_alert_watcher_bot") {
    const cookie = await env.TDF_ALERTS.get(cookieKey);
    if (!cookie) {
      await sendMessage(env, "No TDF cookie saved. Send /cookie.");
      return;
    }

    try {
      const offers = await fetchTdfOffers(cookie);
      await sendMessage(env, `TDF cookie works. ${offers.length} shows available.`);
    } catch (error) {
      await sendMessage(env, `TDF cookie is not working.\n${errorMessage(error)}`);
    }
    return;
  }

  if (text === "/help" || text === "/start") {
    await sendMessage(env, "Commands: /offers, /status, /cookie");
  }
}

async function sendCurrentOffers(env: Env): Promise<void> {
  const cookie = await env.TDF_ALERTS.get(cookieKey);
  if (!cookie) {
    await sendMessage(env, "No TDF cookie saved. Send /cookie.");
    return;
  }

  try {
    const offers = await fetchTdfOffers(cookie);
    await sendMessage(env, formatSummary(offers));
    await sendDocument(
      env,
      timestampedFilename("tdf-offers-command"),
      formatDetails(offers),
      "Latest TDF availability details"
    );
  } catch (error) {
    await sendMessage(env, `TDF authentication needs attention.\n${errorMessage(error)}\nSend /cookie to update it.`);
  }
}

async function fetchTdfOffers(cookie: string): Promise<TdfOffer[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
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
      if (!response.ok) {
        throw new Error(`TDF returned ${response.status}: ${body.slice(0, 200)}`);
      }
      if (!contentType.includes("application/json")) {
        throw new Error(`TDF returned non-JSON content (${contentType}): ${body.slice(0, 200)}`);
      }
      const parsed = JSON.parse(body) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("TDF response was not an array.");
      }
      return parsed as TdfOffer[];
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }

  throw lastError;
}

function formatSummary(offers: TdfOffer[]): string {
  const performances = offers.reduce((total, offer) => total + offer.performances.length, 0);
  return [
    "<b>TDF Offers</b>",
    `${offers.length} shows, ${performances} performances available.`,
    "",
    "<b>Available shows</b>",
    offers.map((offer) => `- ${escapeHtml(offer.title)} (${offer.performances.length})`).join("\n")
  ].join("\n");
}

function formatDetails(offers: TdfOffer[]): string {
  const lines = [
    "TDF OFFERS",
    `${offers.length} shows | ${offers.reduce((total, offer) => total + offer.performances.length, 0)} performances`,
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
      lines.push(formatPerformanceDate(performance.performanceDate));
    }
  }

  return lines.join("\n");
}

async function sendMessage(env: Env, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  });
}

async function sendDocument(env: Env, filename: string, content: string, caption: string): Promise<void> {
  const formData = new FormData();
  formData.set("chat_id", env.TELEGRAM_CHAT_ID);
  formData.set("caption", caption);
  formData.set("document", new Blob([content], { type: "text/plain" }), filename);

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: formData
  });
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
    throw new Error("Cookie does not include expected TDF session cookies.");
  }
  return cleanCookie;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
