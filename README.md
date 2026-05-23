# TDF Offer Alerts

Phone-first TDF availability watcher with Telegram alerts, a Cloudflare Worker command bot, and optional Browserbase login testing.

## Current Direction

The preferred V1 shape is:

- Cloudflare Worker handles Telegram commands over a webhook.
- Cloudflare KV stores the current TDF cookie for the bot.
- GitHub Actions can still run scheduled delta checks and 9am digests, but they fetch the TDF cookie from Cloudflare at runtime.
- `/offers` sends the latest current offers summary and a timestamped text attachment.
- `/status` checks whether the saved cookie still works.
- `/cookie` returns a private form link for saving a fresh cookie.
- Local scripts are used for development, testing, and cookie refresh experiments.
- Browserbase is used only when the saved cookie expires and needs refreshing.

This project does not bypass captchas or security challenges. If TDF shows a captcha, access-denied page, MFA, or a human verification step, the automation stops and reports that the session needs attention.

## How Offers Are Checked

The checker requests:

```text
https://nycgw47.tdf.org/TDFCustomOfferings/Current?handler=Performances
```

It parses the returned JSON into shows and performances. A unique performance is:

```text
productionSeasonId:performanceId
```

Removed offers are ignored. New shows or new times can be alerted in the delta checker. Current digest messages include all currently available shows.

## Public Repo Safety

It is okay for the repo to be public if these stay secret:

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

## Local Setup

Install dependencies:

```sh
npm install
```

Create local env:

```sh
cp .env.example .env
```

Fill in the values you need for the script you are running.

Run tests:

```sh
npm test
```

Run the local checker with `TDF_COOKIE` from `.env`:

```sh
npm run start:local
```

Send the current digest locally:

```sh
npm run send-current:local
```

## Cloudflare Worker Bot

The Worker is the phone-friendly surface:

- `/offers`: sends the latest current TDF offers and details file.
- `/status`: tests whether the saved cookie works.
- `/cookie`: sends a private Cloudflare form URL for pasting a fresh cookie.
- `/help`: lists commands.

Deploy:

```sh
npm run worker:deploy
```

The Worker stores the cookie in Cloudflare KV under:

```text
TDF_COOKIE
```

## Browserbase Login Test

Browserbase may let us run a normal headless login flow and export fresh cookies automatically. This only works if TDF serves the normal login form and does not require a human challenge.

Use Browserbase only as a refresh path when the saved cookie fails. Normal `/offers` and `/status` checks should reuse the saved cookie from Cloudflare KV.

Required local `.env` values:

```text
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=
BROWSERBASE_CONTEXT_ID=
TDF_EMAIL=
TDF_PASSWORD=
```

`BROWSERBASE_CONTEXT_ID` is optional the first time. If it is missing, the script creates a persistent Browserbase Context and saves the ID to `.env`.

Run:

```sh
npm run login:browserbase
```

What it does:

- Creates a Browserbase session attached to the persistent Context.
- Connects Playwright over CDP.
- Opens `https://my.tdf.org/account/login`.
- Fills the TDF email and password from local env.
- Stops if TDF shows a captcha, access-denied page, or security challenge.
- Opens the TDF offers page.
- Exports cookies and verifies the performances JSON endpoint.
- Saves the working `TDF_COOKIE` to `.env`.

Browserbase Context docs: [Contexts](https://docs.browserbase.com/features/contexts)

## GitHub Actions

GitHub Actions are kept for scheduled checks:

- `Check TDF Offers`: runs every 10 minutes and alerts only on newly seen performances.
- `Daily Current TDF Offers`: sends a 9am America/New_York digest with all current offers.

The workflows do not store the TDF cookie in GitHub Secrets. Instead, they fetch it from the Cloudflare Worker:

```text
https://tdf-alerts-bot.salmanrazzaq94.workers.dev/tdf-cookie?token=...
```

Required GitHub Actions secrets:

```text
COOKIE_FORM_TOKEN
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

The `COOKIE_FORM_TOKEN` must match the secret configured on the Cloudflare Worker. This lets GitHub retrieve the current cookie from Cloudflare KV without duplicating `TDF_COOKIE` in GitHub.

## Cookie Lifetime

TDF controls cookie lifetime on its servers. The browser may show some cookies as `Session`, while others have future dates, but the authenticated session can still stop working earlier.

Common reasons:

- TDF invalidates the server-side session.
- The login was created from one browser/IP/fingerprint and reused from another.
- Imperva/security cookies rotate.
- The account logs out or TDF forces a fresh shared-session handshake.
- A security challenge appears and requires a human browser session.

There is no reliable client-side setting that prolongs this. The practical strategy is:

- Reuse the existing cookie until `/status` or `/offers` says it failed.
- Run `npm run login:browserbase` only after the cookie expires.
- Save the refreshed `TDF_COOKIE` to Cloudflare KV.
- Fall back to `npm run login:local` if Browserbase hits a human challenge.

## Local Manual Login Fallback

If Browserbase cannot complete the login because TDF requires a human challenge, use the local browser helper:

```sh
npm run install-browser
npm run login:local
```

That opens a local Playwright browser profile. Log in manually, and the script waits until the TDF endpoint works, then saves `TDF_COOKIE` to `.env`.

## Run Logs

Local and workflow checker results are stored in:

```text
data/run-log.jsonl
```

Useful checks:

```sh
tail -n 20 data/run-log.jsonl
```

Failure entries include `failureKind` when the checker can classify the problem:

- `auth`: TDF redirected to login or showed a login/challenge page. Refresh the cookie.
- `transient`: TDF or the network returned a retryable server/network error.
- `unexpected`: something else changed and needs inspection.
