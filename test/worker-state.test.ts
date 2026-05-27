import assert from "node:assert/strict";
import test from "node:test";
import { createRun } from "../worker/logging.js";
import {
  acquireDeltaLock,
  clearAuthState,
  normalizeCookie,
  persistRefreshedCookie,
  readCookie,
  readCookieMeta,
  readSeen,
  resetCookieFallbackForTest,
  saveCookie,
  writeSeen
} from "../worker/state.js";
import { MemoryKV, env } from "./worker-helpers.js";

test("cookie metadata records provenance without storing the cookie value in logs", async () => {
  const kv = new MemoryKV();
  const run = createRun("cookie", "test");

  await saveCookie(
    env(kv),
    "TNEW=fresh; .TDFCustomOfferings.Session=session",
    "browserbase-refresh",
    run,
    Date.now(),
    {
      sourceRunId: "worker-run-1",
      externalRunUrl: "https://github.com/owner/repo/actions/runs/1",
      browserbaseSessionId: "session-1"
    }
  );

  const meta = await readCookieMeta(env(kv));
  assert.equal(meta.source, "browserbase-refresh");
  assert.equal(meta.sourceRunId, "worker-run-1");
  assert.equal(meta.externalRunUrl, "https://github.com/owner/repo/actions/runs/1");
  assert.equal(meta.browserbaseSessionId, "session-1");
  assert.equal(typeof run.steps[0]?.details?.["cookieBytes"], "number");
  assert.ok(Number(run.steps[0]?.details?.["cookieBytes"]) > 0);
  assert.equal(JSON.stringify(run.steps).includes("session=session"), false);
});

test("seen state corruption is recovered and logged on the active run", async () => {
  const kv = new MemoryKV();
  await kv.put("SEEN_OFFERS", "{not-json");
  const run = createRun("delta", "test");

  const result = await readSeen(env(kv), run);

  assert.equal(result.recovered, true);
  assert.equal(result.seen.size, 0);
  assert.equal(run.steps[0]?.name, "read-seen-state");
  assert.equal(run.steps[0]?.status, "failure");
  assert.equal(run.steps[0]?.details?.["recovered"], true);
});

test("writeSeen skips KV writes when seen state is unchanged", async () => {
  const kv = new MemoryKV();
  await kv.put("SEEN_OFFERS", JSON.stringify(["1:10"]));
  kv.writes.length = 0;
  const run = createRun("delta", "test");

  await writeSeen(env(kv), new Set(["1:10"]), run);

  assert.deepEqual(kv.writes, []);
  assert.equal(run.steps[0]?.name, "write-seen-state");
  assert.equal(run.steps[0]?.status, "skipped");
});

test("refreshed cookie falls back to Worker memory when KV writes are exhausted", async () => {
  resetCookieFallbackForTest();
  class PutFailingKV extends MemoryKV {
    override async put(): Promise<void> {
      throw new Error("KV put() limit exceeded for the day.");
    }
  }
  const kv = new PutFailingKV();
  kv.values.set("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=old");
  const run = createRun("delta", "test");

  await persistRefreshedCookie(
    env(kv),
    "TNEW=old; .TDFCustomOfferings.Session=old",
    "TNEW=fresh; .TDFCustomOfferings.Session=fresh",
    run
  );

  const readRun = createRun("delta", "test");
  const cookie = await readCookie(env(kv), readRun);

  assert.equal(cookie, "TNEW=fresh; .TDFCustomOfferings.Session=fresh");
  assert.equal(readRun.steps[0]?.details?.["source"], "emergency-fallback");
  resetCookieFallbackForTest();
});

test("clearAuthState skips KV writes when auth state is already clear", async () => {
  const kv = new MemoryKV();
  const run = createRun("delta", "test");

  await clearAuthState(env(kv), run);

  assert.deepEqual(kv.writes, []);
  assert.equal(run.steps[0]?.name, "clear-auth-state");
  assert.equal(run.steps[0]?.status, "skipped");
});

test("delta lock corruption recovers into a new lock owner", async () => {
  const kv = new MemoryKV();
  await kv.put("DELTA_LOCK", "{not-json");
  const run = createRun("delta", "cron:test");

  const lock = await acquireDeltaLock(env(kv), run);

  assert.equal(lock.acquired, true);
  assert.equal(lock.owner, run.id);
  assert.ok(run.steps.some((step) => `${step.name}:${step.status}` === "read-delta-lock:failure"));
  assert.ok(run.steps.some((step) => `${step.name}:${step.status}` === "acquire-delta-lock:success"));
});

test("readCookie classifies a missing cookie as an auth failure", async () => {
  const run = createRun("verify", "test");

  await assert.rejects(
    () => readCookie(env(new MemoryKV()), run),
    /No TDF cookie saved/
  );
  assert.equal(run.steps[0]?.name, "read-cookie");
  assert.equal(run.steps[0]?.status, "failure");
});

test("normalizeCookie accepts Cookie-prefixed values and rejects unrelated text", () => {
  assert.equal(normalizeCookie("Cookie: TNEW=fresh"), "TNEW=fresh");
  assert.throws(() => normalizeCookie("foo=bar"), /expected TDF session cookies/);
});
