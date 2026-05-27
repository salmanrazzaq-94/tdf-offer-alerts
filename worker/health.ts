import { staleSuccessAlertAfterMs } from "./constants.js";
import { addStep, readLogs } from "./logging.js";
import type { Env, RunLog } from "./types.js";

export async function checkStaleHealth(env: Env, run: RunLog): Promise<void> {
  const logs = await readLogs(env);
  const lastSuccess = [...logs]
    .reverse()
    .find((log) => log.event === "delta" && log.status === "success");
  if (!lastSuccess) {
    addStep(run, "stale-health-check", "skipped", { reason: "No previous successful delta run." });
    return;
  }

  const ageMs = Date.now() - new Date(lastSuccess.finishedAt).valueOf();
  if (ageMs < staleSuccessAlertAfterMs) {
    addStep(run, "stale-health-check", "success", {
      lastSuccessAt: lastSuccess.finishedAt,
      ageMs
    });
    return;
  }

  addStep(run, "stale-health-check", "failure", {
    lastSuccessAt: lastSuccess.finishedAt,
    ageMs,
    reason: "Previous successful delta run is stale."
  });
}
