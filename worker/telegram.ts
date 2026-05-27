import { addStep, appendLog, createRun, finishRun } from "./logging.js";
import {
  runCommandOffers,
  runDebug,
  runLogs,
  runStatus
} from "./runs.js";
import type { Env, TelegramUpdate } from "./types.js";
import { errorMessage, sanitizeUnknown, TdfError } from "./utils.js";

export async function handleTelegram(update: TelegramUpdate, env: Env, requestUrl: string): Promise<void> {
  const message = update.message;
  const text = message?.text?.trim().toLowerCase();
  if (!message || !text) {
    await recordTelegramIngress(env, "telegram:ignored", "skipped", {
      reason: "Missing Telegram message text."
    });
    return;
  }

  if (String(message.chat.id) !== env.TELEGRAM_CHAT_ID) {
    await recordTelegramIngress(env, "telegram:ignored", "skipped", {
      reason: "Unauthorized Telegram chat.",
      chatId: String(message.chat.id)
    });
    return;
  }

  if (text === "/cookie" || text === "/cookie@tdf_alert_watcher_bot") {
    const url = new URL("/cookie", requestUrl);
    url.searchParams.set("token", env.COOKIE_FORM_TOKEN);
    await recordTelegramIngress(env, "telegram:/cookie", "success", { command: "/cookie" });
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

  if (text === "/debug" || text === "/debug@tdf_alert_watcher_bot") {
    await runDebug(env);
    return;
  }

  if (text === "/logs" || text === "/logs@tdf_alert_watcher_bot") {
    await runLogs(env);
    return;
  }

  if (text === "/help" || text === "/start") {
    await recordTelegramIngress(env, "telegram:/help", "success", { command: text });
    await sendMessage(env, "Commands: /offers, /status, /debug, /logs, /cookie");
    return;
  }

  await recordTelegramIngress(env, "telegram:unknown", "skipped", {
    command: text.slice(0, 40)
  });
}

export async function sendMessage(env: Env, text: string): Promise<void> {
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

export async function sendDocument(env: Env, filename: string, content: string, caption: string): Promise<void> {
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

async function recordTelegramIngress(
  env: Env,
  trigger: string,
  status: "success" | "skipped",
  details: Record<string, unknown>
): Promise<void> {
  const run = createRun("command", trigger);
  addStep(run, "telegram-ingress", status, sanitizeUnknown(details) as Record<string, unknown>);
  finishRun(run, status, {
    message: status === "success" ? "Telegram command accepted." : "Telegram command ignored."
  });
  await appendLog(env, run).catch((error: unknown) => {
    console.error(JSON.stringify({
      event: "tdf-telegram-ingress-log-failed",
      message: errorMessage(error)
    }));
  });
}
