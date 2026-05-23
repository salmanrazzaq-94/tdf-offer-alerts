# TDF Offer Alerts

Private GitHub Action that checks TDF offers every 10 minutes and sends Telegram alerts for newly seen performances.

## What it does

- Connects to a Browserbase browser with a persistent context.
- Opens the authenticated TDF offers page.
- Calls `https://nycgw47.tdf.org/TDFCustomOfferings/Current?handler=Performances`.
- Compares every `productionSeasonId:performanceId` against `data/seen-offers.json`.
- Sends a Telegram alert for new performances.
- Commits the updated seen-offers snapshot back to the private repo.

This project does not bypass captchas. If TDF asks for a new human challenge or the session expires, the workflow sends a Telegram message asking you to refresh the Browserbase context and exits with failure.

## Required GitHub secrets

- `BROWSERBASE_API_KEY`
- `BROWSERBASE_CONTEXT_ID`
- `BROWSERBASE_PROJECT_ID` if Browserbase requires it for your account/project
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Do not commit TDF credentials, cookies, storage state, or exported browser sessions.

## Telegram setup

1. Message `@BotFather` in Telegram and create a bot.
2. Save the bot token as `TELEGRAM_BOT_TOKEN`.
3. Send a message to your bot.
4. Use Telegram `getUpdates` or a chat-id helper bot to find your chat id.
5. Save it as `TELEGRAM_CHAT_ID`.

## Browserbase session setup

1. Create a Browserbase API key.
2. Add the Browserbase and Telegram environment variables locally in `.env`.
3. If you do not have a context id, run `npm run create-context:local` and save the printed id as `BROWSERBASE_CONTEXT_ID`.
4. Run `npm run refresh-session:local`.
5. Open the printed Browserbase debugger URL and log in to TDF manually.
6. Run the GitHub Action manually with `workflow_dispatch`.

If the Action reports that login needs attention, refresh the Browserbase context by logging in manually again.

## Local test

Create a local `.env` from the example:

```sh
cp .env.example .env
```

Fill in:

```text
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=
BROWSERBASE_CONTEXT_ID=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Then run:

```sh
npm test
npm run create-context:local
npm run refresh-session:local
npm run start:local
```

The first live `start:local` run will send alerts for every currently visible performance and write them to `data/seen-offers.json`. Commit that file after the first successful run if you do not want GitHub Actions to alert on the same existing performances again.
