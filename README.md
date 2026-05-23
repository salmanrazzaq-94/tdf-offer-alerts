# TDF Offer Alerts

Public-repo friendly GitHub Action that checks TDF offers every 10 minutes and sends Telegram alerts for newly seen performances.

## How It Works

- The scheduled Action does a direct HTTP request to `https://nycgw47.tdf.org/TDFCustomOfferings/Current?handler=Performances`.
- Authentication comes from a `TDF_COOKIE` GitHub Actions secret.
- New performances are detected by `productionSeasonId:performanceId`.
- Seen performances are stored in `data/seen-offers.json` and committed back to the repo.
- Telegram receives one alert per newly seen performance.

The scheduled workflow does not launch Playwright, which keeps the normal every-10-minute run as cheap as possible. Playwright is only a local helper for refreshing cookies when the TDF session expires.

## Public Repo Safety

It is okay for this repo to be public if these stay secret:

- `TDF_COOKIE`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Never commit `.env`, exported cookies, screenshots of logged-in pages, or browser storage files.

`data/seen-offers.json` is public-safe in the sense that it only contains seen offer IDs, but it does reveal what offers the watcher has observed.

## Required GitHub Secrets

Add these in GitHub: `Settings` -> `Secrets and variables` -> `Actions`.

Required for scheduled runs:

```text
TDF_COOKIE
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

## Local Setup

Install dependencies:

```sh
npm install
```

Create local env:

```sh
cp .env.example .env
```

Fill in Telegram and either paste a fresh `TDF_COOKIE` manually or use the local Playwright refresh flow below.

Run tests:

```sh
npm test
```

Run the checker locally:

```sh
npm run start:local
```

The first successful run will alert on every currently visible performance and update `data/seen-offers.json`.

## Telegram Setup

1. Message `@BotFather` in Telegram.
2. Create a bot with `/newbot`.
3. Save the token as `TELEGRAM_BOT_TOKEN`.
4. Send a message to your new bot.
5. Visit `https://api.telegram.org/bot<token>/getUpdates`.
6. Save the private chat id as `TELEGRAM_CHAT_ID`.

## TDF Cookie Setup

The Action needs a cookie header copied from a logged-in TDF browser session.

Local Playwright method:

Install Playwright's local Chromium once:

```sh
npm run install-browser
```

Open a local browser profile and log into TDF:

```sh
npm run login:local
```

The script waits for a working login, exports the cookies, tests the TDF JSON endpoint, and saves `TDF_COOKIE` into `.env`.

Manual browser method:

1. Log in to TDF in your browser.
2. Open DevTools -> Network.
3. Visit `https://nycgw47.tdf.org/TDFCustomOfferings/Current`.
4. Find the request to `Current?handler=Performances`.
5. Copy the full `Cookie` request header.
6. Save it as `TDF_COOKIE` in `.env` and GitHub Actions Secrets.

## GitHub Action

The delta workflow runs:

- every 10 minutes
- manually with `workflow_dispatch`

It typechecks, runs unit tests, checks TDF, sends Telegram alerts only for newly seen `productionSeasonId:performanceId` combinations, and commits `data/seen-offers.json` if new performances were found.

Removed performances do not trigger alerts.

The daily current workflow runs at 9am America/New_York and sends the current availability digest plus an attached details file. It does not update `data/seen-offers.json`.

## Cookie Expiration

If TDF returns a login page, captcha page, or non-JSON response, the workflow sends a Telegram message telling you to refresh `TDF_COOKIE`.

This project does not bypass captchas. When TDF requires a human challenge, refresh the cookie manually and update the secret.
