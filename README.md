# TDF Offer Alerts

Public-repo friendly GitHub Action that checks TDF offers every 10 minutes and sends Telegram alerts for newly seen performances.

## How It Works

- The scheduled Action does a direct HTTP request to `https://nycgw47.tdf.org/TDFCustomOfferings/Current?handler=Performances`.
- Authentication comes from a `TDF_COOKIE` GitHub Actions secret.
- New performances are detected by `productionSeasonId:performanceId`.
- Seen performances are stored in `data/seen-offers.json` and committed back to the repo.
- Telegram receives one alert per newly seen performance.

The scheduled workflow does not launch Browserbase or Playwright, which keeps the normal every-10-minute run as cheap as possible. Browserbase is only an optional helper for manual login/cookie refresh.

## Public Repo Safety

It is okay for this repo to be public if these stay secret:

- `TDF_COOKIE`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `BROWSERBASE_API_KEY`
- `BROWSERBASE_CONTEXT_ID`
- `BROWSERBASE_PROJECT_ID`

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

Optional local refresh helpers:

```text
BROWSERBASE_API_KEY
BROWSERBASE_PROJECT_ID
BROWSERBASE_CONTEXT_ID
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

Fill in Telegram and either paste a fresh `TDF_COOKIE` manually or use the Browserbase refresh flow below.

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

Manual browser method:

1. Log in to TDF in your browser.
2. Open DevTools -> Network.
3. Visit `https://nycgw47.tdf.org/TDFCustomOfferings/Current`.
4. Find the request to `Current?handler=Performances`.
5. Copy the full `Cookie` request header.
6. Save it as `TDF_COOKIE` in `.env` and GitHub Actions Secrets.

Browserbase helper method:

```sh
npm run create-context:local
```

Save the printed id as `BROWSERBASE_CONTEXT_ID` in `.env`, then:

```sh
npm run refresh-session:local
```

Open the printed Browserbase debugger URL and log in to TDF manually. After login:

```sh
npm run export-cookie:local
```

Copy the printed cookie header into `TDF_COOKIE`.

## GitHub Action

The workflow runs:

- every 10 minutes
- manually with `workflow_dispatch`

It typechecks, runs unit tests, checks TDF, sends Telegram alerts, and commits `data/seen-offers.json` if new performances were found.

## Cookie Expiration

If TDF returns a login page, captcha page, or non-JSON response, the workflow sends a Telegram message telling you to refresh `TDF_COOKIE`.

This project does not bypass captchas. When TDF requires a human challenge, refresh the cookie manually and update the secret.
