export type Env = {
  tdfCookie: string;
  telegramBotToken: string;
  telegramChatId: string;
  seenStatePath: string;
};

export function readEnv(env: NodeJS.ProcessEnv = process.env): Env {
  return {
    tdfCookie: required(env, "TDF_COOKIE"),
    telegramBotToken: required(env, "TELEGRAM_BOT_TOKEN"),
    telegramChatId: required(env, "TELEGRAM_CHAT_ID"),
    seenStatePath: env.SEEN_STATE_PATH ?? "data/seen-offers.json"
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}
