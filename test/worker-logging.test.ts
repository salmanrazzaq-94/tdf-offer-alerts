import assert from "node:assert/strict";
import test from "node:test";
import { addStep, appendLog, createRun, finishRun, logRuntimeEvent, readLogs, summarizeRun } from "../worker/logging.js";
import { MemoryKV, env } from "./worker-helpers.js";

test("logging creates versioned runs, records steps, and redacts sensitive details", () => {
  const run = createRun("delta", "manual-http?token=secret");

  addStep(run, "request", "success", {
    url: "https://worker.test/logs?token=secret",
    cookie: "TNEW=secret",
    nested: {
      password: "secret"
    }
  });
  finishRun(run, "failure", {
    message: "failed at https://worker.test/logs?token=secret",
    failureKind: "unexpected"
  });

  assert.equal(run.schemaVersion, 1);
  assert.equal(run.status, "failure");
  assert.equal(run.steps[0]?.details?.["cookie"], "[redacted]");
  assert.deepEqual(run.steps[0]?.details?.["nested"], { password: "[redacted]" });
  assert.equal(run.steps[0]?.details?.["url"], "https://worker.test/logs?token=[redacted]");
  assert.equal(run.message, "failed at https://worker.test/logs?token=[redacted]");
});

test("appendLog persists failed runs and recovers corrupted RUN_LOGS state", async () => {
  const kv = new MemoryKV();
  await kv.put("RUN_LOGS", "{not-json");
  const run = createRun("logs", "test");
  finishRun(run, "failure", {
    failureKind: "unexpected",
    message: "test failure"
  });

  await appendLog(env(kv), run);

  const logs = await readLogs(env(kv));
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.event, "logs");
  assert.equal(logs[0]?.status, "failure");
});

test("appendLog emits successful runs to runtime logs without writing KV", async () => {
  const kv = new MemoryKV();
  const run = createRun("delta", "test");
  finishRun(run, "success");

  await appendLog(env(kv), run);

  assert.equal(kv.values.get("RUN_LOGS"), undefined);
});

test("summarizeRun omits step detail payloads but keeps operational counters", () => {
  const run = createRun("daily", "cron:test");
  addStep(run, "send-telegram-summary", "success", { responseBody: "ok" });
  finishRun(run, "success", {
    shows: 3,
    performances: 5,
    notificationSent: true
  });

  assert.deepEqual(summarizeRun(run), {
    id: run.id,
    event: "daily",
    status: "success",
    trigger: "cron:test",
    durationMs: run.durationMs,
    shows: 3,
    performances: 5,
    newPerformances: undefined,
    notificationSent: true,
    failureKind: undefined,
    message: undefined,
    steps: 1
  });
});

test("runtime events are structured and redact tokenized URLs", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    lines.push(String(value));
  };
  try {
    logRuntimeEvent("info", "worker-request-received", {
      path: "/logs",
      url: "https://worker.test/logs?token=secret"
    });
  } finally {
    console.log = originalLog;
  }

  const entry = JSON.parse(lines[0] ?? "{}") as { event?: string; url?: string; at?: string };
  assert.equal(entry.event, "worker-request-received");
  assert.equal(entry.url, "https://worker.test/logs?token=[redacted]");
  assert.equal(typeof entry.at, "string");
});
