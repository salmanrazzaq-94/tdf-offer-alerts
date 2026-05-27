# Sanitized Run Log Examples

These examples show the shape of operational logs written to `RUN_LOGS`. Values are fake and redacted.

## Successful Delta Run

```json
{
  "id": "2026-05-27T01:50:02.000Z-redacted",
  "event": "delta",
  "status": "success",
  "trigger": "cron:*/10 * * * *",
  "startedAt": "2026-05-27T01:50:02.000Z",
  "finishedAt": "2026-05-27T01:50:04.000Z",
  "durationMs": 2000,
  "version": "2026-05-27.production-hardening-v1",
  "shows": 4,
  "performances": 21,
  "newPerformances": 0,
  "notificationSent": false,
  "steps": [
    {
      "name": "acquire-delta-lock",
      "status": "success",
      "details": {
        "owner": "2026-05-27T01:50:02.000Z-redacted"
      }
    },
    {
      "name": "read-cookie",
      "status": "success",
      "details": {
        "cookieBytes": 247,
        "hasSessionCookie": true,
        "hasTnewCookie": true
      }
    },
    {
      "name": "touch-tdf-main-page",
      "status": "success",
      "details": {
        "status": 200,
        "authenticatedSignals": true,
        "setCookieCount": 1,
        "setCookieNames": ["TNEW"]
      }
    },
    {
      "name": "fetch-tdf-performances",
      "status": "success",
      "details": {
        "status": 200,
        "contentType": "application/json",
        "shows": 4,
        "performances": 21
      }
    },
    {
      "name": "diff-offers",
      "status": "success",
      "details": {
        "seenBefore": 21,
        "currentPerformances": 21,
        "newPerformances": 0,
        "recoveredSeenState": false
      }
    },
    {
      "name": "send-delta-alert",
      "status": "skipped",
      "details": {
        "reason": "No new performances."
      }
    },
    {
      "name": "release-delta-lock",
      "status": "success"
    }
  ]
}
```

## Auth Failure With Browserbase Recovery Dispatch

```json
{
  "id": "2026-05-27T02:10:02.000Z-redacted",
  "event": "delta",
  "status": "failure",
  "trigger": "cron:*/10 * * * *",
  "startedAt": "2026-05-27T02:10:02.000Z",
  "finishedAt": "2026-05-27T02:10:03.000Z",
  "durationMs": 1000,
  "version": "2026-05-27.production-hardening-v1",
  "failureKind": "auth",
  "message": "TDF member page redirected to login: https://my.tdf.org/account/login",
  "notificationSent": false,
  "steps": [
    {
      "name": "read-cookie",
      "status": "success",
      "details": {
        "cookieBytes": 247,
        "hasSessionCookie": true,
        "hasTnewCookie": true
      }
    },
    {
      "name": "refresh-tdf-member-session",
      "status": "failure",
      "details": {
        "status": 200,
        "finalUrl": "https://my.tdf.org/account/login"
      }
    },
    {
      "name": "browserbase-refresh-dispatch",
      "status": "success",
      "details": {
        "repository": "example/tdf-offer-alerts",
        "ref": "main",
        "lastRefreshAttemptedAt": "2026-05-27T02:10:03.000Z"
      }
    },
    {
      "name": "failure-notification-throttle",
      "status": "success",
      "details": {
        "shouldNotify": true,
        "notifyNow": false,
        "suppressNotification": true,
        "browserbaseRefreshStatus": "started"
      }
    },
    {
      "name": "send-telegram-failure",
      "status": "skipped",
      "details": {
        "reason": "Automatic Browserbase recovery is handling this auth failure."
      }
    }
  ]
}
```
