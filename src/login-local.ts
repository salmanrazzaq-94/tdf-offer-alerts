import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, type BrowserContext } from "playwright";
import { fetchTdfOffersWithCookie } from "./tdf-fetch.js";
import { flattenOffers, TDF_OFFERS_URL } from "./tdf.js";

const TDF_LOGIN_URL = "https://my.tdf.org/account/login";
const envPath = ".env";
const profilePath = process.env["LOCAL_BROWSER_PROFILE"] ?? ".auth/tdf-profile";
const holdMs = Number(process.env["SESSION_HOLD_SECONDS"] ?? 600) * 1000;

async function main(): Promise<void> {
  await mkdir(profilePath, { recursive: true });

  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    viewport: { width: 1440, height: 1000 }
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(TDF_LOGIN_URL, { waitUntil: "domcontentloaded" });

    console.log("Local Playwright browser opened.");
    console.log("Log into TDF in the browser window. I will detect the session and save TDF_COOKIE.");

    const cookie = await waitForTdfCookie(context);
    const offers = await fetchTdfOffersWithCookie(cookie);
    await upsertEnvValue("TDF_COOKIE", cookie);

    const performances = flattenOffers(offers);
    console.log(`Saved TDF_COOKIE to .env.`);
    console.log(`Verified ${offers.length} productions and ${performances.length} performances.`);
  } finally {
    await context.close();
  }
}

async function waitForTdfCookie(context: BrowserContext): Promise<string> {
  const startedAt = Date.now();
  let lastError = "Not logged in yet.";

  while (Date.now() - startedAt < holdMs) {
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    if (!page.url().includes("tdf.org")) {
      await page.goto(TDF_OFFERS_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }

    const cookie = await cookieHeader(context);
    if (hasTdfSessionCookie(cookie)) {
      try {
        await fetchTdfOffersWithCookie(cookie);
        return cookie;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  throw new Error(`Timed out waiting for a working TDF login. Last check: ${lastError}`);
}

async function cookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies([
    "https://my.tdf.org",
    "https://nycgw47.tdf.org",
    "https://tdf.org"
  ]);

  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function hasTdfSessionCookie(cookie: string): boolean {
  return cookie.includes(".TDFCustomOfferings.Session") || cookie.includes("TNEW");
}

async function upsertEnvValue(key: string, value: string): Promise<void> {
  const text = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
  const line = `${key}=${value}`;
  const next = new RegExp(`^${key}=.*$`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${text}${text.endsWith("\n") || text.length === 0 ? "" : "\n"}${line}\n`;

  await writeFile(envPath, next);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
