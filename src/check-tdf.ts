import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser, type Page } from "playwright-core";
import { readEnv } from "./env.js";
import {
  findNewAlerts,
  flattenOffers,
  markSeen,
  parseTdfOffers,
  readSeenState,
  TDF_OFFERS_URL,
  TDF_PERFORMANCES_URL,
  writeSeenState
} from "./tdf.js";
import {
  formatAlertMessage,
  formatAuthFailureMessage,
  sendTelegramMessage
} from "./telegram.js";

type BrowserbaseSession = {
  id: string;
  connectUrl?: string;
  connect_url?: string;
};

async function main(): Promise<void> {
  const env = readEnv();
  let browser: Browser | undefined;

  try {
    const session = await createBrowserbaseSession(env);
    const connectUrl = session.connectUrl ?? session.connect_url;
    if (!connectUrl) {
      throw new Error("Browserbase session did not include a CDP connect URL.");
    }

    browser = await chromium.connectOverCDP(connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());

    const offers = await fetchTdfOffers(page);
    const alertItems = flattenOffers(offers);
    const previousState = await readSeenState(env.seenStatePath);
    const newAlerts = findNewAlerts(alertItems, previousState);

    if (newAlerts.length === 0) {
      console.log(`Fetched ${alertItems.length} TDF performances. No new offers.`);
      return;
    }

    console.log(`Fetched ${alertItems.length} TDF performances. Sending ${newAlerts.length} alerts.`);
    for (const item of newAlerts) {
      await sendTelegramMessage(
        { botToken: env.telegramBotToken, chatId: env.telegramChatId },
        formatAlertMessage(item)
      );
    }

    await writeSeenState(env.seenStatePath, markSeen(previousState, newAlerts));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await notifyAuthFailure(reason);
    throw error;
  } finally {
    await browser?.close();
  }
}

async function createBrowserbaseSession(env: ReturnType<typeof readEnv>): Promise<BrowserbaseSession> {
  const bb = new Browserbase({
    apiKey: env.browserbaseApiKey
  });

  const sessionOptions: Record<string, unknown> = {
    context: {
      id: env.browserbaseContextId,
      persist: true
    },
    browserSettings: {
      viewport: {
        width: 1440,
        height: 1000
      }
    }
  };

  if (env.browserbaseProjectId) {
    sessionOptions.projectId = env.browserbaseProjectId;
  }

  return (await bb.sessions.create(sessionOptions)) as BrowserbaseSession;
}

async function fetchTdfOffers(page: Page) {
  await page.goto(TDF_OFFERS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  if (isLoginLikeUrl(page.url())) {
    throw new Error(`Browser landed on login page: ${page.url()}`);
  }

  const response = await page.request.get(TDF_PERFORMANCES_URL, {
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Referer: TDF_OFFERS_URL
    },
    timeout: 60_000
  });

  const contentType = response.headers()["content-type"] ?? "";
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`TDF performances endpoint returned ${response.status()}: ${body.slice(0, 300)}`);
  }

  if (!contentType.includes("application/json")) {
    throw new Error(
      `TDF performances endpoint returned non-JSON content (${contentType}): ${body.slice(0, 300)}`
    );
  }

  const parsed = JSON.parse(body) as unknown;
  return parseTdfOffers(parsed);
}

function isLoginLikeUrl(url: string): boolean {
  return /\/account\/login/i.test(url) || /captcha|challenge/i.test(url);
}

async function notifyAuthFailure(reason: string): Promise<void> {
  const env = readEnv();
  try {
    await sendTelegramMessage(
      { botToken: env.telegramBotToken, chatId: env.telegramChatId },
      formatAuthFailureMessage(reason)
    );
  } catch (telegramError) {
    console.error("Could not send Telegram failure notice:", telegramError);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
