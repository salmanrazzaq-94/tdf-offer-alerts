import { workerVersion } from "./constants.js";
import { readLogs } from "./logging.js";
import { readAuthState, readCookieMeta, readHealthState } from "./state.js";
import type { DebugSnapshot, Env } from "./types.js";

export async function buildDebugSnapshot(env: Env): Promise<DebugSnapshot> {
  const [logs, cookie, auth, health] = await Promise.all([
    readLogs(env),
    readCookieMeta(env),
    readAuthState(env),
    readHealthState(env)
  ]);
  const lastRun = logs.at(-1) ?? null;
  const lastSuccess = [...logs].reverse().find((log) => log.status === "success") ?? null;
  const lastFailure = [...logs].reverse().find((log) => log.status === "failure") ?? null;
  return {
    version: workerVersion,
    generatedAt: new Date().toISOString(),
    cookie,
    auth,
    health,
    lastSuccess,
    lastFailure,
    lastRun,
    recentRuns: logs.slice(-10).map((log) => ({
      finishedAt: log.finishedAt,
      event: log.event,
      status: log.status,
      trigger: log.trigger,
      shows: log.shows,
      performances: log.performances,
      newPerformances: log.newPerformances,
      failureKind: log.failureKind,
      message: log.message
    }))
  };
}
