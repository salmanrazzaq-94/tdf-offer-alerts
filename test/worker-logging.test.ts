import assert from "node:assert/strict";
import test from "node:test";
import { addStep, appendLog, createRun, finishRun, logRuntimeEvent, summarizeRun } from "../worker/logging.js";
import { captureRuntimeEvents, lastRunEvent, MemoryKV } from "./worker-helpers.js";

test("logging creates versioned runs, records steps, and redacts sensitive details", () => {
  const run = createRun("delta", "manual-http?token=secret");

  addStep(run, "request", "success", {
    url: "https://worker.test/cookie?token=secret",
    cookie: "TNEW=secret",
    nested: {
      password: "secret"
    }
  });
  finishRun(run, "failure", {
    message: "failed at https://worker.test/cookie?token=secret",
    failureKind: "unexpected"
  });

  assert.equal(run.schemaVersion, 1);
  assert.equal(run.status, "failure");
  assert.equal(run.steps[0]?.details?.["cookie"], "[redacted]");
  assert.deepEqual(run.steps[0]?.details?.["nested"], { password: "[redacted]" });
  assert.equal(run.steps[0]?.details?.["url"], "https://worker.test/cookie?token=[redacted]");
  assert.equal(run.message, "failed at https://worker.test/cookie?token=[redacted]");
});

test("appendLog emits failed runs to runtime logs", async () => {
  const kv = new MemoryKV();
  const run = createRun("delta", "test");
  finishRun(run, "failure", {
    failureKind: "unexpected",
    message: "test failure"
  });

  const events = await captureRuntimeEvents(async () => {
    appendLog(run);
  });

  const entry = lastRunEvent(events);
  const summary = entry["run"] as { event?: string; status?: string; message?: string };
  assert.equal(summary.event, "delta");
  assert.equal(summary.status, "failure");
  assert.equal(summary.message, "test failure");
  assert.deepEqual(kv.writes, []);
});

test("appendLog emits successful runs to runtime logs without writing KV", async () => {
  const kv = new MemoryKV();
  const run = createRun("delta", "test");
  finishRun(run, "success");

  const events = await captureRuntimeEvents(async () => {
    appendLog(run);
  });

  const summary = lastRunEvent(events)["run"] as { event?: string; status?: string };
  assert.equal(summary.event, "delta");
  assert.equal(summary.status, "success");
  assert.deepEqual(kv.writes, []);
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
    sourceRunId: undefined,
    externalRunUrl: undefined,
    environment: undefined,
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
      path: "/cookie",
      url: "https://worker.test/cookie?token=secret"
    });
  } finally {
    console.log = originalLog;
  }

  const entry = JSON.parse(lines[0] ?? "{}") as { event?: string; url?: string; at?: string };
  assert.equal(entry.event, "worker-request-received");
  assert.equal(entry.url, "https://worker.test/cookie?token=[redacted]");
  assert.equal(typeof entry.at, "string");
});
