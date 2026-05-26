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

function response(body: BodyInit | null, init: ResponseInit & { url?: string } = {}): Response {
  const result = new Response(body, init);
  Object.defineProperty(result, "url", {
    value: init.url ?? "https://example.test",
    configurable: true
  });
  return result;
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

test("Browserbase refresh failure callback sends the Telegram attention message", async () => {
  const kv = new MemoryKV();
  const calls: Array<{ url: string; body?: string }> = [];
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
  assert.match(body.version, /cloudflare-core/);
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
