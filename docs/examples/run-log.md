# Sanitized Operational Log Examples

Runs are emitted as structured `console.log` events and stored in Cloudflare Workers Logs. KV is not used for run-log storage. Values are fake and redacted.

## Successful Delta Run In Workers Logs

```json
{
  "event": "tdf-run-finished",
  "run": {
    "id": "2026-05-27T01:50:02.000Z-redacted",
    "event": "delta",
    "status": "success",
    "trigger": "cron:*/10 * * * *",
    "durationMs": 2000,
    "shows": 4,
    "performances": 21,
    "newPerformances": 0,
    "notificationSent": false,
    "steps": 11
  },
  "stepSummaries": [
    { "name": "read-cookie", "status": "success" },
    { "name": "fetch-tdf-performances", "status": "success" },
    { "name": "diff-offers", "status": "success" },
    { "name": "send-delta-alert", "status": "skipped" }
  ]
}
```

## Auth Failure In Workers Logs

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
