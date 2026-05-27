import assert from "node:assert/strict";
import test from "node:test";
import { createRun } from "../worker/logging.js";
import {
  acquireDeltaLock,
  normalizeCookie,
  readCookie,
  readCookieMeta,
  readSeen,
  saveCookie
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
