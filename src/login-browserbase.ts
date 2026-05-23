import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Browserbase } from "@browserbasehq/sdk";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { fetchTdfOffersWithCookie } from "./tdf-fetch.js";
import { flattenOffers, TDF_OFFERS_URL } from "./tdf.js";

const TDF_LOGIN_URL = "https://my.tdf.org/account/login";
const envPath = ".env";

type LoginEnv = {
  browserbaseApiKey: string;
  browserbaseProjectId: string;
  browserbaseContextId?: string;
  cookieFormToken?: string;
  workerBaseUrl: string;
  tdfEmail: string;
  tdfPassword: string;
};

async function main(): Promise<void> {
  const env = readLoginEnv();
  const bb = new Browserbase({ apiKey: env.browserbaseApiKey });
  const contextId = env.browserbaseContextId ?? (await createBrowserbaseContext(bb, env));

  console.log(`Using Browserbase context ${contextId}.`);
  const session = await bb.sessions.create({
    projectId: env.browserbaseProjectId,
    timeout: 300,
    browserSettings: {
      context: {
        id: contextId,
        persist: true
      },
      os: "linux",
      solveCaptchas: false,
      viewport: {
        width: 1440,
        height: 1000
      }
    },
    userMetadata: {
      app: "tdf-offer-alerts",
      task: "tdf-login"
    }
  });

  console.log(`Browserbase session: https://browserbase.com/sessions/${session.id}`);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    try {
      await loginToTdf(page, env);
      await page.goto(TDF_OFFERS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

      const cookie = await cookieHeader(context);
      const offers = await fetchTdfOffersWithCookie(cookie);
      const performances = flattenOffers(offers);
      await upsertEnvValue("TDF_COOKIE", cookie);
      await upsertEnvValue("BROWSERBASE_CONTEXT_ID", contextId);
      await uploadCookieToWorker(cookie, env);

      console.log(`Saved TDF_COOKIE to .env.`);
      console.log(`Verified ${offers.length} shows and ${performances.length} performances.`);
    } catch (error) {
      await saveFailureDebug(page);
      throw error;
    }
  } finally {
    await closeBrowser(browser);
  }
}

async function createBrowserbaseContext(bb: Browserbase, env: LoginEnv): Promise<string> {
  const context = await bb.contexts.create({ projectId: env.browserbaseProjectId });
  await upsertEnvValue("BROWSERBASE_CONTEXT_ID", context.id);
  return context.id;
}

async function loginToTdf(page: Page, env: LoginEnv): Promise<void> {
  await page.goto(TDF_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  console.log(`Loaded login page: ${page.url()}`);
  await failIfChallenge(page);

  const email = page
    .locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[name*="user" i], input[id*="user" i]')
    .first();
  const password = page.locator('input[type="password"]').first();

  await email.waitFor({ state: "visible", timeout: 30_000 });
  await password.waitFor({ state: "visible", timeout: 30_000 });
  await email.fill(env.tdfEmail);
  await password.fill(env.tdfPassword);
  console.log("Filled TDF login form.");

  const submit = page
    .locator('button[type="submit"], input[type="submit"], button:has-text("Log"), button:has-text("Sign")')
    .first();
  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => undefined),
    submit.click()
  ]);

  await page.waitForTimeout(3_000);
  console.log(`After submit: ${page.url()}`);
  await failIfChallenge(page);

  if (page.url().includes("/account/login")) {
    const errorText = await visibleText(page);
    throw new Error(`TDF stayed on the login page after submit. ${errorText.slice(0, 300)}`);
  }
}

async function failIfChallenge(page: Page): Promise<void> {
  const text = await visibleText(page);
  if (/captcha|access denied|error 15|blocked by our security service|verify you are human/i.test(text)) {
    throw new Error(`TDF showed a security challenge instead of a normal login page. ${text.slice(0, 300)}`);
  }
}

async function visibleText(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
}

async function saveFailureDebug(page: Page): Promise<void> {
  await mkdir(".auth", { recursive: true });
  const text = await visibleText(page);
  await writeFile(".auth/browserbase-last-page.txt", `URL: ${page.url()}\n\n${text}`);
  await page.screenshot({ path: ".auth/browserbase-last-page.png", fullPage: true }).catch(() => undefined);
  console.log("Saved Browserbase failure debug to .auth/browserbase-last-page.txt and .auth/browserbase-last-page.png");
  console.log(`Failure page URL: ${page.url()}`);
  console.log(text.slice(0, 500));
}

async function cookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies([
    "https://my.tdf.org",
    "https://nycgw47.tdf.org",
    "https://tdf.org"
  ]);

  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function closeBrowser(browser: Browser): Promise<void> {
  await browser.close().catch(() => undefined);
}

function readLoginEnv(env: NodeJS.ProcessEnv = process.env): LoginEnv {
  return {
    browserbaseApiKey: required(env, "BROWSERBASE_API_KEY"),
    browserbaseProjectId: required(env, "BROWSERBASE_PROJECT_ID"),
    browserbaseContextId: env.BROWSERBASE_CONTEXT_ID || undefined,
    cookieFormToken: env.COOKIE_FORM_TOKEN || undefined,
    workerBaseUrl: env.WORKER_BASE_URL || "https://tdf-alerts-bot.salmanrazzaq94.workers.dev",
    tdfEmail: required(env, "TDF_EMAIL"),
    tdfPassword: required(env, "TDF_PASSWORD")
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

async function upsertEnvValue(key: string, value: string): Promise<void> {
  const text = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
  const line = `${key}=${value}`;
  const next = new RegExp(`^${key}=.*$`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${text}${text.endsWith("\n") || text.length === 0 ? "" : "\n"}${line}\n`;

  await writeFile(envPath, next);
}

async function uploadCookieToWorker(cookie: string, env: LoginEnv): Promise<void> {
  if (!env.cookieFormToken) {
    console.log("COOKIE_FORM_TOKEN is not set, so I did not update Cloudflare KV.");
    return;
  }

  const form = new FormData();
  form.set("cookie", cookie);
  const response = await fetch(
    `${env.workerBaseUrl.replace(/\/$/, "")}/cookie?token=${encodeURIComponent(env.cookieFormToken)}`,
    {
      method: "POST",
      body: form
    }
  );

  if (!response.ok) {
    throw new Error(`Could not update Cloudflare KV cookie: ${response.status} ${await response.text()}`);
  }

  console.log("Updated Cloudflare KV TDF_COOKIE through the Worker.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
