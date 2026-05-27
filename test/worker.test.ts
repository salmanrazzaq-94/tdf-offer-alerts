import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.js";

const sampleOffers = [
  {
    productionSeasonId: 1,
    title: "Show One",
    facility: "Theatre",
    performances: [
      {
        performanceId: 10,
        performanceDate: "2026-05-26T19:00:00-04:00"
      }
    ]
  }
];

const returnedOffers = [
  ...sampleOffers,
  {
    productionSeasonId: 2,
    title: "Two Strangers",
    facility: "Longacre Theatre",
    performances: [
      {
        performanceId: 20,
        performanceDate: "2026-05-26T20:00:00-04:00"
      }
    ]
  }
];

class MemoryKV {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function env(kv = new MemoryKV()) {
  return {
    TDF_ALERTS: kv as unknown as KVNamespace,
    TELEGRAM_BOT_TOKEN: "telegram-token",
    TELEGRAM_CHAT_ID: "123",
    COOKIE_FORM_TOKEN: "form-token",
    GITHUB_REFRESH_TOKEN: "github-token",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_REFRESH_REF: "main"
  };
}

function envWithoutGithubRefresh(kv = new MemoryKV()) {
  return {
    TDF_ALERTS: kv as unknown as KVNamespace,
    TELEGRAM_BOT_TOKEN: "telegram-token",
    TELEGRAM_CHAT_ID: "123",
    COOKIE_FORM_TOKEN: "form-token"
  };
}

function response(body: BodyInit | null, init: ResponseInit & { url?: string } = {}): Response {
  const result = new Response(body, init);
  Object.defineProperty(result, "url", {
    value: init.url ?? "https://example.test",
    configurable: true
  });
  return result;
}

function contextWithTasks(tasks: Array<Promise<unknown>>): ExecutionContext {
  return {
    waitUntil(task: Promise<unknown>): void {
      tasks.push(task);
    },
    passThroughOnException(): void {}
  } as ExecutionContext;
}

test("delta run touches main page, merges refreshed cookies, and skips old offers", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session; anti=old");
  await kv.put("SEEN_OFFERS", JSON.stringify(["1:10"]));
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": "TNEW=member-fresh; path=/"
        },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": "anti=fresh; path=/TDFCustomOfferings"
        },
        url
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await worker.fetch(
      new Request("https://worker.test/run-delta?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { status: string; newPerformances: number };
    assert.equal(body.status, "success");
    assert.equal(body.newPerformances, 0);
    assert.match(kv.values.get("TDF_COOKIE") ?? "", /anti=fresh/);
    assert.match(kv.values.get("TDF_COOKIE") ?? "", /TNEW=member-fresh/);
    assert.equal(calls.filter((url) => url.includes("api.telegram.org")).length, 0);

    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      steps: Array<{ name: string; status: string }>;
    }>;
    assert.deepEqual(
      logs.at(-1)?.steps.map((step) => `${step.name}:${step.status}`),
      [
        "read-cookie:success",
        "refresh-tdf-member-session:success",
        "touch-tdf-main-page:success",
        "fetch-tdf-performances:success",
        "persist-refreshed-cookie:success",
        "read-seen-state:success",
        "diff-offers:success",
        "send-delta-alert:skipped",
        "write-seen-state:success",
        "clear-auth-state:success"
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("auth failure dispatches one automatic Browserbase refresh without Telegram noise", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://my.tdf.org/") {
      return response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/account/login"
      });
    }
    if (url.includes("api.github.com")) {
      return response(null, { status: 204, url });
    }
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await worker.fetch(
      new Request("https://worker.test/run-delta?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { status: string; failureKind: string };
    assert.equal(body.status, "failure");
    assert.equal(body.failureKind, "auth");
    assert.equal(calls.filter((url) => url.includes("api.github.com")).length, 1);
    assert.equal(calls.filter((url) => url.includes("api.telegram.org")).length, 0);

    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      notificationSent?: boolean;
      steps: Array<{ name: string; status: string }>;
    }>;
    assert.equal(logs.at(-1)?.notificationSent, false);
    const stepNames = logs.at(-1)?.steps.map((step) => `${step.name}:${step.status}`) ?? [];
    assert.ok(stepNames.includes("browserbase-refresh-dispatch:success"));
    assert.equal(stepNames.some((step) => step.startsWith("send-browserbase-refresh-started:")), false);
    assert.match(kv.values.get("AUTH_STATE") ?? "", /lastRefreshAttemptedAt/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("auth failure without GitHub refresh config sends a manual recovery alert", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url === "https://my.tdf.org/") {
      return response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/account/login"
      });
    }
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await worker.fetch(
      new Request("https://worker.test/run-delta?token=form-token"),
      envWithoutGithubRefresh(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { status: string; failureKind: string; notificationSent: boolean };
    assert.equal(body.status, "failure");
    assert.equal(body.failureKind, "auth");
    assert.equal(body.notificationSent, true);
    assert.equal(calls.filter((call) => call.url.includes("api.github.com")).length, 0);
    const telegramBody = calls.find((call) => call.url.includes("api.telegram.org"))?.body ?? "";
    assert.match(telegramBody, /Automatic recovery is not configured/);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      steps: Array<{ name: string; status: string; details?: { browserbaseRefreshStatus?: string } }>;
    }>;
    const throttleStep = logs.at(-1)?.steps.find((step) => step.name === "failure-notification-throttle");
    assert.equal(throttleStep?.details?.browserbaseRefreshStatus, "not-configured");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Browserbase refresh failure callback sends the Telegram attention message", async () => {
  const kv = new MemoryKV();
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await worker.fetch(
      new Request("https://worker.test/refresh-failed?token=form-token", {
        method: "POST",
        body: JSON.stringify({
          reason: "TDF showed a security challenge.",
          source_run_id: "worker-run-1"
        }),
        headers: { "content-type": "application/json" }
      }),
      env(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { status: string };
    assert.equal(body.status, "failure");
    assert.equal(calls.filter((call) => call.url.includes("api.telegram.org")).length, 1);
    assert.match(calls.find((call) => call.url.includes("api.telegram.org"))?.body ?? "", /Browserbase refresh failed/);

    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      event: string;
      status: string;
      failureKind?: string;
      notificationSent?: boolean;
    }>;
    assert.equal(logs.at(-1)?.event, "refresh");
    assert.equal(logs.at(-1)?.status, "failure");
    assert.equal(logs.at(-1)?.failureKind, "auth");
    assert.equal(logs.at(-1)?.notificationSent, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Browserbase refresh failure callback accepts form payloads", async () => {
  const kv = new MemoryKV();
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const form = new FormData();
    form.set("reason", "Browserbase form callback failed.");
    form.set("sourceRunId", "run-from-form");
    const result = await worker.fetch(
      new Request("https://worker.test/refresh-failed?token=form-token", {
        method: "POST",
        body: form
      }),
      env(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { status: string; notificationSent: boolean };
    assert.equal(body.status, "failure");
    assert.equal(body.notificationSent, true);
    assert.match(calls.find((call) => call.url.includes("api.telegram.org"))?.body ?? "", /source=run-from-form/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Browserbase refresh failure callback can suppress Telegram for E2E", async () => {
  const kv = new MemoryKV();
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await worker.fetch(
      new Request("https://worker.test/refresh-failed?token=form-token", {
        method: "POST",
        body: JSON.stringify({
          notify: "false",
          reason: "CI E2E refresh failure callback.",
          source_run_id: "ci-e2e-1"
        }),
        headers: { "content-type": "application/json" }
      }),
      env(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { notificationSent: boolean; status: string };
    assert.equal(body.status, "failure");
    assert.equal(body.notificationSent, false);
    assert.equal(calls.filter((url) => url.includes("api.telegram.org")).length, 0);

    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      steps: Array<{ name: string; status: string; details?: { reason?: string } }>;
    }>;
    assert.ok(logs.at(-1)?.steps.some((step) => `${step.name}:${step.status}` === "send-browserbase-refresh-failed:skipped"));
    assert.match(
      logs.at(-1)?.steps.find((step) => step.name === "send-browserbase-refresh-failed")?.details?.reason ?? "",
      /suppressed/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("duplicate Browserbase refresh failure callbacks are throttled", async () => {
  const kv = new MemoryKV();
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    for (let index = 0; index < 2; index += 1) {
      await worker.fetch(
        new Request("https://worker.test/refresh-failed?token=form-token", {
          method: "POST",
          body: JSON.stringify({
            reason: "Browserbase could not log in.",
            source_run_id: `worker-run-${index}`
          }),
          headers: { "content-type": "application/json" }
        }),
        env(kv),
        {} as ExecutionContext
      );
    }

    assert.equal(calls.filter((url) => url.includes("api.telegram.org")).length, 1);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      notificationSent?: boolean;
      steps: Array<{ name: string; status: string }>;
    }>;
    assert.equal(logs.at(-1)?.notificationSent, false);
    assert.ok(logs.at(-1)?.steps.some((step) => `${step.name}:${step.status}` === "send-browserbase-refresh-failed:skipped"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delta prunes unavailable performances so returned offers alert again", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  await kv.put("SEEN_OFFERS", JSON.stringify(["1:10", "2:20"]));
  let offers = sampleOffers;
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(offers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const first = await worker.fetch(
      new Request("https://worker.test/run-delta?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );
    assert.equal(((await first.json()) as { newPerformances: number }).newPerformances, 0);
    assert.deepEqual(JSON.parse(kv.values.get("SEEN_OFFERS") ?? "[]"), ["1:10"]);
    assert.equal(calls.filter((url) => url.includes("api.telegram.org")).length, 0);

    offers = returnedOffers;
    const second = await worker.fetch(
      new Request("https://worker.test/run-delta?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );
    assert.equal(((await second.json()) as { newPerformances: number }).newPerformances, 1);
    assert.deepEqual(JSON.parse(kv.values.get("SEEN_OFFERS") ?? "[]"), ["1:10", "2:20"]);
    assert.equal(calls.filter((url) => url.includes("api.telegram.org")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recent auth failure does not dispatch Browserbase refresh again", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  await kv.put(
    "AUTH_STATE",
    JSON.stringify({
      lastFailureNotifiedAt: new Date().toISOString(),
      lastFailureKind: "auth",
      lastFailureReason: "still expired",
      lastRefreshAttemptedAt: new Date().toISOString()
    })
  );
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://my.tdf.org/") {
      return response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/account/login"
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await worker.fetch(
      new Request("https://worker.test/run-delta?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );
    assert.equal(calls.filter((url) => url.includes("api.github.com")).length, 0);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      steps: Array<{ name: string; status: string; details?: { reason?: string } }>;
    }>;
    const refreshStep = logs.at(-1)?.steps.find((step) => step.name === "browserbase-refresh-dispatch");
    assert.equal(refreshStep?.status, "skipped");
    assert.match(refreshStep?.details?.reason ?? "", /throttle/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("telegram offers command starts Browserbase recovery without Telegram noise on auth failure", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  const calls: string[] = [];
  const tasks: Array<Promise<unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://my.tdf.org/") {
      return response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/account/login"
      });
    }
    if (url.includes("api.github.com")) {
      return response(null, { status: 204, url });
    }
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await worker.fetch(
      new Request("https://worker.test/telegram", {
        method: "POST",
        body: JSON.stringify({ message: { text: "/offers", chat: { id: 123 } } }),
        headers: { "content-type": "application/json" }
      }),
      env(kv),
      contextWithTasks(tasks)
    );
    await Promise.all(tasks);

    assert.equal(calls.filter((url) => url.includes("api.github.com")).length, 1);
    assert.equal(calls.filter((url) => url.includes("api.telegram.org")).length, 0);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      event: string;
      status: string;
      notificationSent?: boolean;
      steps: Array<{ name: string; status: string }>;
    }>;
    assert.equal(logs.at(-1)?.event, "command");
    assert.equal(logs.at(-1)?.status, "failure");
    assert.equal(logs.at(-1)?.notificationSent, false);
    assert.ok(logs.at(-1)?.steps.some((step) => `${step.name}:${step.status}` === "browserbase-refresh-dispatch:success"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("telegram status command starts Browserbase recovery without Telegram noise on auth failure", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  const calls: string[] = [];
  const tasks: Array<Promise<unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://my.tdf.org/") {
      return response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/account/login"
      });
    }
    if (url.includes("api.github.com")) {
      return response(null, { status: 204, url });
    }
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await worker.fetch(
      new Request("https://worker.test/telegram", {
        method: "POST",
        body: JSON.stringify({ message: { text: "/status", chat: { id: 123 } } }),
        headers: { "content-type": "application/json" }
      }),
      env(kv),
      contextWithTasks(tasks)
    );
    await Promise.all(tasks);

    assert.equal(calls.filter((url) => url.includes("api.github.com")).length, 1);
    assert.equal(calls.filter((url) => url.includes("api.telegram.org")).length, 0);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      event: string;
      status: string;
      notificationSent?: boolean;
      steps: Array<{ name: string; status: string }>;
    }>;
    assert.equal(logs.at(-1)?.event, "status");
    assert.equal(logs.at(-1)?.status, "failure");
    assert.equal(logs.at(-1)?.notificationSent, false);
    assert.ok(logs.at(-1)?.steps.some((step) => `${step.name}:${step.status}` === "browserbase-refresh-dispatch:success"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatch failure sends a clear recovery attention message", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url === "https://my.tdf.org/") {
      return response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/account/login"
      });
    }
    if (url.includes("api.github.com")) {
      return response('{"message":"Workflow does not have workflow_dispatch trigger"}', {
        status: 422,
        url
      });
    }
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await worker.fetch(
      new Request("https://worker.test/run-delta?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );

    const telegramBody = calls.find((call) => call.url.includes("api.telegram.org"))?.body ?? "";
    assert.match(telegramBody, /Automatic TDF login recovery could not start/);
    assert.doesNotMatch(telegramBody, new RegExp("Use Browserbase refresh or send /cookie"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verify-cookie validates the saved cookie without sending Telegram", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await worker.fetch(
      new Request("https://worker.test/verify-cookie?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { status: string; shows: number; performances: number };
    assert.equal(body.status, "success");
    assert.equal(body.shows, 1);
    assert.equal(body.performances, 1);
    assert.equal(calls.filter((url) => url.includes("api.telegram.org")).length, 0);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{ event: string }>;
    assert.equal(logs.at(-1)?.event, "verify");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verify-cookie recovers when stored run logs are corrupted", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  await kv.put("RUN_LOGS", "{not-json");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await worker.fetch(
      new Request("https://worker.test/verify-cookie?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { status: string };
    assert.equal(body.status, "success");
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{ event: string }>;
    assert.equal(logs.at(-1)?.event, "verify");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delta recovers corrupted seen state without sending a full-current spam alert", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  await kv.put("SEEN_OFFERS", "{not-json");
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await worker.fetch(
      new Request("https://worker.test/run-delta?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { status: string; newPerformances: number };
    assert.equal(body.status, "success");
    assert.equal(body.newPerformances, 0);
    assert.deepEqual(JSON.parse(kv.values.get("SEEN_OFFERS") ?? "[]"), ["1:10"]);
    assert.equal(calls.filter((url) => url.includes("api.telegram.org")).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delta does not fail or send a misleading auth alert when details document upload fails after summary", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  await kv.put("SEEN_OFFERS", JSON.stringify([]));
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes("sendMessage")) {
      return response('{"ok":true}', { status: 200, url });
    }
    if (url.includes("sendDocument")) {
      return response("telegram document failed", { status: 500, url });
    }
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await worker.fetch(
      new Request("https://worker.test/run-delta?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { status: string; notificationSent: boolean };
    assert.equal(body.status, "success");
    assert.equal(body.notificationSent, true);
    assert.equal(calls.filter((url) => url.includes("sendMessage")).length, 1);
    assert.equal(calls.filter((url) => url.includes("sendDocument")).length, 1);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      steps: Array<{ name: string; status: string }>;
    }>;
    assert.ok(logs.at(-1)?.steps.some((step) => `${step.name}:${step.status}` === "send-telegram-document:failure"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delta logs a failed run when the Telegram summary send fails", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  await kv.put("SEEN_OFFERS", JSON.stringify([]));
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes("sendMessage")) {
      return response("telegram unavailable", { status: 500, url });
    }
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await worker.fetch(
      new Request("https://worker.test/run-delta?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { status: string; failureKind: string; notificationSent: boolean };
    assert.equal(body.status, "failure");
    assert.equal(body.failureKind, "unexpected");
    assert.equal(body.notificationSent, false);
    assert.equal(calls.filter((url) => url.includes("sendMessage")).length, 2);
    assert.equal(kv.values.get("SEEN_OFFERS"), JSON.stringify([]));
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      steps: Array<{ name: string; status: string }>;
    }>;
    assert.ok(logs.at(-1)?.steps.some((step) => `${step.name}:${step.status}` === "send-telegram-summary:failure"));
    assert.ok(logs.at(-1)?.steps.some((step) => `${step.name}:${step.status}` === "send-telegram-failure:failure"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cookie form rejects invalid cookie input with a logged form error", async () => {
  const kv = new MemoryKV();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    throw new Error(`Unexpected fetch: ${String(input instanceof Request ? input.url : input)}`);
  };

  try {
    const form = new FormData();
    form.set("cookie", "not a tdf session");
    const result = await worker.fetch(
      new Request("https://worker.test/cookie?token=form-token", {
        method: "POST",
        body: form
      }),
      env(kv),
      {} as ExecutionContext
    );

    assert.equal(result.status, 400);
    assert.match(await result.text(), /Cookie did not work/);
    assert.equal(kv.values.get("TDF_COOKIE"), undefined);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      event: string;
      status: string;
      failureKind?: string;
      message?: string;
    }>;
    assert.equal(logs.at(-1)?.event, "cookie");
    assert.equal(logs.at(-1)?.status, "failure");
    assert.equal(logs.at(-1)?.failureKind, "auth");
    assert.match(logs.at(-1)?.message ?? "", /expected TDF session cookies/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cookie form validates and saves a working cookie end to end", async () => {
  const kv = new MemoryKV();
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: {
          "content-type": "text/html",
          "set-cookie": "anti=fresh; path=/TDFCustomOfferings"
        },
        url
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const form = new FormData();
    form.set("cookie", "Cookie: TNEW=old; .TDFCustomOfferings.Session=session");
    const result = await worker.fetch(
      new Request("https://worker.test/cookie?token=form-token", {
        method: "POST",
        body: form
      }),
      env(kv),
      {} as ExecutionContext
    );

    assert.equal(result.status, 200);
    assert.match(await result.text(), /Saved\. 1 shows available/);
    assert.match(kv.values.get("TDF_COOKIE") ?? "", /anti=fresh/);
    assert.doesNotMatch(kv.values.get("TDF_COOKIE") ?? "", /^Cookie:/);
    assert.equal(calls.filter((url) => url.includes("api.telegram.org")).length, 0);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      event: string;
      status: string;
      steps: Array<{ name: string; status: string }>;
    }>;
    assert.equal(logs.at(-1)?.event, "cookie");
    assert.equal(logs.at(-1)?.status, "success");
    assert.ok(logs.at(-1)?.steps.some((step) => `${step.name}:${step.status}` === "save-cookie:success"));
    assert.ok(logs.at(-1)?.steps.some((step) => `${step.name}:${step.status}` === "clear-auth-state:success"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("daily digest sends summary and details document for all current offers", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  const calls: Array<{ url: string; body: BodyInit | null | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: init?.body });
    if (url.includes("sendMessage")) {
      return response('{"ok":true}', { status: 200, url });
    }
    if (url.includes("sendDocument")) {
      return response('{"ok":true}', { status: 200, url });
    }
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(returnedOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await worker.fetch(
      new Request("https://worker.test/run-daily?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { status: string; performances: number; notificationSent: boolean };
    assert.equal(body.status, "success");
    assert.equal(body.performances, 2);
    assert.equal(body.notificationSent, true);
    assert.equal(calls.filter((call) => call.url.includes("sendMessage")).length, 1);
    assert.equal(calls.filter((call) => call.url.includes("sendDocument")).length, 1);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      event: string;
      status: string;
      steps: Array<{ name: string; status: string }>;
    }>;
    assert.equal(logs.at(-1)?.event, "daily");
    assert.ok(logs.at(-1)?.steps.some((step) => `${step.name}:${step.status}` === "send-telegram-document:success"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transient TDF performance failures retry before succeeding", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  await kv.put("SEEN_OFFERS", JSON.stringify(["1:10"]));
  let performanceAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      performanceAttempts += 1;
      if (performanceAttempts === 1) {
        return response("upstream busy", { status: 500, headers: { "content-type": "text/plain" }, url });
      }
      return response(JSON.stringify(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await worker.fetch(
      new Request("https://worker.test/run-delta?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { status: string; newPerformances: number };
    assert.equal(body.status, "success");
    assert.equal(body.newPerformances, 0);
    assert.equal(performanceAttempts, 2);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      steps: Array<{ name: string; status: string; details?: { attempt?: number } }>;
    }>;
    assert.ok(logs.at(-1)?.steps.some((step) => `${step.name}:${step.status}` === "fetch-tdf-retry-wait:success" && step.details?.attempt === 1));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transient TDF failures exhaust retries and send a temporary failure alert", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response("still down", { status: 503, headers: { "content-type": "text/plain" }, url });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await worker.fetch(
      new Request("https://worker.test/run-delta?token=form-token"),
      env(kv),
      {} as ExecutionContext
    );
    const body = (await result.json()) as { status: string; failureKind: string; notificationSent: boolean };
    assert.equal(body.status, "failure");
    assert.equal(body.failureKind, "transient");
    assert.equal(body.notificationSent, true);
    assert.equal(calls.filter((call) => call.url.includes("Current?handler=Performances")).length, 3);
    assert.equal(calls.filter((call) => call.url.includes("api.github.com")).length, 0);
    assert.match(calls.find((call) => call.url.includes("api.telegram.org"))?.body ?? "", /temporary failure/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("telegram utility commands send cookie link, help, logs, and debug messages", async () => {
  const kv = new MemoryKV();
  await kv.put(
    "RUN_LOGS",
    JSON.stringify([
      {
        id: "run-1",
        event: "delta",
        status: "failure",
        trigger: "cron",
        startedAt: "2026-05-23T12:00:00.000Z",
        finishedAt: "2026-05-23T12:00:01.000Z",
        durationMs: 1000,
        version: "test",
        failureKind: "auth",
        message: "login expired <retry>",
        steps: []
      }
    ])
  );
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const tasks: Array<Promise<unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    for (const text of ["/cookie", "/help", "/logs", "/debug"]) {
      await worker.fetch(
        new Request("https://worker.test/telegram", {
          method: "POST",
          body: JSON.stringify({ message: { text, chat: { id: 123 } } }),
          headers: { "content-type": "application/json" }
        }),
        env(kv),
        contextWithTasks(tasks)
      );
    }
    await Promise.all(tasks);

    const telegramBodies = calls.map((call) => call.body ?? "").join("\n");
    assert.match(telegramBodies, /Paste a fresh TDF cookie here/);
    assert.match(telegramBodies, /Commands: \/offers, \/status, \/debug, \/logs, \/cookie/);
    assert.match(telegramBodies, /Recent TDF Logs/);
    assert.match(telegramBodies, /login expired &lt;retry&gt;/);
    assert.match(telegramBodies, /TDF Debug/);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{ event: string; status: string }>;
    assert.deepEqual(logs.slice(-2).map((log) => `${log.event}:${log.status}`), ["logs:success", "debug:success"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker public endpoints enforce tokens and expose health and logs", async () => {
  const kv = new MemoryKV();
  await kv.put(
    "RUN_LOGS",
    JSON.stringify([{ event: "delta", status: "success", steps: [] }])
  );

  const health = await worker.fetch(
    new Request("https://worker.test/health"),
    env(kv),
    {} as ExecutionContext
  );
  assert.deepEqual(await health.json(), { ok: true });

  const forbiddenLogs = await worker.fetch(
    new Request("https://worker.test/logs?token=bad"),
    env(kv),
    {} as ExecutionContext
  );
  assert.equal(forbiddenLogs.status, 404);

  const logs = await worker.fetch(
    new Request("https://worker.test/logs?token=form-token"),
    env(kv),
    {} as ExecutionContext
  );
  assert.equal(logs.status, 200);
  assert.equal((await logs.json() as Array<{ event: string }>).at(-1)?.event, "delta");

  const cookieFormResult = await worker.fetch(
    new Request("https://worker.test/cookie?token=form-token"),
    env(kv),
    {} as ExecutionContext
  );
  assert.match(await cookieFormResult.text(), /Paste full Cookie header here/);

  const unknown = await worker.fetch(
    new Request("https://worker.test/nope"),
    env(kv),
    {} as ExecutionContext
  );
  assert.equal(unknown.status, 404);
});

test("debug endpoint recovers corrupted KV metadata", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  await kv.put("TDF_COOKIE_META", "{not-json");
  await kv.put("AUTH_STATE", "{not-json");
  await kv.put("HEALTH_STATE", "{not-json");

  const result = await worker.fetch(
    new Request("https://worker.test/debug?token=form-token"),
    env(kv),
    {} as ExecutionContext
  );
  const body = (await result.json()) as {
    cookie: { source: string | null; cookieBytes: number; hasSessionCookie: boolean };
    auth: { lastFailureKind: string | null };
    health: { lastStaleNotifiedAt: string | null };
  };
  assert.equal(body.cookie.source, null);
  assert.equal(body.cookie.cookieBytes, 0);
  assert.equal(body.cookie.hasSessionCookie, false);
  assert.equal(body.auth.lastFailureKind, null);
  assert.equal(body.health.lastStaleNotifiedAt, null);
});

test("cron delta recovers a corrupted lock instead of crashing before logging", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  await kv.put("DELTA_LOCK", "{not-json");
  await kv.put("SEEN_OFFERS", JSON.stringify(["1:10"]));
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await worker.scheduled({ cron: "*/10 * * * *" } as ScheduledController, env(kv));
    assert.equal(calls.filter((url) => url.includes("api.telegram.org")).length, 0);
    assert.equal(kv.values.get("DELTA_LOCK"), undefined);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      status: string;
      steps: Array<{ name: string; status: string }>;
    }>;
    assert.equal(logs.at(-1)?.status, "success");
    assert.ok(logs.at(-1)?.steps.some((step) => `${step.name}:${step.status}` === "acquire-delta-lock:success"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("debug endpoint returns cookie, auth, and recent run diagnostics", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  await kv.put("SEEN_OFFERS", JSON.stringify(["1:10"]));
  await kv.put(
    "RUN_LOGS",
    JSON.stringify([
      {
        id: "run-1",
        event: "delta",
        status: "success",
        trigger: "test",
        startedAt: "2026-05-23T12:00:00.000Z",
        finishedAt: "2026-05-23T12:00:01.000Z",
        durationMs: 1000,
        version: "test",
        shows: 1,
        performances: 1,
        newPerformances: 0,
        steps: []
      }
    ])
  );

  const result = await worker.fetch(
    new Request("https://worker.test/debug?token=form-token"),
    env(kv),
    {} as ExecutionContext
  );
  const body = (await result.json()) as {
    version: string;
    cookie: { hasSessionCookie: boolean; hasTnewCookie: boolean };
    recentRuns: Array<{ event: string; status: string }>;
  };
  assert.match(body.version, /production-hardening/);
  assert.equal(body.cookie.hasSessionCookie, true);
  assert.equal(body.cookie.hasTnewCookie, true);
  assert.deepEqual(body.recentRuns, [{ finishedAt: "2026-05-23T12:00:01.000Z", event: "delta", status: "success", trigger: "test", shows: 1, performances: 1, newPerformances: 0 }]);
});

test("cron delta skips when a recent lock is present", async () => {
  const kv = new MemoryKV();
  await kv.put(
    "DELTA_LOCK",
    JSON.stringify({
      owner: "other-run",
      acquiredAt: new Date().toISOString()
    })
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    throw new Error(`Unexpected fetch: ${String(input instanceof Request ? input.url : input)}`);
  };

  try {
    await worker.scheduled({ cron: "*/10 * * * *" } as ScheduledController, env(kv));
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      status: string;
      steps: Array<{ name: string; status: string }>;
    }>;
    assert.equal(logs.at(-1)?.status, "skipped");
    assert.deepEqual(logs.at(-1)?.steps.map((step) => `${step.name}:${step.status}`), [
      "acquire-delta-lock:skipped"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cron delta persists a run log when lock release fails", async () => {
  class ReleaseFailureKV extends MemoryKV {
    async delete(key: string): Promise<void> {
      if (key === "DELTA_LOCK") {
        throw new Error("KV delete failed");
      }
      await super.delete(key);
    }
  }

  const kv = new ReleaseFailureKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  await kv.put("SEEN_OFFERS", JSON.stringify(["1:10"]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await worker.scheduled({ cron: "*/10 * * * *" } as ScheduledController, env(kv));
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      status: string;
      failureKind?: string;
      message?: string;
      steps: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
    }>;
    const run = logs.at(-1);
    assert.equal(run?.status, "failure");
    assert.equal(run?.failureKind, "unexpected");
    assert.match(String(run?.message), /release delta lock/);
    const releaseStep = run?.steps.find((step) => step.name === "release-delta-lock");
    assert.equal(releaseStep?.status, "failure");
    assert.match(String(releaseStep?.details?.["message"]), /KV delete failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cron delta logs stale health without sending Telegram noise", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");
  await kv.put("SEEN_OFFERS", JSON.stringify(["1:10"]));
  await kv.put(
    "RUN_LOGS",
    JSON.stringify([
      {
        id: "old-success",
        event: "delta",
        status: "success",
        trigger: "cron",
        startedAt: "2026-05-23T10:00:00.000Z",
        finishedAt: "2026-05-23T10:00:01.000Z",
        durationMs: 1000,
        version: "test",
        shows: 1,
        performances: 1,
        newPerformances: 0,
        steps: []
      }
    ])
  );
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes("api.telegram.org")) {
      return response('{"ok":true}', { status: 200, url });
    }
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await worker.scheduled({ cron: "*/10 * * * *" } as ScheduledController, env(kv));
    assert.equal(calls.filter((url) => url.includes("api.telegram.org")).length, 0);
    assert.equal(kv.values.get("HEALTH_STATE"), undefined);
    const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
      status: string;
      steps: Array<{ name: string; status: string }>;
    }>;
    const steps = logs.at(-1)?.steps.map((step) => `${step.name}:${step.status}`) ?? [];
    assert.ok(steps.includes("stale-health-check:failure"));
    assert.equal(logs.at(-1)?.status, "success");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
