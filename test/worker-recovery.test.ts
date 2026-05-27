import assert from "node:assert/strict";
import test from "node:test";
import { createRun } from "../worker/logging.js";
import {
  handleCheckFailure,
  maybeTriggerBrowserbaseRefresh,
  recordBrowserbaseRefreshFailure,
  resetBrowserbaseRefreshMemoryForTest
} from "../worker/recovery.js";
import { TdfError } from "../worker/utils.js";
import { captureRuntimeEvents, env, envWithoutGithubRefresh, lastRunEvent, MemoryKV, response, withFetch } from "./worker-helpers.js";

test("Browserbase refresh dispatch records the GitHub target and source run id", async () => {
  resetBrowserbaseRefreshMemoryForTest();
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
  resetBrowserbaseRefreshMemoryForTest();
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
  resetBrowserbaseRefreshMemoryForTest();
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

test("Browserbase refresh dispatch is in-memory throttled when KV auth state cannot be saved", async () => {
  resetBrowserbaseRefreshMemoryForTest();
  class PutFailingKV extends MemoryKV {
    override async put(): Promise<void> {
      throw new Error("KV put() limit exceeded for the day.");
    }
  }
  const kv = new PutFailingKV();
  let dispatches = 0;

  await withFetch(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("api.github.com")) {
      dispatches += 1;
      return response(null, { status: 204, url });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }, async () => {
    const firstRun = createRun("delta", "cron:*/10 * * * *");
    await handleCheckFailure(env(kv), firstRun, new TdfError("login expired", "auth"));

    const secondRun = createRun("delta", "cron:*/10 * * * *");
    await handleCheckFailure(env(kv), secondRun, new TdfError("login expired", "auth"));

    assert.equal(dispatches, 1);
    const dispatchStep = secondRun.steps.find((step) => step.name === "browserbase-refresh-dispatch");
    assert.equal(dispatchStep?.status, "skipped");
    assert.equal(dispatchStep?.details?.["lastRefreshAttemptStatus"], "started");
    assert.equal(dispatchStep?.details?.["source"], "memory");
  });
});

test("refresh failure callback logs suppressed CI failures without Telegram noise", async () => {
  resetBrowserbaseRefreshMemoryForTest();
  const kv = new MemoryKV();

  const events = await captureRuntimeEvents(async () => {
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
  });

  const run = lastRunEvent(events)["run"] as { event?: string; status?: string; notificationSent?: boolean };
  assert.equal(run.event, "refresh");
  assert.equal(run.status, "failure");
  assert.equal(run.notificationSent, false);
});

test("refresh failure callback persists Telegram notification failures", async () => {
  resetBrowserbaseRefreshMemoryForTest();
  const kv = new MemoryKV();

  const events = await captureRuntimeEvents(async () => {
    await withFetch(async () => response("telegram down", { status: 500 }), async () => {
      const run = await recordBrowserbaseRefreshFailure(new Request("https://worker.test/refresh-failed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Browserbase failed",
          source_run_id: "worker-run-2"
        })
      }), env(kv));

      assert.equal(run.status, "failure");
      assert.equal(run.notificationSent, false);
      assert.ok(run.steps.some((step) => `${step.name}:${step.status}` === "send-browserbase-refresh-failed:failure"));
    });
  });

  const entry = lastRunEvent(events);
  const run = entry["run"] as { event?: string; status?: string; notificationSent?: boolean };
  const stepSummaries = entry["stepSummaries"] as Array<{ name: string; status: string; details?: Record<string, unknown> }>;
  assert.equal(run.event, "refresh");
  assert.equal(run.status, "failure");
  assert.equal(run.notificationSent, false);
  const sendStep = stepSummaries.find((step) => step.name === "send-browserbase-refresh-failed");
  assert.equal(sendStep?.status, "failure");
  assert.match(String(sendStep?.details?.["message"]), /telegram down/);
});
