import { addStep, appendLog, createRun, finishRun } from "./logging.js";
import {
  runCommandOffers,
  runStatus
} from "./commands.js";
import type { Env, TelegramUpdate } from "./types.js";
import { classifyError, errorMessage, sanitizeUnknown, TdfError } from "./utils.js";

export async function handleTelegram(update: TelegramUpdate, env: Env, requestUrl: string): Promise<void> {
  const message = update.message;
  const text = message?.text?.trim().toLowerCase();
  if (!message || !text) {
    recordTelegramIngress("telegram:ignored", "skipped", {
      reason: "Missing Telegram message text."
    });
    return;
  }

  if (String(message.chat.id) !== env.TELEGRAM_CHAT_ID) {
    recordTelegramIngress("telegram:ignored", "skipped", {
      reason: "Unauthorized Telegram chat.",
      chatId: String(message.chat.id)
    });
    return;
  }

  if (text === "/cookie" || text === "/cookie@tdf_alert_watcher_bot") {
    const url = new URL("/cookie", requestUrl);
    url.searchParams.set("token", env.COOKIE_FORM_TOKEN);
    await runTelegramMessageCommand(
      env,
      "telegram:/cookie",
      { command: "/cookie" },
      `Paste a fresh TDF cookie here:\n${url.toString()}`
    );
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

  if (text === "/help" || text === "/start") {
    await runTelegramMessageCommand(
      env,
      "telegram:/help",
      { command: text },
      "Commands: /offers, /status, /cookie"
    );
    return;
  }

  recordTelegramIngress("telegram:unknown", "skipped", {
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

function recordTelegramIngress(
  trigger: string,
  status: "success" | "skipped",
  details: Record<string, unknown>
): void {
  const run = createRun("command", trigger);
  addStep(run, "telegram-ingress", status, sanitizeUnknown(details) as Record<string, unknown>);
  finishRun(run, status, {
    message: status === "success" ? "Telegram command accepted." : "Telegram command ignored."
  });
  try {
    appendLog(run);
  } catch (error) {
    console.error(JSON.stringify({
      event: "tdf-telegram-ingress-log-failed",
      message: errorMessage(error)
    }));
  }
}

async function runTelegramMessageCommand(
  env: Env,
  trigger: string,
  details: Record<string, unknown>,
  message: string
): Promise<void> {
  const run = createRun("command", trigger);
  addStep(run, "telegram-ingress", "success", sanitizeUnknown(details) as Record<string, unknown>);
  const sendStarted = Date.now();
  try {
    await sendMessage(env, message);
    addStep(run, "send-telegram-message", "success", { durationMs: Date.now() - sendStarted });
    finishRun(run, "success", {
      message: "Telegram command response sent.",
      notificationSent: true
    });
  } catch (error) {
    addStep(run, "send-telegram-message", "failure", {
      durationMs: Date.now() - sendStarted,
      message: errorMessage(error)
    });
    finishRun(run, "failure", {
      failureKind: classifyError(error),
      message: errorMessage(error),
      notificationSent: false
    });
  }
  try {
    appendLog(run);
  } catch (error) {
    console.error(JSON.stringify({
      event: "tdf-telegram-command-log-failed",
      message: errorMessage(error)
    }));
  }
}
