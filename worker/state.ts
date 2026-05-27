import { authStateKey, cookieKey, cookieMetaKey, deltaLockKey, deltaLockTtlMs, healthStateKey, seenKey } from "./constants.js";
import { addStep } from "./logging.js";
import type { AuthState, CookieMeta, CookieSaveMetadata, Env, HealthState, RunLog } from "./types.js";
import { errorMessage, TdfError } from "./utils.js";

export async function readCookie(env: Env, run: RunLog): Promise<string> {
  const started = Date.now();
  const cookie = await env.TDF_ALERTS.get(cookieKey);
  if (!cookie) {
    addStep(run, "read-cookie", "failure", { durationMs: Date.now() - started });
    throw new TdfError("No TDF cookie saved in Cloudflare KV.", "auth");
  }
  addStep(run, "read-cookie", "success", {
    durationMs: Date.now() - started,
    cookieBytes: cookie.length,
    hasSessionCookie: cookie.includes(".TDFCustomOfferings.Session"),
    hasTnewCookie: cookie.includes("TNEW")
  });
  return cookie;
}

export async function persistRefreshedCookie(
  env: Env,
  originalCookie: string,
  refreshedCookie: string,
  run: RunLog
): Promise<void> {
  if (originalCookie === refreshedCookie) {
    addStep(run, "persist-refreshed-cookie", "skipped", {
      reason: "TDF did not send updated cookie values."
    });
    return;
  }

  const started = Date.now();
  await saveCookie(env, refreshedCookie, "tdf-set-cookie", run, started);
  addStep(run, "persist-refreshed-cookie", "success", {
    durationMs: Date.now() - started,
    oldCookieBytes: originalCookie.length,
    newCookieBytes: refreshedCookie.length
  });
}

export async function saveCookie(
  env: Env,
  cookie: string,
  source: string,
  run?: RunLog,
  started = Date.now(),
  metadata: CookieSaveMetadata = {}
): Promise<void> {
  await env.TDF_ALERTS.put(cookieKey, cookie);
  const cookieMeta: CookieMeta = {
    savedAt: new Date().toISOString(),
    source,
    cookieBytes: cookie.length,
    hasSessionCookie: cookie.includes(".TDFCustomOfferings.Session"),
    hasTnewCookie: cookie.includes("TNEW")
  };
  if (metadata.sourceRunId) {
    cookieMeta.sourceRunId = metadata.sourceRunId;
  }
  if (metadata.externalRunUrl) {
    cookieMeta.externalRunUrl = metadata.externalRunUrl;
  }
  if (metadata.browserbaseSessionId) {
    cookieMeta.browserbaseSessionId = metadata.browserbaseSessionId;
  }
  await env.TDF_ALERTS.put(cookieMetaKey, JSON.stringify(cookieMeta));
  if (run && source !== "tdf-set-cookie") {
    addStep(run, "save-cookie", "success", {
      durationMs: Date.now() - started,
      source,
      cookieBytes: cookie.length,
      ...metadata
    });
  }
}

export async function readCookieMeta(env: Env): Promise<CookieMeta> {
  const raw = await env.TDF_ALERTS.get(cookieMetaKey);
  if (!raw) {
    const cookie = await env.TDF_ALERTS.get(cookieKey);
    return {
      savedAt: null,
      source: null,
      cookieBytes: cookie?.length ?? 0,
      hasSessionCookie: cookie?.includes(".TDFCustomOfferings.Session") ?? false,
      hasTnewCookie: cookie?.includes("TNEW") ?? false
    };
  }
  let parsed: Partial<CookieMeta>;
  try {
    parsed = JSON.parse(raw) as Partial<CookieMeta>;
  } catch {
    parsed = {};
  }
  const result: CookieMeta = {
    savedAt: parsed.savedAt ?? null,
    source: parsed.source ?? null,
    cookieBytes: parsed.cookieBytes ?? 0,
    hasSessionCookie: parsed.hasSessionCookie ?? false,
    hasTnewCookie: parsed.hasTnewCookie ?? false
  };
  if (parsed.sourceRunId) {
    result.sourceRunId = parsed.sourceRunId;
  }
  if (parsed.externalRunUrl) {
    result.externalRunUrl = parsed.externalRunUrl;
  }
  if (parsed.browserbaseSessionId) {
    result.browserbaseSessionId = parsed.browserbaseSessionId;
  }
  return result;
}

export function normalizeCookie(cookie: string): string {
  const cleanCookie = cookie.trim().replace(/^Cookie:\s*/i, "");
  if (!cleanCookie.includes(".TDFCustomOfferings.Session") && !cleanCookie.includes("TNEW")) {
    throw new TdfError("Cookie does not include expected TDF session cookies.", "auth");
  }
  return cleanCookie;
}

