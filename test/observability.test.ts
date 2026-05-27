import assert from "node:assert/strict";
import test from "node:test";
import { createOperationLogger, sanitizeForLog } from "../src/observability.js";

test("sanitizeForLog redacts credentials while keeping safe operational counters", () => {
  assert.deepEqual(sanitizeForLog({
    url: "https://worker.test/cookie?token=secret",
    cookie: "TNEW=secret",
    password: "secret",
    cookieBytes: 47,
    hasSessionCookie: true
  }), {
    url: "https://worker.test/cookie?token=[redacted]",
    cookie: "[redacted]",
    password: "[redacted]",
    cookieBytes: 47,
    hasSessionCookie: true
  });
});

test("operation logger emits structured start, success, and failure events", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (value?: unknown) => {
    lines.push(String(value));
  };
  console.error = (value?: unknown) => {
    lines.push(String(value));
  };
  try {
    const logger = createOperationLogger("test-operation");
    await logger.step("happy-path", async () => "ok", { cookieBytes: 12 });
    await assert.rejects(
      () => logger.step("sad-path", async () => {
        throw new Error("failed with token=secret");
      }),
      /failed/
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(lines.length, 4);
  const events = lines.map((line) => JSON.parse(line) as { operation: string; event: string; message?: string });
  assert.deepEqual(events.map((entry) => entry.event), [
    "happy-path:start",
    "happy-path:success",
    "sad-path:start",
    "sad-path:failure"
  ]);
  assert.ok(events.every((entry) => entry.operation === "test-operation"));
  assert.equal(events[3]?.message, "failed with token=[redacted]");
});
