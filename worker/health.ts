import { staleSuccessAlertAfterMs } from "./constants.js";
import { addStep } from "./logging.js";
import { readHealthState } from "./state.js";
import type { Env, RunLog } from "./types.js";

export async function checkStaleHealth(env: Env, run: RunLog): Promise<void> {
  const health = await readHealthState(env);
  const lastSuccessAt = health.lastDeltaSuccessAt;
  const source = "health-state";
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