export async function readSeen(
  env: Env,
  run: RunLog
): Promise<{ seen: Set<string>; recovered: boolean }> {
  const started = Date.now();
  const raw = await env.TDF_ALERTS.get(seenKey);
  if (!raw) {
    addStep(run, "read-seen-state", "success", {
      durationMs: Date.now() - started,
      seenCount: 0,
      recovered: false
    });
    return { seen: new Set<string>(), recovered: false };
  }

  let seen: Set<string>;
  try {
    seen = parseSeen(raw);
  } catch (error) {
    addStep(run, "read-seen-state", "failure", {
      durationMs: Date.now() - started,
      message: errorMessage(error),
      recovered: true
    });
    return { seen: new Set<string>(), recovered: true };
  }

  addStep(run, "read-seen-state", "success", {
    durationMs: Date.now() - started,
    seenCount: seen.size,
    recovered: false
  });
  return { seen, recovered: false };
}

export async function writeSeen(env: Env, seen: Set<string>, run: RunLog): Promise<void> {
  const started = Date.now();
  await env.TDF_ALERTS.put(seenKey, JSON.stringify([...seen].sort()));
  addStep(run, "write-seen-state", "success", {
    durationMs: Date.now() - started,
    seenCount: seen.size
  });
}

export async function readAuthState(env: Env): Promise<AuthState> {
  const raw = await env.TDF_ALERTS.get(authStateKey);
  if (!raw) {
    return emptyAuthState();
  }
  let parsed: Partial<AuthState>;
  try {
    parsed = JSON.parse(raw) as Partial<AuthState>;
  } catch {
    parsed = {};
  }
  return {
    lastFailureNotifiedAt: parsed.lastFailureNotifiedAt ?? null,
    lastFailureKind: parsed.lastFailureKind ?? null,
    lastFailureReason: parsed.lastFailureReason ?? null,
    lastRefreshAttemptedAt: parsed.lastRefreshAttemptedAt ?? null,
    lastRefreshAttemptStatus: parsed.lastRefreshAttemptStatus ?? null
  };
}

export async function clearAuthState(env: Env, run: RunLog): Promise<void> {
  await env.TDF_ALERTS.put(authStateKey, JSON.stringify(emptyAuthState()));
  addStep(run, "clear-auth-state", "success");
}

export async function writeAuthState(env: Env, state: AuthState): Promise<void> {
  await env.TDF_ALERTS.put(authStateKey, JSON.stringify(state));
}

export async function acquireDeltaLock(env: Env, run: RunLog): Promise<{ acquired: boolean; owner: string }> {
  const started = Date.now();
  const raw = await env.TDF_ALERTS.get(deltaLockKey);
  if (raw) {
    let lock: { owner?: string; acquiredAt?: string };
    try {
      lock = JSON.parse(raw) as { owner?: string; acquiredAt?: string };
    } catch (error) {
      addStep(run, "read-delta-lock", "failure", {
        durationMs: Date.now() - started,
        message: errorMessage(error),
        recovered: true
      });
      lock = {};
    }
    const acquiredAt = lock.acquiredAt ? new Date(lock.acquiredAt).valueOf() : 0;
    if (acquiredAt && Date.now() - acquiredAt < deltaLockTtlMs) {
      addStep(run, "acquire-delta-lock", "skipped", {
        durationMs: Date.now() - started,
        owner: lock.owner,
        acquiredAt: lock.acquiredAt,
        ageMs: Date.now() - acquiredAt
      });
      return { acquired: false, owner: lock.owner ?? "unknown" };
    }
  }

  await env.TDF_ALERTS.put(
    deltaLockKey,
    JSON.stringify({
      owner: run.id,
      acquiredAt: new Date().toISOString()
    })
  );
  addStep(run, "acquire-delta-lock", "success", {
    durationMs: Date.now() - started,
    owner: run.id
  });
  return { acquired: true, owner: run.id };
}

export async function releaseDeltaLock(env: Env, run: RunLog): Promise<void> {
  const started = Date.now();
  await env.TDF_ALERTS.delete(deltaLockKey);
  addStep(run, "release-delta-lock", "success", { durationMs: Date.now() - started });
}

export async function readHealthState(env: Env): Promise<HealthState> {
  const raw = await env.TDF_ALERTS.get(healthStateKey);
  if (!raw) {
    return { lastStaleNotifiedAt: null };
  }
  let parsed: Partial<HealthState>;
  try {
    parsed = JSON.parse(raw) as Partial<HealthState>;
  } catch {
    parsed = {};
  }
  return { lastStaleNotifiedAt: parsed.lastStaleNotifiedAt ?? null };
}

function emptyAuthState(): AuthState {
  return {
    lastFailureNotifiedAt: null,
    lastFailureKind: null,
    lastFailureReason: null,
    lastRefreshAttemptedAt: null,
    lastRefreshAttemptStatus: null
  };
}

function parseSeen(raw: string): Set<string> {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new TdfError("Seen state in KV is invalid.", "unexpected");
  }
  return new Set(parsed);
}
