import { workerVersion } from "./constants.js";
import { readAuthState, readCookieMeta, readHealthState } from "./state.js";
import type { DebugSnapshot, Env } from "./types.js";

export async function buildDebugSnapshot(env: Env): Promise<DebugSnapshot> {
  const [cookie, auth, health] = await Promise.all([
    readCookieMeta(env),
    readAuthState(env),
    readHealthState(env)
  ]);
  return {
    version: workerVersion,
    generatedAt: new Date().toISOString(),
    cookie,
    auth,
    health
  };
}
