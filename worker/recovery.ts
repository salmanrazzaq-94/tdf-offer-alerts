import { authFailureNotifyIntervalMs, browserbaseDispatchFailureRetryMs, browserbaseRefreshAttemptIntervalMs } from "./constants.js";
import { formatFailureMessage } from "./formatters.js";
import { addStep, appendLog, createRun, finishRun } from "./logging.js";
import { readAuthState, writeAuthState } from "./state.js";
import { sendMessage } from "./telegram.js";
import type { AuthState, BrowserbaseRefreshResult, Env, RunLog } from "./types.js";
import { escapeHtml, errorMessage, isRecord, TdfError } from "./utils.js";

export async function handleCheckFailure(env: Env, run: RunLog, error: unknown): Promise<void> {
  const kind = classifyFailure(error);
  const message = errorMessage(error);
  const state = await readAuthState(env);
  const lastNotifiedAt = state.lastFailureNotifiedAt
    ? new Date(state.lastFailureNotifiedAt).valueOf()
    : 0;
  const shouldNotify =
    state.lastFailureKind !== kind ||
    !lastNotifiedAt ||
    Date.now() - lastNotifiedAt >= authFailureNotifyIntervalMs;
  const refreshResult = await maybeTriggerBrowserbaseRefresh(env, run, state, kind, message);
  const suppressNotification =
    kind === "auth" &&
    (refreshResult.status === "started" || refreshResult.status === "throttled");
  const notifyNow = shouldNotify && !suppressNotification;

  await writeAuthState(env, {
    lastFailureNotifiedAt: notifyNow ? new Date().toISOString() : state.lastFailureNotifiedAt,
    lastFailureKind: kind,
    lastFailureReason: message,
    lastRefreshAttemptedAt: refreshResult.attemptedAt ?? state.lastRefreshAttemptedAt,
    lastRefreshAttemptStatus: refreshResult.status
  });
  addStep(run, "failure-notification-throttle", "success", {
    shouldNotify,
    notifyNow,
    suppressNotification,
    browserbaseRefreshStatus: refreshResult.status,
    lastFailureKind: state.lastFailureKind,
    lastFailureNotifiedAt: state.lastFailureNotifiedAt
  });

  if (notifyNow) {
    const sendStarted = Date.now();
    try {
      await sendMessage(env, formatFailureMessage(kind, message, refreshResult));
      addStep(run, "send-telegram-failure", "success", { durationMs: Date.now() - sendStarted });
    } catch (notifyError) {
      addStep(run, "send-telegram-failure", "failure", {
        durationMs: Date.now() - sendStarted,
        message: errorMessage(notifyError)
      });
    }
  } else {
    addStep(run, "send-telegram-failure", "skipped", {
      reason: suppressNotification
        ? "Automatic Browserbase recovery is handling this auth failure."
        : "Repeated failure notification is throttled."
    });
  }

  finishRun(run, "failure", {
    failureKind: kind,
    message,
    notificationSent: run.steps.some((step) => step.name === "send-telegram-failure" && step.status === "success")
  });
}

export async function recordBrowserbaseRefreshFailure(request: Request, env: Env): Promise<RunLog> {
  const run = createRun("refresh", "github:refresh-cookie");
  const details = await readRefreshFailureDetails(request);
  const reason = details["reason"] || "Browserbase refresh workflow failed.";
  const sourceRunId = details["source_run_id"] || details["sourceRunId"];
  const suppressNotification = isTruthy(details["suppress_telegram"]) || details["notify"] === "false";
  const state = await readAuthState(env);
  const lastNotifiedAt = state.lastFailureNotifiedAt
    ? new Date(state.lastFailureNotifiedAt).valueOf()
    : 0;
  const shouldNotify =
    !suppressNotification &&
    (state.lastFailureKind !== "auth" ||
      state.lastFailureReason !== reason ||
      !lastNotifiedAt ||
      Date.now() - lastNotifiedAt >= authFailureNotifyIntervalMs);

  await writeAuthState(env, {
    lastFailureNotifiedAt: shouldNotify ? new Date().toISOString() : state.lastFailureNotifiedAt,
    lastFailureKind: "auth",
    lastFailureReason: reason,
    lastRefreshAttemptedAt: state.lastRefreshAttemptedAt,
    lastRefreshAttemptStatus: state.lastRefreshAttemptStatus
  });

  if (sourceRunId) {
    run.sourceRunId = sourceRunId;
  }

  if (suppressNotification) {
    addStep(run, "send-browserbase-refresh-failed", "skipped", {
      reason: "Notification suppressed by refresh failure request.",
      sourceRunId
    });
  } else if (shouldNotify) {
    const sendStarted = Date.now();
    await sendMessage(
      env,
      [
        "<b>Browserbase refresh failed</b>",
        "Automatic TDF login recovery did not complete.",
        escapeHtml(reason),
        sourceRunId ? `source=${escapeHtml(sourceRunId)}` : "",
        "Send /cookie to paste a fresh TDF cookie."
      ]
        .filter(Boolean)
        .join("\n")
    );
    addStep(run, "send-browserbase-refresh-failed", "success", {
      durationMs: Date.now() - sendStarted,
      sourceRunId
    });
  } else {
    addStep(run, "send-browserbase-refresh-failed", "skipped", {
      reason: "Repeated Browserbase failure notification is throttled.",
      sourceRunId,
      lastFailureNotifiedAt: state.lastFailureNotifiedAt
    });
  }

  finishRun(run, "failure", {
    failureKind: "auth",
    message: reason,
    notificationSent: shouldNotify
  });
  await appendLog(env, run);
  return run;
}

