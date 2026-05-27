const DEFAULT_ACCOUNT_ID = "4d8e30630732fe621de16cbbb4f60e7a";
const DEFAULT_WORKER_NAME = "tdf-alerts-bot";
const DEFAULT_MINUTES = 120;
const DEFAULT_LIMIT = 100;

const SENSITIVE_KEY_PATTERN = /(^|[_-])(token|cookie|password|secret|authorization|auth)([_-]|$)/i;

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const token = process.env.CLOUDFLARE_API_TOKEN;

if (!token) {
  throw new Error("CLOUDFLARE_API_TOKEN is required. Run with `node --env-file=.env ...` locally.");
}

const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID;
const workerName = options.worker ?? process.env.WORKER_NAME ?? DEFAULT_WORKER_NAME;
const to = options.to ? Date.parse(options.to) : Date.now();
const from = options.from ? Date.parse(options.from) : to - options.minutes * 60 * 1000;

if (!Number.isFinite(from) || !Number.isFinite(to)) {
  throw new Error("--from and --to must be parseable date strings.");
}

if (from >= to) {
  throw new Error("--from must be earlier than --to.");
}

const result = await queryWorkerLogs({
  accountId,
  token,
  workerName,
  from,
  to,
  limit: options.limit,
  event: options.event,
  runStatus: options.status,
  trigger: options.trigger,
  search: options.search,
});

const events = extractEvents(result);

if (options.json) {
  console.log(JSON.stringify(sanitize(events), null, 2));
} else {
  printSummary({ events, workerName, from, to });
}

async function queryWorkerLogs({
  accountId,
  token,
  workerName,
  from,
  to,
  limit = DEFAULT_LIMIT,
  event,
  runStatus,
  trigger,
  search,
}) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`;
  const filters = [
    { key: "$workers.scriptName", operation: "eq", type: "string", value: workerName },
  ];

  if (event) {
    filters.push({ key: "event", operation: "eq", type: "string", value: event });
  }
  if (runStatus) {
    filters.push({ key: "run.status", operation: "eq", type: "string", value: runStatus });
  }
  if (trigger) {
    filters.push({ key: "run.trigger", operation: "includes", type: "string", value: trigger });
  }

  const body = {
    queryId: `codex-worker-logs-${Date.now()}`,
    timeframe: { from, to },
    limit,
    dry: true,
    view: "events",
    parameters: {
      datasets: ["cloudflare-workers"],
      filterCombination: "and",
      filters,
      ...(search ? { needle: { value: search, matchCase: false, isRegex: false } } : {}),
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();

  if (!response.ok || data.success !== true) {
    const message = data?.errors?.map((error) => error.message).join("; ") ||
      data?.error?.message ||
      response.statusText;
    throw new Error(`Cloudflare telemetry query failed (${response.status}): ${message}`);
  }

  return data.result;
}

function extractEvents(result) {
  const rawEvents = result?.events?.events;
  if (!Array.isArray(rawEvents)) {
    return [];
  }

  return rawEvents.map((event) => ({
    timestamp: new Date(event.timestamp).toISOString(),
    requestId: event.$metadata?.requestId ?? event.$workers?.requestId ?? null,
    origin: event.$metadata?.origin ?? event.$workers?.eventType ?? null,
    trigger: event.$metadata?.trigger ?? null,
    outcome: event.$workers?.outcome ?? null,
    scriptVersion: event.$workers?.scriptVersion?.id ?? null,
    source: sanitize(event.source ?? {}),
  }));
}

function summarizeEvent(event) {
  const source = event.source ?? {};
  const run = source.run;
  if (run) {
    const failedSteps = Array.isArray(source.stepSummaries)
      ? source.stepSummaries.filter((step) => step.status === "failure")
      : [];
    return {
      timestamp: event.timestamp,
      event: source.event ?? run.event ?? "run",
      runEvent: run.event,
      status: run.status,
      trigger: run.trigger ?? event.trigger,
      durationMs: run.durationMs,
      shows: run.shows,
      performances: run.performances,
      newPerformances: run.newPerformances,
      notificationSent: run.notificationSent,
      failedSteps,
    };
  }

  return {
    timestamp: event.timestamp,
    event: source.event ?? event.trigger ?? "worker-event",
    trigger: event.trigger,
    outcome: event.outcome,
    message: source.message ?? source.error ?? null,
  };
}

function sanitize(value) {
  if (typeof value === "string") {
    return value
      .replaceAll(/([?&](?:token|code|password|secret|auth)[^=]*=)[^&\s]+/gi, "$1[redacted]")
      .replaceAll(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitize(item),
      ]),
    );
  }

  return value;
}

function printSummary({ events, workerName, from, to }) {
  console.log(JSON.stringify({
    event: "worker-log-query",
    worker: workerName,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    count: events.length,
  }));

  for (const event of events) {
    const summary = summarizeEvent(event);
    console.log(JSON.stringify(sanitize(summary)));
  }
}

function parseArgs(args) {
  const parsed = {
    minutes: DEFAULT_MINUTES,
    limit: DEFAULT_LIMIT,
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--minutes") parsed.minutes = Number(next());
    else if (arg === "--limit") parsed.limit = Number(next());
    else if (arg === "--from") parsed.from = next();
    else if (arg === "--to") parsed.to = next();
    else if (arg === "--worker") parsed.worker = next();
    else if (arg === "--account-id") parsed.accountId = next();
    else if (arg === "--event") parsed.event = next();
    else if (arg === "--status") parsed.status = next();
    else if (arg === "--trigger") parsed.trigger = next();
    else if (arg === "--search") parsed.search = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(parsed.minutes) || parsed.minutes <= 0) {
    throw new Error("--minutes must be a positive number.");
  }
  if (!Number.isFinite(parsed.limit) || parsed.limit <= 0 || parsed.limit > 2000) {
    throw new Error("--limit must be a number between 1 and 2000.");
  }

  return parsed;
}

function printHelp() {
  console.log(`Query persisted Cloudflare Workers Logs for this Worker.

Usage:
  node --env-file=.env scripts/query-worker-logs.mjs [options]

Options:
  --minutes <n>       Lookback window in minutes. Default: ${DEFAULT_MINUTES}
  --from <date>       Start timestamp, parseable by Date.parse.
  --to <date>         End timestamp, parseable by Date.parse. Default: now
  --limit <n>         Max events, 1-2000. Default: ${DEFAULT_LIMIT}
  --worker <name>     Worker script name. Default: ${DEFAULT_WORKER_NAME}
  --event <name>      Structured event filter, for example tdf-run-finished.
  --status <status>   Run status filter, for example failure.
  --trigger <text>    Run trigger substring, for example telegram:/offers.
  --search <text>     Full-text search across event fields.
  --json              Print full sanitized event objects.
`);
}
