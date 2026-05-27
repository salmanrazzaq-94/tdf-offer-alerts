# Sanitized Telegram Examples

These examples show the shape of the bot output without real account data, chat ids, cookies, or live TDF inventory.

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

## `/debug`

```text
TDF Debug
generated=2026-05-27T01:52:05.000Z
version=2026-05-27.production-hardening-v1

Cookie
saved=2026-05-27T01:42:10.000Z
source=tdf-set-cookie
bytes=247
hasSession=true
hasExpectedSessionCookie=true

Recovery
lastFailure=none
lastFailureAt=none
lastRefreshAttempt=none

Recent
2026-05-27T01:50:02.000Z delta/success shows=4 perf=21 new=0
2026-05-27T01:40:02.000Z delta/success shows=4 perf=21 new=2
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
