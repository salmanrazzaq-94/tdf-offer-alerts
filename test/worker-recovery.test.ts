import assert from "node:assert/strict";
import test from "node:test";
import { createRun } from "../worker/logging.js";
import { maybeTriggerBrowserbaseRefresh, recordBrowserbaseRefreshFailure } from "../worker/recovery.js";
import { env, envWithoutGithubRefresh, MemoryKV, response, withFetch } from "./worker-helpers.js";

test("Browserbase refresh dispatch records the GitHub target and source run id", async () => {
  const kv = new MemoryKV();
  const run = createRun("delta", "test");
  let requestBody = "";

  await withFetch(async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = typeof init?.body === "string" ? init.body : "";
    return response(null, { status: 204, url: "https://api.github.com/repos/owner/repo/actions/workflows/refresh-cookie.yml/dispatches" });
  }, async () => {
    const result = await maybeTriggerBrowserbaseRefresh(env(kv), run, {
      lastFailureNotifiedAt: null,
      lastFailureKind: null,
      lastFailureReason: null,
      lastRefreshAttemptedAt: null,
      lastRefreshAttemptStatus: null
    }, "auth", "login expired");

    assert.equal(result.status, "started");
  });

  assert.match(requestBody, new RegExp(run.id));
  const dispatchStep = run.steps.find((step) => step.name === "browserbase-refresh-dispatch");
  assert.equal(dispatchStep?.status, "success");
  assert.equal(dispatchStep?.details?.["repository"], "owner/repo");
});

test("Browserbase refresh dispatch skips when GitHub config is missing", async () => {
  const run = createRun("delta", "test");

  const result = await maybeTriggerBrowserbaseRefresh(envWithoutGithubRefresh(), run, {
    lastFailureNotifiedAt: null,
    lastFailureKind: null,
    lastFailureReason: null,
    lastRefreshAttemptedAt: null,
    lastRefreshAttemptStatus: null
  }, "auth", "login expired");

  assert.equal(result.status, "not-configured");
  assert.equal(run.steps[0]?.name, "browserbase-refresh-dispatch");
  assert.equal(run.steps[0]?.status, "skipped");
});

test("Browserbase dispatch failures preserve the GitHub response in step details", async () => {
  const run = createRun("delta", "test");

  await withFetch(async () => response("bad credentials", { status: 401 }), async () => {
    const result = await maybeTriggerBrowserbaseRefresh(env(), run, {
      lastFailureNotifiedAt: null,
      lastFailureKind: null,
      lastFailureReason: null,
      lastRefreshAttemptedAt: null,
      lastRefreshAttemptStatus: null
    }, "auth", "login expired");

    assert.equal(result.status, "dispatch-failed");
    assert.match(result.failureReason ?? "", /GitHub dispatch returned 401/);
  });

  const dispatchStep = run.steps.find((step) => step.name === "browserbase-refresh-dispatch");
  assert.equal(dispatchStep?.status, "failure");
  assert.equal(dispatchStep?.details?.["status"], 401);
});

test("refresh failure callback logs suppressed CI failures without Telegram noise", async () => {
  const kv = new MemoryKV();

  await withFetch(async () => {
    throw new Error("Telegram send should not be called.");
  }, async () => {
    const run = await recordBrowserbaseRefreshFailure(new Request("https://worker.test/refresh-failed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        notify: "false",
        reason: "CI callback",
        source_run_id: "worker-run-1"
      })
    }), env(kv));

    assert.equal(run.status, "failure");
    assert.equal(run.notificationSent, false);
    assert.equal(run.sourceRunId, "worker-run-1");
  });

  const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{ event: string; sourceRunId?: string }>;
  assert.equal(logs.at(-1)?.event, "refresh");
  assert.equal(logs.at(-1)?.sourceRunId, "worker-run-1");
});
