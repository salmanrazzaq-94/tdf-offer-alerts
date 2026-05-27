const baseUrl = process.env.WORKER_BASE_URL;
const token = process.env.COOKIE_FORM_TOKEN;

if (!baseUrl) {
  throw new Error("WORKER_BASE_URL is required.");
}

if (!token) {
  throw new Error("COOKIE_FORM_TOKEN is required.");
}

const root = baseUrl.replace(/\/$/, "");

async function fetchJson(path) {
  const started = Date.now();
  log("smoke-fetch-start", { path });
  const response = await fetch(`${root}${path}`);
  const body = await response.text();
  log(response.ok ? "smoke-fetch-success" : "smoke-fetch-failure", {
    path,
    status: response.status,
    bodyBytes: body.length,
    durationMs: Date.now() - started
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return JSON.parse(body);
}

log("smoke-start", { worker: root });

const health = await fetchJson("/health");
if (health.ok !== true) {
  throw new Error(`/health returned unexpected payload: ${JSON.stringify(health)}`);
}
log("smoke-health-ok");

const debug = await fetchJson(`/debug?token=${encodeURIComponent(token)}`);
if (typeof debug.version !== "string" || !debug.cookie || !debug.auth) {
  throw new Error(`/debug returned unexpected payload: ${JSON.stringify(debug)}`);
}
log("smoke-debug-ok", {
  workerVersion: debug.version,
  cookieSavedAt: debug.cookie.savedAt ?? "unknown",
  lastFailureKind: debug.auth.lastFailureKind ?? "none"
});

const verification = await fetchJson(`/verify-cookie?token=${encodeURIComponent(token)}&persist=false`);
if (verification.status !== "success") {
  throw new Error(`/verify-cookie failed: ${JSON.stringify(verification)}`);
}
log("smoke-verify-ok", {
  shows: verification.shows,
  performances: verification.performances
});

console.log(
  JSON.stringify(
    {
      status: "success",
      worker: debug.version,
      shows: verification.shows,
      performances: verification.performances
    },
    null,
    2
  )
);

function log(event, details = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    operation: "smoke-worker",
    event,
    ...sanitize(details)
  }));
}

function sanitize(value) {
  if (typeof value === "string") {
    return value.replaceAll(/token=[^&\s]+/gi, "token=[redacted]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "[redacted]" : sanitize(item)
      ])
    );
  }
  return value;
}

function isSensitiveKey(key) {
  const normalized = key.toLowerCase();
  return normalized === "token" ||
    normalized === "cookie" ||
    normalized === "password" ||
    normalized === "secret" ||
    normalized.endsWith("_token") ||
    normalized.endsWith("-token");
}
