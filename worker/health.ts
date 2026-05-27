import { staleSuccessAlertAfterMs } from "./constants.js";
import { addStep, readLogs } from "./logging.js";
import { readHealthState } from "./state.js";
import type { Env, RunLog } from "./types.js";

export async function checkStaleHealth(env: Env, run: RunLog): Promise<void> {
  const health = await readHealthState(env);
  let lastSuccessAt = health.lastDeltaSuccessAt;
  let source = "health-state";
  if (!lastSuccessAt) {
    const logs = await readLogs(env);
    const lastSuccess = [...logs]
      .reverse()
      .find((log) => log.event === "delta" && log.status === "success");
    lastSuccessAt = lastSuccess?.finishedAt ?? null;
    source = lastSuccess ? "legacy-run-log" : "none";
  }
  if (!lastSuccessAt) {
    addStep(run, "stale-health-check", "skipped", { reason: "No previous successful delta run." });
    return;
  }

  const ageMs = Date.now() - new Date(lastSuccessAt).valueOf();
  if (ageMs < staleSuccessAlertAfterMs) {
    addStep(run, "stale-health-check", "success", {
      lastSuccessAt,
      ageMs,
      source
    });
    return;
  }

  addStep(run, "stale-health-check", "failure", {
    lastSuccessAt,
    ageMs,
    source,
    reason: "Previous successful delta run is stale."
  });
}
