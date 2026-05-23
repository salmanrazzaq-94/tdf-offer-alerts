import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser } from "playwright-core";
import { readBrowserbaseEnv } from "./env.js";
import { TDF_OFFERS_URL } from "./tdf.js";

type BrowserbaseSession = {
  id: string;
  connectUrl?: string;
  connect_url?: string;
};

async function main(): Promise<void> {
  const env = readBrowserbaseEnv();
  let browser: Browser | undefined;

  try {
    const bb = new Browserbase({ apiKey: env.browserbaseApiKey });
    const session = (await bb.sessions.create({
      projectId: env.browserbaseProjectId,
      browserSettings: {
        context: {
          id: env.browserbaseContextId,
          persist: true
        },
        viewport: {
          width: 1440,
          height: 1000
        }
      },
      timeout: 60
    })) as BrowserbaseSession;

    const connectUrl = session.connectUrl ?? session.connect_url;
    if (!connectUrl) {
      throw new Error("Browserbase session did not include a CDP connect URL.");
    }

    browser = await chromium.connectOverCDP(connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(TDF_OFFERS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const cookies = await context.cookies([
      "https://my.tdf.org",
      "https://nycgw47.tdf.org",
      "https://tdf.org"
    ]);
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");

    if (!cookieHeader.includes(".TDFCustomOfferings.Session") && !cookieHeader.includes("TNEW")) {
      throw new Error("Could not find expected TDF session cookies. Log in manually first.");
    }

    console.log(cookieHeader);
  } finally {
    await browser?.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
