# Startup Guide

Use this when setting up a new machine or coming back after the local environment has gone stale.

This is an operator guide for this project, not a provider-neutral open-source setup. The supported deployment is Cloudflare Workers with KV, Telegram, and Browserbase.

## 1. Install And Verify Tools

```sh
npm install
npx wrangler --version
gh auth status
```

Wrangler must be logged into Cloudflare:

```sh
npx wrangler login
npx wrangler whoami
```

GitHub CLI needs repo and workflow access because deploys, branch protection, PRs, and Actions inspection use `gh`.

## 2. Understand Where Secrets Live

There are three places to configure values:

| Place | Purpose | Can values be read back? |
|---|---|---|
| `.env` | Local scripts such as Browserbase login, smoke tests, and local E2E | Yes, local file only |
| Cloudflare Worker secrets | Runtime secrets used by deployed Workers | No |
| GitHub Actions secrets | CI E2E, production deploy, Browserbase refresh workflow | No |

Cloudflare and GitHub secrets cannot be fetched back in plain text. Keep copies in a password manager or recreate them.

Never commit `.env`, `.auth/`, cookies, tokens, screenshots, or browser profiles.

## 3. Create Local `.env`

Start from the template:

```sh
cp .env.example .env
```

For normal local scripts against your deployed Worker:

```text
COOKIE_FORM_TOKEN=
WORKER_BASE_URL=https://your-worker.your-subdomain.workers.dev
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=
BROWSERBASE_CONTEXT_ID=
TDF_EMAIL=
TDF_PASSWORD=
```

`TDF_COOKIE` is created or updated by `npm run login:browserbase` and `npm run login:local`. You normally do not type it manually.

For CI-style local E2E against the isolated E2E Worker, use these values in the shell or `.env`:

```text
E2E_WORKER_BASE_URL=https://your-e2e-worker.your-subdomain.workers.dev
E2E_COOKIE_FORM_TOKEN=
E2E_TELEGRAM_CHAT_ID=
```

The E2E Worker uses a separate Browserbase context and separate Cloudflare KV. Do not point E2E at production.

## 4. Cloudflare Configuration

Create Cloudflare KV namespaces for production and E2E:

```sh
npx wrangler kv namespace create TDF_ALERTS
npx wrangler kv namespace create TDF_ALERTS_E2E
```

Copy the returned ids into `wrangler.toml` and `wrangler.e2e.toml`. Each setup needs its own values.

Production Worker config:

```text
name: your-production-worker
kv namespace: your-production-kv-namespace-id
config: wrangler.toml
```

E2E Worker config:

```text
name: your-e2e-worker
kv namespace: your-e2e-kv-namespace-id
config: wrangler.e2e.toml
```

The checked-in `wrangler.toml` files contain this deployment's resource names and namespace ids. They are not secrets. Only replace them when intentionally creating a separate deployment.

Set production Worker secrets:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put COOKIE_FORM_TOKEN
npx wrangler secret put GITHUB_REFRESH_TOKEN
npx wrangler secret list
```

`wrangler.toml` stores non-secret Worker vars:

```text
GITHUB_REPOSITORY=owner/repo
GITHUB_REFRESH_REF=main
```

Production deploys are intentionally blocked locally. `npm run worker:deploy` only works inside GitHub Actions on a push to protected `main`.

Safe local checks:

```sh
npm run quality
npm run worker:dry-run
```

## 5. GitHub Actions Secrets

Required for production deploy and PR E2E:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

`CLOUDFLARE_API_TOKEN` must be a durable Cloudflare API token from the Cloudflare dashboard, not the short-lived local Wrangler OAuth token. Create it at `https://dash.cloudflare.com/profile/api-tokens`, restrict it to the account used by `wrangler.toml`, and give it the permissions needed to deploy Workers and edit KV:

```text
Account Settings: Read
Workers Scripts: Edit
Workers KV Storage: Edit
```

Then update GitHub:

```sh
gh secret set CLOUDFLARE_API_TOKEN --body "cloudflare-api-token"
gh secret set CLOUDFLARE_ACCOUNT_ID --body "cloudflare-account-id"
```

Required for Browserbase refresh workflow:

```text
BROWSERBASE_API_KEY
BROWSERBASE_PROJECT_ID
BROWSERBASE_CONTEXT_ID
TDF_EMAIL
TDF_PASSWORD
COOKIE_FORM_TOKEN
WORKER_BASE_URL
```

Required for isolated PR E2E:

```text
E2E_BROWSERBASE_CONTEXT_ID
E2E_COOKIE_FORM_TOKEN
E2E_TELEGRAM_CHAT_ID
E2E_WORKER_BASE_URL
```

Set or update a secret:

```sh
gh secret set NAME --body "value"
gh secret list
```

## 6. Telegram Chat Id

Use a private test chat for E2E, not the family production group.

To discover a chat id:

```sh
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook?drop_pending_updates=true"
```

Send a message to the bot from the target chat, then run:

```sh
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
```

Read `message.chat.id`.

Restore the production webhook:

```sh
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=$WORKER_BASE_URL/telegram"
```

## 7. Refresh Or Verify The Cookie

Browserbase login against the Worker in `.env`:

```sh
npm run login:browserbase
```

The script logs into TDF, writes `TDF_COOKIE` to `.env`, posts it to `/cookie`, and verifies `/verify-cookie`.

Manual local browser fallback:

```sh
npm run install-browser
npm run login:local
```

Then use Telegram `/cookie` or the `/cookie?token=...` form to save the cookie.

Quiet production checks:

```sh
curl "$WORKER_BASE_URL/health"
curl "$WORKER_BASE_URL/debug?token=$COOKIE_FORM_TOKEN"
curl "$WORKER_BASE_URL/verify-cookie?token=$COOKIE_FORM_TOKEN"
npm run smoke:worker
```

Noisy production checks that send Telegram messages:

```sh
curl "$WORKER_BASE_URL/run-delta?token=$COOKIE_FORM_TOKEN"
curl "$WORKER_BASE_URL/run-daily?token=$COOKIE_FORM_TOKEN"
```

## 8. Run Local CI-Style E2E Safely

Deploy the isolated E2E Worker with E2E-only secrets:

```sh
npm run worker:e2e-deploy -- --secrets-file .auth/e2e-worker-secrets.json
```

The secrets file should look like this:

```json
{
  "TELEGRAM_BOT_TOKEN": "bot-token",
  "TELEGRAM_CHAT_ID": "test-chat-id",
  "COOKIE_FORM_TOKEN": "e2e-cookie-form-token",
  "GITHUB_REFRESH_TOKEN": "e2e-disabled"
}
```

Then log in and run E2E against the E2E Worker:

```sh
WORKER_BASE_URL="$E2E_WORKER_BASE_URL" \
COOKIE_FORM_TOKEN="$E2E_COOKIE_FORM_TOKEN" \
BROWSERBASE_CONTEXT_ID="$E2E_BROWSERBASE_CONTEXT_ID" \
npm run login:browserbase

npm run worker:e2e
```

E2E intentionally exercises Telegram delivery through the test chat. The fake `/refresh-failed` callback is executed with notification suppressed, so it records the callback path without sending a fake Browserbase failure alert.

## 9. PR And Deploy Flow

Use branches and PRs only:

```sh
git switch -c sr/my-change
npm run quality
git push -u origin sr/my-change
gh pr create --base main --fill
```

Required checks before merge:

- `pre-check`
- `e2e`

Only merges to protected `main` deploy production.
