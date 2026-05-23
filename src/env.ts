export type Env = {
  tdfCookie: string;
  telegramBotToken: string;
  telegramChatId: string;
  seenStatePath: string;
};

export type BrowserbaseEnv = {
  browserbaseApiKey: string;
  browserbaseProjectId?: string;
  browserbaseContextId: string;
};

export function readEnv(env: NodeJS.ProcessEnv = process.env): Env {
  return {
    tdfCookie: required(env, "TDF_COOKIE"),
    telegramBotToken: required(env, "TELEGRAM_BOT_TOKEN"),
    telegramChatId: required(env, "TELEGRAM_CHAT_ID"),
    seenStatePath: env.SEEN_STATE_PATH ?? "data/seen-offers.json"
  };
}

export function readBrowserbaseEnv(env: NodeJS.ProcessEnv = process.env): BrowserbaseEnv {
  return {
    browserbaseApiKey: required(env, "BROWSERBASE_API_KEY"),
    browserbaseProjectId: env.BROWSERBASE_PROJECT_ID,
    browserbaseContextId: required(env, "BROWSERBASE_CONTEXT_ID")
  };
}

export function readBrowserbaseProjectEnv(env: NodeJS.ProcessEnv = process.env): Omit<BrowserbaseEnv, "browserbaseContextId"> {
  return {
    browserbaseApiKey: required(env, "BROWSERBASE_API_KEY"),
    browserbaseProjectId: env.BROWSERBASE_PROJECT_ID
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}
