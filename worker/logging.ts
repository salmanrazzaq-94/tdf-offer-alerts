import { logsKey, maxLogs, runLogSchemaVersion, workerVersion } from "./constants.js";
import type { Env, RunLog, RunStep } from "./types.js";
import { errorMessage, sanitizeText, sanitizeUnknown } from "./utils.js";

export async function readLogs(env: Env): Promise<RunLog[]> {
  const raw = await env.TDF_ALERTS.get(logsKey);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as RunLog[]) : [];
  } catch (error) {
    console.warn(JSON.stringify({
      event: "tdf-run-log-read-recovered",
      message: sanitizeText(errorMessage(error))
    }));
    return [];
  }
}

export async function appendLog(env: Env, run: RunLog): Promise<void> {
  try {
    const logs = await readLogs(env);
    logs.push(run);
    await env.TDF_ALERTS.put(logsKey, JSON.stringify(logs.slice(-maxLogs), null, 2));
    emitRunSummary(run);
  } catch (error) {
    console.error(JSON.stringify({
      event: "tdf-run-log-write-failure",
      message: sanitizeText(errorMessage(error)),
      run: summarizeRun(run)
    }));
  }
}

export function createRun(event: RunLog["event"], trigger: string): RunLog {
  const startedAt = new Date().toISOString();
  return {
    id: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    event,
    status: "success",
    trigger,
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    version: workerVersion,
    steps: [],
    schemaVersion: runLogSchemaVersion
  };
}

export function addStep(
  run: RunLog,
  name: string,
  status: RunStep["status"],
  details?: Record<string, unknown>
): void {
  const step: RunStep = {
    name,
    status,
    at: new Date().toISOString()
  };
  const durationMs = details?.["durationMs"];
  if (typeof durationMs === "number") {
    step.durationMs = durationMs;
  }
  if (details) {
    step.details = sanitizeUnknown(details) as Record<string, unknown>;
  }
  run.steps.push(step);
}

export function finishRun(
  run: RunLog,
  status: RunLog["status"],
  data: Partial<Omit<RunLog, "id" | "event" | "trigger" | "startedAt" | "finishedAt" | "durationMs" | "steps">> = {}
): void {
  run.status = status;
  Object.assign(run, sanitizeUnknown(data));
  run.finishedAt = new Date().toISOString();
  run.durationMs = new Date(run.finishedAt).valueOf() - new Date(run.startedAt).valueOf();
}

export function summarizeRun(run: RunLog): Record<string, unknown> {
  return {
    id: run.id,
    event: run.event,
    status: run.status,
    trigger: sanitizeText(run.trigger),
    durationMs: run.durationMs,
    shows: run.shows,
    performances: run.performances,
    newPerformances: run.newPerformances,
    notificationSent: run.notificationSent,
    failureKind: run.failureKind,
    message: run.message ? sanitizeText(run.message) : undefined,
    steps: run.steps.length
  };
}

export function logRuntimeEvent(
  level: "info" | "warn" | "error",
  event: string,
  details: Record<string, unknown> = {}
): void {
  const safeDetails = sanitizeUnknown(details) as Record<string, unknown>;
  const line = JSON.stringify({
    event,
    at: new Date().toISOString(),
    ...safeDetails
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function emitRunSummary(run: RunLog): void {
  logRuntimeEvent("info", "tdf-run-finished", {
    run: summarizeRun(run)
  });
}
