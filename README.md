# TDF Offer Alerts

Cloudflare Worker + Telegram bot for TDF offer monitoring.

## Production Design

Cloudflare is the app. GitHub Actions are not used for runtime checks.

- Cloudflare Worker receives Telegram commands.
- Cloudflare Cron runs scheduled checks.
- Cloudflare KV stores the TDF cookie, seen offer IDs, auth state, and recent run logs.
- Browserbase is only used when the saved cookie expires and needs a refresh.
- The normal checker never receives Browserbase credentials or TDF credentials.

## Commands

Telegram commands:

- `/offers`: fetch current TDF offers now and send a summary plus text attachment.
- `/status`: test whether the saved cookie still works.
- `/logs`: show recent run summaries.
- `/cookie`: get a private form link for pasting a fresh cookie manually.

Private HTTP test endpoints, protected by `COOKIE_FORM_TOKEN`:

- `/run-delta?token=...`: run the delta checker now.
- `/run-daily?token=...`: send the current digest now.
- `/logs?token=...`: inspect full structured logs as JSON.
- `/cookie?token=...`: paste and test a fresh cookie.

## Scheduled Runs

Configured in `wrangler.toml`:

- `*/10 * * * *`: delta check every 10 minutes.
- `0 13 * * *` and `0 14 * * *`: daily digest guard for 9am America/New_York.

The double daily cron covers daylight saving time. The Worker sends only when New York local hour is actually `09`.

## Logging

Every Worker run writes a structured log entry to Cloudflare KV key `RUN_LOGS`.

Each log includes:

- run id, event, trigger, start/end time, duration
- success/failure/skipped status
- show count, performance count, new performance count
- notification status
- failure kind: `auth`, `transient`, or `unexpected`
- step-by-step diagnostics such as cookie bytes, session cookie presence, TDF HTTP status, content type, response size, retry waits, seen-state counts, and notification throttle decisions

View logs:

```sh
curl "https://tdf-alerts-bot.salmanrazzaq94.workers.dev/logs?token=$COOKIE_FORM_TOKEN"
```

Or send `/logs` in Telegram.

## Cookie Strategy

The cheapest robust strategy is:

1. Use the saved cookie in Cloudflare KV for all normal checks.
2. If `/status`, `/offers`, or cron says the cookie failed, do not keep spamming alerts.
3. Refresh the cookie with Browserbase only when needed.
4. Browserbase logs in, verifies the TDF endpoint, and updates Cloudflare KV through the Worker.

Cookie expiry cannot reliably be prolonged from our side. TDF controls server-side sessions and security cookies, and can invalidate them based on time, IP, browser fingerprint, logout, or security rotation.

## Browserbase Refresh

Required local `.env` values:

```text
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=
BROWSERBASE_CONTEXT_ID=
TDF_EMAIL=
TDF_PASSWORD=
COOKIE_FORM_TOKEN=
WORKER_BASE_URL=https://tdf-alerts-bot.salmanrazzaq94.workers.dev
```

`BROWSERBASE_CONTEXT_ID` is optional the first time. If missing, the script creates a persistent Browserbase Context and saves the ID to `.env`.

Run only when the saved cookie has expired:

```sh
npm run login:browserbase
```

The script:

- opens Browserbase headless with Playwright over CDP
- logs into `https://my.tdf.org/account/login`
- stops if TDF shows a captcha/access-denied/security challenge
- verifies the performances endpoint
- saves `TDF_COOKIE` to `.env`
- updates Cloudflare KV by POSTing to the Worker cookie form endpoint

## Manual Fallback

If Browserbase hits a human challenge:

```sh
npm run install-browser
npm run login:local
```

Then paste the saved cookie with `/cookie`, or keep `COOKIE_FORM_TOKEN` set and use the Worker form URL.

## Local Development

Install dependencies:

```sh
npm install
```

Run checks/tests:

```sh
npm run check
npm test
```

Deploy Worker:

```sh
npm run worker:deploy
```

## Secrets

Keep these out of git:

- `TDF_COOKIE`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `COOKIE_FORM_TOKEN`
- `BROWSERBASE_API_KEY`
- `BROWSERBASE_PROJECT_ID`
- `BROWSERBASE_CONTEXT_ID`
- `TDF_EMAIL`
- `TDF_PASSWORD`

Never commit `.env`, exported cookies, screenshots of logged-in pages, or browser storage files.
