import {
  authStateKey,
  cookieKey,
  cookieMetaKey,
  cookieRefreshPersistIntervalMs,
  deltaLockKey,
  deltaLockTtlMs,
  healthStateKey,
  healthStateWriteIntervalMs,
  seenKey
} from "./constants.js";
import { addStep } from "./logging.js";
import type { AuthState, CookieMeta, CookieSaveMetadata, Env, HealthState, RunLog } from "./types.js";
import { errorMessage, TdfError } from "./utils.js";

const emergencyCookieFallbackUrl = "https://tdf-offer-alerts.internal/emergency-cookie-fallback";
const emergencyCookieFallbackTtlSeconds = 24 * 60 * 60;
let emergencyCookieFallback: { cookie: string; savedAt: string } | null = null;

export function resetCookieFallbackForTest(): void {
  emergencyCookieFallback = null;
}

export async function readCookie(env: Env, run: RunLog): Promise<string> {
  const started = Date.now();
  const cookie = await env.TDF_ALERTS.get(cookieKey);
  const fallback = await readEmergencyCookieFallback();
  const meta = await readCookieMeta(env);
  if (fallback && isFallbackNewerThanKv(fallback.savedAt, meta)) {
    addStep(run, "read-cookie", "success", {
      durationMs: Date.now() - started,
      cookieBytes: fallback.cookie.length,
      hasSessionCookie: fallback.cookie.includes(".TDFCustomOfferings.Session"),
      hasTnewCookie: fallback.cookie.includes("TNEW"),
      source: "emergency-fallback",
      savedAt: fallback.savedAt
    });
    return fallback.cookie;
  }
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
  run: RunLog,
  now = new Date()
): Promise<boolean> {
  if (originalCookie === refreshedCookie) {
    addStep(run, "persist-refreshed-cookie", "skipped", {
      reason: "TDF did not send updated cookie values."
    });
    return false;
  }

  const started = Date.now();
  const meta = await readCookieMeta(env);
  const importantCookieChanged = didImportantCookieChange(originalCookie, refreshedCookie);
  const lastPersistedAt = meta.savedAt ? new Date(meta.savedAt).valueOf() : 0;
  const shouldPersistIncidentalChange =
    !lastPersistedAt || now.valueOf() - lastPersistedAt >= cookieRefreshPersistIntervalMs;

  if (!importantCookieChanged && !shouldPersistIncidentalChange) {
    addStep(run, "persist-refreshed-cookie", "skipped", {
      durationMs: Date.now() - started,
      reason: "Only incidental cookie values changed recently.",
      lastPersistedAt: meta.savedAt,
      nextPersistAfterMs: cookieRefreshPersistIntervalMs - (now.valueOf() - lastPersistedAt),
      oldCookieBytes: originalCookie.length,
      newCookieBytes: refreshedCookie.length
    });
    return false;
  }

  try {
    await saveCookie(env, refreshedCookie, "tdf-set-cookie", run, started);
    addStep(run, "persist-refreshed-cookie", "success", {
      durationMs: Date.now() - started,
      oldCookieBytes: originalCookie.length,
      newCookieBytes: refreshedCookie.length,
      reason: importantCookieChanged ? "important-cookie-changed" : "refresh-cadence"
    });
    return true;
  } catch (error) {
    addStep(run, "persist-refreshed-cookie", "failure", {
      durationMs: Date.now() - started,
      message: errorMessage(error),
      reason: "Continuing with the current TDF response; refreshed cookie persistence is best effort."
    });
    await writeEmergencyCookieFallback(refreshedCookie, run, started);
    return false;
  }
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

export async function writeSeen(env: Env, seen: Set<string>, run: RunLog): Promise<boolean> {
  const started = Date.now();
  const next = JSON.stringify([...seen].sort());
  const current = await env.TDF_ALERTS.get(seenKey);
  if (current === next) {
    addStep(run, "write-seen-state", "skipped", {
      durationMs: Date.now() - started,
      seenCount: seen.size,
      reason: "Seen state is unchanged."
    });
    return false;
  }

  try {
    await env.TDF_ALERTS.put(seenKey, next);
    addStep(run, "write-seen-state", "success", {
      durationMs: Date.now() - started,
      seenCount: seen.size
    });
    return true;
  } catch (error) {
    addStep(run, "write-seen-state", "failure", {
      durationMs: Date.now() - started,
      seenCount: seen.size,
      message: errorMessage(error),
      reason: "Continuing after seen-state persistence failed; duplicate alerts may repeat until KV writes recover."
    });
    return false;
  }
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

export async function clearAuthState(env: Env, run: RunLog): Promise<boolean> {
  const raw = await env.TDF_ALERTS.get(authStateKey);
  if (!raw) {
    addStep(run, "clear-auth-state", "skipped", {
      reason: "Auth state is already clear."
    });
    return false;
  }

  let parsed: Partial<AuthState>;
  try {
    parsed = JSON.parse(raw) as Partial<AuthState>;
  } catch (error) {
    try {
      await env.TDF_ALERTS.put(authStateKey, JSON.stringify(emptyAuthState()));
      addStep(run, "clear-auth-state", "success", {
        recovered: true,
        message: errorMessage(error)
      });
      return true;
    } catch (writeError) {
      addStep(run, "clear-auth-state", "failure", {
        recovered: true,
        message: errorMessage(writeError),
        parseError: errorMessage(error)
      });
      return false;
    }
  }

  if (
    parsed.lastFailureNotifiedAt == null &&
    parsed.lastFailureKind == null &&
    parsed.lastFailureReason == null &&
    parsed.lastRefreshAttemptedAt == null &&
    parsed.lastRefreshAttemptStatus == null
  ) {
    addStep(run, "clear-auth-state", "skipped", {
      reason: "Auth state is already clear."
    });
    return false;
  }

  try {
    await env.TDF_ALERTS.put(authStateKey, JSON.stringify(emptyAuthState()));
    addStep(run, "clear-auth-state", "success");
    return true;
  } catch (error) {
    addStep(run, "clear-auth-state", "failure", {
      message: errorMessage(error)
    });
    return false;
  }
}

export async function writeAuthState(env: Env, state: AuthState): Promise<boolean> {
  try {
    await env.TDF_ALERTS.put(authStateKey, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
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

  try {
    await env.TDF_ALERTS.put(
      deltaLockKey,
      JSON.stringify({
        owner: run.id,
        acquiredAt: new Date().toISOString()
      }),
      { expirationTtl: Math.ceil(deltaLockTtlMs / 1000) }
    );
    addStep(run, "acquire-delta-lock", "success", {
      durationMs: Date.now() - started,
      owner: run.id
    });
    return { acquired: true, owner: run.id };
  } catch (error) {
    addStep(run, "acquire-delta-lock", "failure", {
      durationMs: Date.now() - started,
      message: errorMessage(error),
      reason: "Continuing without a persisted cron lock."
    });
    return { acquired: true, owner: "lockless" };
  }
}

export function releaseDeltaLock(_env: Env, run: RunLog): void {
  addStep(run, "release-delta-lock", "skipped", {
    reason: "Delta lock uses KV expiration TTL; skipping delete to reduce write usage."
  });
}

export async function readHealthState(env: Env): Promise<HealthState> {
  const raw = await env.TDF_ALERTS.get(healthStateKey);
  if (!raw) {
    return emptyHealthState();
  }
  let parsed: Partial<HealthState>;
  try {
    parsed = JSON.parse(raw) as Partial<HealthState>;
  } catch {
    parsed = {};
  }
  return {
    lastStaleNotifiedAt: parsed.lastStaleNotifiedAt ?? null,
    lastDeltaSuccessAt: parsed.lastDeltaSuccessAt ?? null
  };
}

export async function recordDeltaSuccess(env: Env, run: RunLog, now = new Date()): Promise<boolean> {
  const started = Date.now();
  const state = await readHealthState(env);
  const previousSuccessAt = state.lastDeltaSuccessAt ? new Date(state.lastDeltaSuccessAt).valueOf() : 0;
  if (previousSuccessAt && now.valueOf() - previousSuccessAt < healthStateWriteIntervalMs) {
    addStep(run, "write-health-state", "skipped", {
      durationMs: Date.now() - started,
      lastDeltaSuccessAt: state.lastDeltaSuccessAt,
      reason: "Recent delta success is already recorded."
    });
    return false;
  }

  const next: HealthState = {
    ...state,
    lastDeltaSuccessAt: now.toISOString()
  };
  try {
    await env.TDF_ALERTS.put(healthStateKey, JSON.stringify(next));
    addStep(run, "write-health-state", "success", {
      durationMs: Date.now() - started,
      lastDeltaSuccessAt: next.lastDeltaSuccessAt
    });
    return true;
  } catch (error) {
    addStep(run, "write-health-state", "failure", {
      durationMs: Date.now() - started,
      message: errorMessage(error),
      reason: "Continuing after health-state persistence failed; stale-success detection may be limited until KV writes recover."
    });
    return false;
  }
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

function emptyHealthState(): HealthState {
  return {
    lastStaleNotifiedAt: null,
    lastDeltaSuccessAt: null
  };
}

function parseSeen(raw: string): Set<string> {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new TdfError("Seen state in KV is invalid.", "unexpected");
  }
  return new Set(parsed);
}

function didImportantCookieChange(originalCookie: string, refreshedCookie: string): boolean {
  const original = parseCookieValues(originalCookie);
  const refreshed = parseCookieValues(refreshedCookie);
  return (
    original.get("TNEW") !== refreshed.get("TNEW") ||
    original.get(".TDFCustomOfferings.Session") !== refreshed.get(".TDFCustomOfferings.Session")
  );
}

function parseCookieValues(cookie: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 0) {
      continue;
    }
    values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return values;
}

function isFallbackNewerThanKv(fallbackSavedAt: string, meta: CookieMeta): boolean {
  if (!meta.savedAt) {
    return true;
  }
  return new Date(fallbackSavedAt).valueOf() > new Date(meta.savedAt).valueOf();
}

async function writeEmergencyCookieFallback(cookie: string, run: RunLog, started: number): Promise<void> {
  const savedAt = new Date().toISOString();
  emergencyCookieFallback = { cookie, savedAt };
  const details = {
    durationMs: Date.now() - started,
    cookieBytes: cookie.length,
    savedAt,
    cacheWritten: false
  };
  try {
    const cache = await emergencyCookieCache();
    if (cache) {
      await cache.put(
        new Request(emergencyCookieFallbackUrl),
        new Response(JSON.stringify({ cookie, savedAt }), {
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${emergencyCookieFallbackTtlSeconds}`
          }
        })
      );
      addStep(run, "write-emergency-cookie-fallback", "success", {
        ...details,
        cacheWritten: true
      });
      return;
    }
    addStep(run, "write-emergency-cookie-fallback", "success", {
      ...details,
      reason: "Cache API is unavailable; in-memory fallback only."
    });
  } catch (error) {
    addStep(run, "write-emergency-cookie-fallback", "failure", {
      ...details,
      message: errorMessage(error),
      reason: "In-memory fallback was set, but Cache API fallback failed."
    });
  }
}

async function readEmergencyCookieFallback(): Promise<{ cookie: string; savedAt: string } | null> {
  if (emergencyCookieFallback) {
    return emergencyCookieFallback;
  }
  try {
    const cache = await emergencyCookieCache();
    const response = await cache?.match(new Request(emergencyCookieFallbackUrl));
    if (!response) {
      return null;
    }
    const parsed: Partial<{ cookie: string; savedAt: string }> = await response.json();
    if (typeof parsed.cookie !== "string" || typeof parsed.savedAt !== "string") {
      return null;
    }
    emergencyCookieFallback = { cookie: parsed.cookie, savedAt: parsed.savedAt };
    return emergencyCookieFallback;
  } catch {
    return null;
  }
}

async function emergencyCookieCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") {
    return null;
  }
  const cacheStorage = caches as CacheStorage & { default?: Cache };
  if (typeof cacheStorage.open === "function") {
    return cacheStorage.open("tdf-emergency-cookie-fallback");
  }
  return cacheStorage.default ?? null;
}
