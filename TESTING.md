# Testing and Quality Gates

This project uses two kinds of verification.

## Pull request gates

`npm run quality` is the required local and CI gate for code changes. It runs:

- `npm run typecheck` for strict TypeScript checks across Node scripts, tests, and the Cloudflare Worker runtime.
- `npm run lint` for typed ESLint rules with zero warnings.
- `npm run knip` for unused files, exports, and dependency hygiene.
- `npm run test:coverage` for deterministic tests with coverage counted across production modules and enforced at 80%+ line/branch coverage.
- `npm run worker:dry-run` for a Wrangler dry-run deployment bundle check.

`main` is protected and requires the `pre-check` status before merging. Keep `npm run quality` as the one required local command and the first CI gate.

Deterministic tests do not call live TDF, Telegram, GitHub, Browserbase, or Cloudflare services. External boundaries are faked only where needed to make code paths deterministic and to assert request shape.

## Pull request E2E

The `pre-check` workflow also runs an isolated E2E Worker path after `npm run quality` passes. That E2E job uses separate secrets, refreshes a cookie through Browserbase, and exercises `/cookie`, `/verify-cookie`, `/run-delta`, `/run-daily`, operator `/debug` and `/logs`, supported Telegram commands, and `/refresh-failed`.

The GitHub E2E job sends Telegram test messages only to the E2E test chat. The fake `/refresh-failed` callback is exercised with notification suppressed, so CI does not send a fake Browserbase failure alert.

## Live Worker smoke

`npm run smoke:worker` verifies the deployed Worker with real Cloudflare KV and the saved TDF session. It requires:

```text
WORKER_BASE_URL=
COOKIE_FORM_TOKEN=
```

It checks `/health`, `/debug`, and `/verify-cookie`. It intentionally does not call noisy endpoints such as `/run-delta`, `/run-daily`, `/telegram`, or Browserbase refresh.
