import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Browserbase } from "@browserbasehq/sdk";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createOperationLogger, type OperationLogger } from "./observability.js";
import { fetchTdfOffersWithCookie } from "./tdf-fetch.js";
import { flattenOffers, TDF_OFFERS_URL } from "./tdf.js";

const TDF_LOGIN_URL = "https://my.tdf.org/account/login";
const envPath = ".env";

type LoginEnv = {
  browserbaseApiKey: string;
  browserbaseProjectId: string;
  browserbaseContextId: string | undefined;
  cookieFormToken: string | undefined;
  workerBaseUrl: string;
  tdfEmail: string;
  tdfPassword: string;
};

async function main(): Promise<void> {
  const logger = createOperationLogger("login-browserbase");
  const env = readLoginEnv();
  const bb = new Browserbase({ apiKey: env.browserbaseApiKey });
  const contextId = env.browserbaseContextId ?? (await logger.step(
    "browserbase-context-create",
    () => createBrowserbaseContext(bb, env),
    { projectId: env.browserbaseProjectId }
  ));

  logger.info("browserbase-context-selected", {
    contextId,
    reusedContext: Boolean(env.browserbaseContextId)
  });
  const session = await logger.step("browserbase-session-create", () =>
    bb.sessions.create({
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
    }), { contextId });

  logger.info("browserbase-session-created", {
    sessionId: session.id,
    sessionUrl: `https://browserbase.com/sessions/${session.id}`
  });
  const browser = await logger.step("browserbase-connect", () => chromium.connectOverCDP(session.connectUrl), {
    sessionId: session.id
  });
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    try {
      await logger.step("tdf-login", () => loginToTdf(page, env, logger));
      await logger.step("tdf-offers-page-load", () =>
        page.goto(TDF_OFFERS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }), {
        url: TDF_OFFERS_URL
      });

      const cookie = await logger.step("collect-browser-cookies", () => cookieHeader(context));
      const offers = await logger.step("verify-cookie-locally", () =>
        fetchTdfOffersWithCookie(cookie, logger));
      const performances = flattenOffers(offers);
      await logger.step("save-cookie-env", () => upsertEnvValue("TDF_COOKIE", cookie));
      await logger.step("save-context-env", () => upsertEnvValue("BROWSERBASE_CONTEXT_ID", contextId));
      await uploadCookieToWorker(cookie, env, logger);

      logger.info("login-browserbase:success", {
        shows: offers.length,
        performances: performances.length
      });
    } catch (error) {
      await saveFailureDebug(page, logger);
      throw error;
    }
  } finally {
    await logger.step("browser-close", () => closeBrowser(browser), { sessionId: session.id });
  }
}

async function createBrowserbaseContext(bb: Browserbase, env: LoginEnv): Promise<string> {
  const context = await bb.contexts.create({ projectId: env.browserbaseProjectId });
  await upsertEnvValue("BROWSERBASE_CONTEXT_ID", context.id);
  return context.id;
}

async function loginToTdf(page: Page, env: LoginEnv, logger: OperationLogger): Promise<void> {
  await page.goto(TDF_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  logger.info("tdf-login-page-loaded", { url: page.url() });
  await failIfChallenge(page);

  const email = page
    .locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[name*="user" i], input[id*="user" i]')
    .first();
  const password = page.locator('input[type="password"]').first();

  await email.waitFor({ state: "visible", timeout: 30_000 });
  await password.waitFor({ state: "visible", timeout: 30_000 });
  await email.fill(env.tdfEmail);
  await password.fill(env.tdfPassword);
  logger.info("tdf-login-form-filled");

  const submit = page
    .locator('button[type="submit"], input[type="submit"], button:has-text("Log"), button:has-text("Sign")')
    .first();
  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => undefined),
    submit.click()
  ]);

  await page.waitForTimeout(3_000);
  logger.info("tdf-login-submit-complete", { url: page.url() });
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

async function saveFailureDebug(page: Page, logger: OperationLogger): Promise<void> {
  await mkdir(".auth", { recursive: true });
  const text = await visibleText(page);
  await writeFile(".auth/browserbase-last-page.txt", `URL: ${page.url()}\n\n${text}`);
  await page.screenshot({ path: ".auth/browserbase-last-page.png", fullPage: true }).catch(() => undefined);
  logger.error("browserbase-failure-debug-saved", {
    textPath: ".auth/browserbase-last-page.txt",
    screenshotPath: ".auth/browserbase-last-page.png",
    url: page.url(),
    bodyPreview: text.slice(0, 500)
  });
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
    browserbaseContextId: env["BROWSERBASE_CONTEXT_ID"] || undefined,
    cookieFormToken: env["COOKIE_FORM_TOKEN"] || undefined,
    workerBaseUrl: env["WORKER_BASE_URL"] || "https://tdf-alerts-bot.salmanrazzaq94.workers.dev",
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

async function uploadCookieToWorker(
  cookie: string,
  env: LoginEnv,
  logger: OperationLogger
): Promise<void> {
  if (!env.cookieFormToken) {
    logger.warn("worker-cookie-upload-skipped", {
      reason: "COOKIE_FORM_TOKEN is not set."
    });
    return;
  }

  const cookieFormToken = env.cookieFormToken;
  const form = new FormData();
  form.set("cookie", cookie);
  const workerRoot = env.workerBaseUrl.replace(/\/$/, "");
  const response = await logger.step("worker-cookie-upload", () => fetch(
    `${workerRoot}/cookie?token=${encodeURIComponent(cookieFormToken)}`,
    {
      method: "POST",
      body: form
    }
  ), { workerRoot });

  if (!response.ok) {
    throw new Error(`Could not update Cloudflare KV cookie: ${response.status} ${await response.text()}`);
  }

  logger.info("worker-cookie-upload:accepted", { status: response.status });

  const verifyResponse = await logger.step("worker-cookie-verify", () =>
    fetch(`${workerRoot}/verify-cookie?token=${encodeURIComponent(cookieFormToken)}`), { workerRoot });
  if (!verifyResponse.ok) {
    throw new Error(`Cloudflare saved the cookie, but final verification failed: ${verifyResponse.status} ${await verifyResponse.text()}`);
  }
  const verification: { status?: string; shows?: number; performances?: number; message?: string } =
    await verifyResponse.json();
  if (verification.status !== "success") {
    throw new Error(`Cloudflare final verification failed: ${JSON.stringify(verification)}`);
  }
  logger.info("worker-cookie-verify:success", {
    shows: verification.shows ?? "unknown",
    performances: verification.performances ?? "unknown"
  });
}

main().catch((error: unknown) => {
  createOperationLogger("login-browserbase").error("fatal", {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
