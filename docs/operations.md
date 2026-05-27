# Operations

This guide is the production runbook for a solo operator. It keeps the commands explicit and avoids any requirement for a separate staging environment.

## Required Secrets

Cloudflare Worker secrets:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
COOKIE_FORM_TOKEN
GITHUB_REFRESH_TOKEN
```

Cloudflare Worker vars:

```text
GITHUB_REPOSITORY=salmanrazzaq-94/tdf-offer-alerts
GITHUB_REFRESH_REF=main
```

GitHub Actions secrets for Browserbase refresh:

```text
BROWSERBASE_API_KEY
BROWSERBASE_PROJECT_ID
BROWSERBASE_CONTEXT_ID
TDF_EMAIL
TDF_PASSWORD
COOKIE_FORM_TOKEN
WORKER_BASE_URL
```

GitHub Actions secrets for isolated PR E2E and production deploy:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
E2E_BROWSERBASE_CONTEXT_ID
E2E_COOKIE_FORM_TOKEN
E2E_TELEGRAM_CHAT_ID
E2E_WORKER_BASE_URL
```

Local `.env` values for manual refresh and smoke checks:

```text
COOKIE_FORM_TOKEN=
WORKER_BASE_URL=https://example-worker.example.workers.dev
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=
BROWSERBASE_CONTEXT_ID=
TDF_EMAIL=
TDF_PASSWORD=
```

Never commit `.env`, cookies, screenshots from logged-in browser sessions, browser storage, tokens, chat ids, or credentials.

## Normal Verification

Use one local command before opening or updating a PR:

```sh
npm run quality
```

That runs strict TypeScript, typed ESLint, Knip, production-code coverage gates, and Wrangler dry-run.

For deployed production smoke:

```sh
WORKER_BASE_URL=https://example-worker.example.workers.dev \
COOKIE_FORM_TOKEN=redacted-token \
npm run smoke:worker
```

Production smoke intentionally checks only `/health`, `/debug`, and `/verify-cookie`. It does not trigger Telegram alerts, daily digest, delta runs, or refresh-failure callbacks.

## Manual Cookie Refresh

Use Browserbase first when the saved session needs repair:

```sh
npm run login:browserbase
```

The script logs into TDF, verifies the performances endpoint, writes `TDF_COOKIE` locally, and posts it to the Worker `/cookie` endpoint when `WORKER_BASE_URL` and `COOKIE_FORM_TOKEN` are configured.

If Cloudflare KV writes are exhausted for the day, normal TDF reads still keep a refreshed cookie in the Worker runtime and attempt a one-day Cloudflare Cache fallback. This is an emergency bridge for `/offers` and cron while KV is unavailable; KV remains the canonical cookie store when writes recover.

If Browserbase hits a human challenge:

```sh
npm run install-browser
npm run login:local
```

Then send `/cookie` to the Telegram bot and paste the saved cookie into the private form URL.

## Reading `/debug`

`/debug?token=...` is the fastest operational snapshot. Check:

| Field | Meaning |
|---|---|
| `cookie.savedAt` | When the Worker last accepted a cookie |
| `cookie.source` | `cookie-form` for manual/API update or `tdf-set-cookie` for TDF rotation |
| `cookie.hasSessionCookie` / `hasTnewCookie` | Whether expected session markers are present |
| `auth.lastFailureKind` | Last classified failure, if any |
| `auth.lastRefreshAttemptStatus` | Browserbase dispatch state: `started`, `throttled`, `dispatch-failed`, or config fallback |
| `health.lastDeltaSuccessAt` | Last persisted successful delta timestamp |
| `lastFailure` | Last failed Worker run persisted as a failure breadcrumb |
| `recentRuns` | Compact persisted failure breadcrumbs and any legacy run entries |

Use Cloudflare Workers Logs for routine successful run details. Use `/logs?token=...` only when you need persisted failure breadcrumbs from KV.

## Common Incidents

| Symptom | First check | Usual action |
|---|---|---|
| No Telegram alerts | Workers Logs and `/debug` | Confirm delta checks are succeeding and `newPerformances` is actually nonzero |
| Cookie expired | `auth.lastFailureKind = auth` | Wait for Browserbase dispatch or run `npm run login:browserbase` |
| Browserbase failed | Telegram refresh-failure alert, Workers Logs, or `/logs` failure breadcrumb | If challenge/captcha appears, use `npm run login:local` and `/cookie` |
| TDF is down or rate limited | failure kind `transient` | Let scheduled retries continue unless failures persist |
| Telegram document failed | run step `send-telegram-document:failure` | Summary still sent; inspect Telegram/API status before retrying |
| Corrupted KV state | run step shows recovered state | Let the next successful run rewrite the recovered key |
| Production deploy failed | GitHub `Deploy Worker` workflow | Inspect `npm run quality`, deploy, and smoke steps in order |

## Production Deploy Model

Production deploys happen only through GitHub Actions on protected `main`.

The deploy workflow:

1. Checks out the merged commit.
2. Installs dependencies with `npm ci`.
3. Runs `npm run quality`.
4. Runs `npm run worker:deploy`.
5. Runs quiet production smoke.

`npm run worker:deploy` is guarded so accidental local production deploys or manual workflow dispatches are rejected.
