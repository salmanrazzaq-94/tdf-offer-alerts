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
  const response = await fetch(`${root}${path}`);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return JSON.parse(body);
}

const health = await fetchJson("/health");
if (health.ok !== true) {
  throw new Error(`/health returned unexpected payload: ${JSON.stringify(health)}`);
}

const debug = await fetchJson(`/debug?token=${encodeURIComponent(token)}`);
if (typeof debug.version !== "string" || !debug.cookie || !debug.auth) {
  throw new Error(`/debug returned unexpected payload: ${JSON.stringify(debug)}`);
}

const verification = await fetchJson(`/verify-cookie?token=${encodeURIComponent(token)}`);
if (verification.status !== "success") {
  throw new Error(`/verify-cookie failed: ${JSON.stringify(verification)}`);
}

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