export async function maybeTriggerBrowserbaseRefresh(
  env: Env,
  run: RunLog,
  state: AuthState,
  kind: TdfError["kind"],
  reason: string
): Promise<BrowserbaseRefreshResult> {
  if (kind !== "auth") {
    addStep(run, "browserbase-refresh-dispatch", "skipped", {
      reason: "Only auth failures can trigger Browserbase refresh."
    });
    return { status: "not-auth" };
  }

  if (!env.GITHUB_REFRESH_TOKEN || !env.GITHUB_REPOSITORY) {
    addStep(run, "browserbase-refresh-dispatch", "skipped", {
      reason: "GITHUB_REFRESH_TOKEN or GITHUB_REPOSITORY is not configured."
    });
    return { status: "not-configured" };
  }

  const lastAttemptedAt = state.lastRefreshAttemptedAt
    ? new Date(state.lastRefreshAttemptedAt).valueOf()
    : 0;
  const throttleMs =
    state.lastRefreshAttemptStatus === "dispatch-failed"
      ? browserbaseDispatchFailureRetryMs
      : browserbaseRefreshAttemptIntervalMs;
  if (lastAttemptedAt && Date.now() - lastAttemptedAt < throttleMs) {
    addStep(run, "browserbase-refresh-dispatch", "skipped", {
      reason: "Recent Browserbase refresh attempt is still inside throttle window.",
      lastRefreshAttemptedAt: state.lastRefreshAttemptedAt,
      lastRefreshAttemptStatus: state.lastRefreshAttemptStatus,
      throttleMs
    });
    return { status: "throttled" };
  }

  const started = Date.now();
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/refresh-cookie.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_REFRESH_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "tdf-alerts-worker"
      },
      body: JSON.stringify({
        ref: env.GITHUB_REFRESH_REF ?? "main",
        inputs: {
          reason: reason.slice(0, 200),
          source_run_id: run.id
        }
      })
    }
  );

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    const attemptedAt = new Date().toISOString();
    addStep(run, "browserbase-refresh-dispatch", "failure", {
      durationMs: Date.now() - started,
      status: response.status,
      body,
      lastRefreshAttemptedAt: attemptedAt
    });
    return {
      status: "dispatch-failed",
      attemptedAt,
      failureReason: `GitHub dispatch returned ${response.status}: ${body}`
    };
  }

  const attemptedAt = new Date().toISOString();
  addStep(run, "browserbase-refresh-dispatch", "success", {
    durationMs: Date.now() - started,
    repository: env.GITHUB_REPOSITORY,
    ref: env.GITHUB_REFRESH_REF ?? "main",
    lastRefreshAttemptedAt: attemptedAt
  });

  return { status: "started", attemptedAt };
}

function isTruthy(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes";
}

async function readRefreshFailureDetails(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed = await request.json();
    if (!isRecord(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [
        key,
        typeof value === "string" ? value : String(value)
      ])
    );
  }

  const form = await request.formData();
  return Object.fromEntries(
    [...form.entries()].map(([key, value]) => [
      key,
      typeof value === "string" ? value : value.name
    ])
  );
}

function classifyFailure(error: unknown): TdfError["kind"] {
  if (error instanceof TdfError) {
    return error.kind;
  }
  if (error instanceof Error && /timeout|fetch failed/i.test(error.message)) {
    return "transient";
  }
  return "unexpected";
}
