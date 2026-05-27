#!/usr/bin/env node

import { readFileSync } from "node:fs";

const baseUrl = required("E2E_WORKER_BASE_URL").replace(/\/$/, "");
const token = required("E2E_COOKIE_FORM_TOKEN");
const telegramChatId = required("E2E_TELEGRAM_CHAT_ID");
const tdfCookie = readEnvFileValue("TDF_COOKIE");

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
if (!debugSnapshot.cookie || !debugSnapshot.auth || !Array.isArray(debugSnapshot.recentRuns)) {
  throw new Error(`/debug returned unexpected payload: ${JSON.stringify(debugSnapshot)}`);
}

const logsSnapshot = await getJson("/logs");
if (!Array.isArray(logsSnapshot) || logsSnapshot.length === 0) {
  throw new Error(`/logs returned unexpected payload: ${JSON.stringify(logsSnapshot)}`);
}

const statusRun = await runTelegramCommand("/status", "status", "telegram:/status");
assertStepSucceeded(statusRun, "send-telegram-status");

const debugRun = await runTelegramCommand("/debug", "debug", "telegram:/debug");
assertStepSucceeded(debugRun, "send-telegram-debug");

const logsRun = await runTelegramCommand("/logs", "logs", "telegram:/logs");
assertStepSucceeded(logsRun, "send-telegram-logs");

const offersRun = await runTelegramCommand("/offers", "command", "telegram:/offers");
assertStepSucceeded(offersRun, "send-telegram-summary");
assertStepSucceeded(offersRun, "send-telegram-document");

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
    debug: debugRun.status,
    logs: logsRun.status,
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
  const response = await fetch(url);
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
  const response = await fetch(url, { method: "POST", body: form });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`/cookie POST failed with ${response.status}: ${body.slice(0, 500)}`);
  }
  return body;
}

async function postRefreshFailure() {
  const reason = "CI E2E refresh failure callback; expected test path, not a production incident.";
  const response = await fetch(`${baseUrl}/refresh-failed?token=${encodeURIComponent(token)}`, {
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

async function runTelegramCommand(text, event, trigger) {
  const commandStartedAt = Date.now();
  await postTelegramCommand(text);
  const run = await waitForLog((candidate) =>
    candidate.event === event &&
    candidate.trigger === trigger &&
    new Date(candidate.startedAt).getTime() >= commandStartedAt - 5_000
  );
  assertRunSucceeded(run, trigger);
  return run;
}

async function postTelegramCommand(text) {
  const chatIdNumber = Number(telegramChatId);
  const chatId = Number.isSafeInteger(chatIdNumber) ? chatIdNumber : telegramChatId;
  const response = await fetch(`${baseUrl}/telegram`, {
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

async function waitForLog(predicate) {
  const deadline = Date.now() + 45_000;
  let lastLogs = [];
  while (Date.now() < deadline) {
    lastLogs = await getJson("/logs");
    const match = [...lastLogs].reverse().find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for matching worker log. Recent logs: ${JSON.stringify(lastLogs.slice(-5))}`);
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
