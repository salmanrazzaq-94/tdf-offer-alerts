#!/usr/bin/env node

import { readFileSync } from "node:fs";

class MemoryKV {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }
}

const localMode = process.env.E2E_LOCAL_WORKER === "true";
const baseUrl = (process.env.E2E_WORKER_BASE_URL ?? "https://worker.e2e.test").replace(/\/$/, "");
const token = required("E2E_COOKIE_FORM_TOKEN");
const telegramChatId = required("E2E_TELEGRAM_CHAT_ID");
const tdfCookie = readEnvFileValue("TDF_COOKIE");
const telegramCalls = [];
const runtimeEvents = [];
const workerClient = localMode ? await createLocalWorkerClient() : null;

const health = await getJson("/health", { authorized: false });
if (health.ok !== true) {
  throw new Error(`/health returned unexpected payload: ${JSON.stringify(health)}`);
}

const cookieForm = await getText("/cookie");
if (!cookieForm.includes("<form") || !cookieForm.includes("textarea")) {
  throw new Error("/cookie did not return the expected form.");
}

const cookieRun = await postCookie(tdfCookie);
assertTextIncludes(cookieRun, "Saved.", "/cookie POST");

const verifyRun = await getJson("/verify-cookie");
assertRunSucceeded(verifyRun, "verify-cookie");
assertPositiveNumber(verifyRun.shows, "verify-cookie shows");
assertPositiveNumber(verifyRun.performances, "verify-cookie performances");

const deltaRun = await getJson("/run-delta");
assertRunSucceeded(deltaRun, "run-delta");
assertPositiveNumber(deltaRun.shows, "run-delta shows");
assertPositiveNumber(deltaRun.performances, "run-delta performances");
assertStepSucceeded(deltaRun, "diff-offers");

const dailyRun = await getJson("/run-daily");
assertRunSucceeded(dailyRun, "run-daily");
assertPositiveNumber(dailyRun.shows, "run-daily shows");
assertPositiveNumber(dailyRun.performances, "run-daily performances");
assertStepSucceeded(dailyRun, "send-telegram-summary");
assertStepSucceeded(dailyRun, "send-telegram-document");

const debugSnapshot = await getJson("/debug");
if (!debugSnapshot.cookie || !debugSnapshot.auth || !debugSnapshot.health) {
  throw new Error(`/debug returned unexpected payload: ${JSON.stringify(debugSnapshot)}`);
}

const statusRun = await runTelegramCommand("/status", ["sendMessage"], "telegram:/status");

const helpRun = await runTelegramCommand("/help", ["sendMessage"], "telegram:/help");

const startRun = await runTelegramCommand("/start", ["sendMessage"], "telegram:/help");

const offersRun = await runTelegramCommand("/offers", ["sendMessage", "sendDocument"], "telegram:/offers");

const refreshFailureRun = await postRefreshFailure();
if (refreshFailureRun.status !== "failure" || refreshFailureRun.failureKind !== "auth") {
  throw new Error(`refresh-failed did not record the expected auth failure: ${JSON.stringify(refreshFailureRun)}`);
}
assertStepSkipped(refreshFailureRun, "send-browserbase-refresh-failed");
if (refreshFailureRun.notificationSent !== false) {
  throw new Error(`refresh-failed should suppress the fake CI alert: ${JSON.stringify(refreshFailureRun)}`);
}

console.log(JSON.stringify({
  ok: true,
  worker: baseUrl,
  verify: {
    shows: verifyRun.shows,
    performances: verifyRun.performances
  },
  delta: {
    shows: deltaRun.shows,
    performances: deltaRun.performances,
    newPerformances: deltaRun.newPerformances
  },
  daily: {
    shows: dailyRun.shows,
    performances: dailyRun.performances
  },
  telegram: {
    status: statusRun.status,
    help: helpRun.status,
    start: startRun.status,
    offers: offersRun.status
  },
  refreshFailure: "suppressed"
}, null, 2));

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readEnvFileValue(name) {
  const text = readFileSync(".env", "utf8");
  const line = text.split(/\n/).find((candidate) => candidate.startsWith(`${name}=`));
  const value = line?.split("=").slice(1).join("=");
  if (!value) {
    throw new Error(`Missing ${name} in .env. Run Browserbase login before worker:e2e.`);
  }
  return value;
}

async function getJson(path, options = {}) {
  const text = await getText(path, options);
  return JSON.parse(text);
}

async function getText(path, options = {}) {
  const url = new URL(path, baseUrl);
  if (options.authorized !== false) {
    url.searchParams.set("token", token);
  }
  const response = await workerFetch(url);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${body.slice(0, 500)}`);
  }
  return body;
}

async function postCookie(cookie) {
  const url = new URL("/cookie", baseUrl);
  url.searchParams.set("token", token);
  const form = new FormData();
  form.set("cookie", cookie);
  const response = await workerFetch(url, { method: "POST", body: form });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`/cookie POST failed with ${response.status}: ${body.slice(0, 500)}`);
  }
  return body;
}

async function postRefreshFailure() {
  const reason = "CI E2E refresh failure callback; expected test path, not a production incident.";
  const response = await workerFetch(`${baseUrl}/refresh-failed?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      notify: "false",
      reason,
      source_run_id: `ci-e2e-${Date.now()}`
    })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`/refresh-failed failed with ${response.status}: ${body.slice(0, 500)}`);
  }
  return JSON.parse(body);
}

