import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";
import { readEnv } from "./env.js";

const TDF_LOGIN_URL = "https://my.tdf.org/account/login";
const HOLD_MS = Number(process.env.SESSION_HOLD_SECONDS ?? 600) * 1000;

type BrowserbaseSession = {
  id: string;
  connectUrl?: string;
  connect_url?: string;
};

async function main(): Promise<void> {
  const env = readEnv();
  const bb = new Browserbase({ apiKey: env.browserbaseApiKey });
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

  const session = (await bb.sessions.create(sessionOptions)) as BrowserbaseSession;
  const connectUrl = session.connectUrl ?? session.connect_url;
  if (!connectUrl) {
    throw new Error("Browserbase session did not include a CDP connect URL.");
  }

  const browser = await chromium.connectOverCDP(connectUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(TDF_LOGIN_URL, { waitUntil: "domcontentloaded" });

  const debugUrls = await bb.sessions.debug(session.id);
  console.log("Browserbase session opened for manual TDF login.");
  console.log(`Debugger URL: ${debugUrls.debuggerUrl}`);
  console.log(`Keeping the session open for ${Math.round(HOLD_MS / 1000)} seconds.`);

  await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
