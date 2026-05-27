# Sanitized Telegram And Operator Examples

These examples show the shape of bot output and operator HTTP diagnostics without real account data, chat ids, cookies, tokens, or live TDF inventory.

## New Offers Alert

```text
TDF Offers
2 shows, 5 performances available.
2 matching/new performances in this message.

Available shows
- Example Broadway Preview (3)
- Sample Off-Broadway Comedy (2)
```

Attached details file:

```text
TDF OFFERS
2 shows | 5 performances | 2 new

SHOWS
1. Example Broadway Preview (3)
2. Sample Off-Broadway Comedy (2)

DETAILS

Example Broadway Preview
Example Theatre
NEW Wed, May 27, 7:00 PM
Thu, May 28, 7:00 PM
Sat, May 30, 2:00 PM

Sample Off-Broadway Comedy
Sample Stage
NEW Fri, May 29, 8:00 PM
Sun, May 31, 3:00 PM
```

## `/status`

```text
TDF Status
Cookie works now. 4 shows, 21 performances available.
Cookie saved: 2026-05-27T01:42:10.000Z (tdf-set-cookie)
Last success: 2026-05-27T01:50:02.000Z
Last failure: none
Browserbase refresh attempted: none
Worker: 2026-05-27.production-hardening-v1
```

## Operator `/debug?token=...`

```text
{
  "version": "2026-05-27.production-hardening-v1",
  "cookie": { "savedAt": "2026-05-27T01:42:10.000Z", "source": "tdf-set-cookie" },
  "auth": { "lastFailureKind": null, "lastRefreshAttemptStatus": null },
  "health": { "lastDeltaSuccessAt": "2026-05-27T01:50:02.000Z" },
  "lastFailure": null
}
```

## Browserbase Refresh Failure Alert

```text
Browserbase refresh failed
Automatic TDF login recovery did not complete.
Browserbase refresh workflow failed: https://github.com/example/tdf-offer-alerts/actions/runs/123456789
source=2026-05-27T01:30:00.000Z-redacted
Send /cookie to paste a fresh TDF cookie.
```

## Manual Cookie Link

```text
Paste a fresh TDF cookie here:
https://example-worker.example.workers.dev/cookie?token=redacted-token
```
