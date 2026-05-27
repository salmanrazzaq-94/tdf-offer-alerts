import { formatDetails, formatSummary } from "./formatters.js";
import { addStep } from "./logging.js";
import { sendDocument, sendMessage } from "./telegram.js";
import type { AlertItem, Env, RunLog, TdfOffer } from "./types.js";
import { errorMessage } from "./utils.js";

export async function sendOfferNotification(
  env: Env,
  run: RunLog,
  offers: TdfOffer[],
  items: AlertItem[],
  filename: string,
  caption: string
): Promise<boolean> {
  const sendStarted = Date.now();
  try {
    await sendMessage(env, formatSummary(offers, items));
    addStep(run, "send-telegram-summary", "success", { durationMs: Date.now() - sendStarted });
  } catch (error) {
    addStep(run, "send-telegram-summary", "failure", {
      durationMs: Date.now() - sendStarted,
      message: errorMessage(error)
    });
    throw error;
  }

  const documentStarted = Date.now();
  try {
    await sendDocument(env, filename, formatDetails(offers, items), caption);
    addStep(run, "send-telegram-document", "success", {
      durationMs: Date.now() - documentStarted
    });
  } catch (error) {
    addStep(run, "send-telegram-document", "failure", {
      durationMs: Date.now() - documentStarted,
      message: errorMessage(error)
    });
  }

  return true;
}