async function runTelegramCommand(text, expectedTelegramMethods, trigger) {
  const commandStartedAt = Date.now();
  const firstTelegramCallIndex = telegramCalls.length;
  await postTelegramCommand(text);
  if (localMode) {
    const newCalls = telegramCalls.slice(firstTelegramCallIndex);
    for (const method of expectedTelegramMethods) {
      if (!newCalls.some((call) => call.url.includes(method))) {
        throw new Error(`${text} did not call Telegram ${method}: ${JSON.stringify(newCalls)}`);
      }
    }
  }
  assertNoRecentFailure(trigger, commandStartedAt);
  return { status: "success" };
}

async function postTelegramCommand(text) {
  const chatIdNumber = Number(telegramChatId);
  const chatId = Number.isSafeInteger(chatIdNumber) ? chatIdNumber : telegramChatId;
  const response = await workerFetch(`${baseUrl}/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: Math.floor(Date.now() / 1000),
      message: {
        message_id: Math.floor(Math.random() * 1_000_000),
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: chatId,
          type: "private"
        },
        text
      }
    })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`/telegram failed with ${response.status}: ${body.slice(0, 500)}`);
  }
}

async function workerFetch(input, init) {
  if (!workerClient) {
    return fetch(input, init);
  }
  return workerClient.fetch(input, init);
}

async function createLocalWorkerClient() {
  const worker = (await import("../dist/worker/index.js")).default;
  const kv = new MemoryKV();
  const env = {
    TDF_ALERTS: kv,
    TELEGRAM_BOT_TOKEN: required("TELEGRAM_BOT_TOKEN"),
    TELEGRAM_CHAT_ID: telegramChatId,
    COOKIE_FORM_TOKEN: token,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || "salmanrazzaq-94/tdf-offer-alerts",
    GITHUB_REFRESH_REF: process.env.GITHUB_REFRESH_REF || "main"
  };

  return {
    async fetch(input, init) {
      const waitUntilPromises = [];
      const ctx = {
        waitUntil(promise) {
          waitUntilPromises.push(Promise.resolve(promise));
        }
      };
      const originalFetch = globalThis.fetch;
      const originalLog = console.log;
      const originalWarn = console.warn;
      const originalError = console.error;
      const captureRuntimeEvent = (value) => {
        try {
          runtimeEvents.push(JSON.parse(String(value)));
        } catch {
          // Keep non-JSON output out of the E2E signal stream.
        }
      };
      globalThis.fetch = async (fetchInput, fetchInit) => {
        const url = String(fetchInput instanceof Request ? fetchInput.url : fetchInput);
        if (url.includes("api.telegram.org")) {
          telegramCalls.push({
            url,
            body: typeof fetchInit?.body === "string" ? fetchInit.body : undefined
          });
        }
        return originalFetch(fetchInput, fetchInit);
      };
      console.log = captureRuntimeEvent;
      console.warn = captureRuntimeEvent;
      console.error = captureRuntimeEvent;
      try {
        const response = await worker.fetch(new Request(input, init), env, ctx);
        await Promise.all(waitUntilPromises);
        return response;
      } finally {
        globalThis.fetch = originalFetch;
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
      }
    }
  };
}

function assertNoRecentFailure(trigger, commandStartedAt) {
  if (!localMode) {
    return;
  }
  const failure = [...runtimeEvents].reverse().find((candidate) => {
    const run = candidate.run;
    return candidate.event === "tdf-run-finished" &&
      run?.status === "failure" &&
      run?.trigger === trigger &&
      new Date(candidate.at).getTime() >= commandStartedAt - 5_000;
  });
  if (failure) {
    throw new Error(`${trigger} recorded a failure: ${JSON.stringify(failure)}`);
  }
}

function assertRunSucceeded(run, label) {
  if (!run || run.status !== "success") {
    throw new Error(`${label} did not succeed: ${JSON.stringify(run)}`);
  }
}

function assertPositiveNumber(value, label) {
  if (typeof value !== "number" || value <= 0) {
    throw new Error(`${label} was not positive: ${value}`);
  }
}

function assertStepSucceeded(run, stepName) {
  const step = run.steps?.find((candidate) => candidate.name === stepName);
  if (!step || step.status !== "success") {
    throw new Error(`${stepName} did not succeed: ${JSON.stringify(run)}`);
  }
}

function assertStepSkipped(run, stepName) {
  const step = run.steps?.find((candidate) => candidate.name === stepName);
  if (!step || step.status !== "skipped") {
    throw new Error(`${stepName} did not skip: ${JSON.stringify(run)}`);
  }
}

function assertTextIncludes(text, expected, label) {
  if (!text.includes(expected)) {
    throw new Error(`${label} did not include ${expected}: ${text.slice(0, 500)}`);
  }
}
