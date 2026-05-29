import type { Env } from "../worker/types.js";

export const sampleOffers = [
  {
    productionSeasonId: 1,
    title: "Show One",
    facility: "Theatre",
    performances: [
      {
        performanceId: 10,
        performanceDate: "2026-05-26T19:00:00-04:00"
      }
    ]
  }
];

export class MemoryKV {
  readonly values = new Map<string, string>();
  readonly writes: string[] = [];
  readonly writeOptions = new Map<string, unknown>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string, options?: unknown): Promise<void> {
    this.writes.push(key);
    this.values.set(key, value);
    if (options) {
      this.writeOptions.set(key, options);
    }
  }

  async delete(key: string): Promise<void> {
    this.writes.push(key);
    this.values.delete(key);
  }
}

export function env(kv = new MemoryKV()): Env {
  return {
    TDF_ALERTS: kv as unknown as KVNamespace,
    TELEGRAM_BOT_TOKEN: "telegram-token",
    TELEGRAM_CHAT_ID: "123",
    COOKIE_FORM_TOKEN: "form-token",
    GITHUB_REFRESH_TOKEN: "github-token",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_REFRESH_REF: "main"
  };
}

export function envWithoutGithubRefresh(kv = new MemoryKV()): Env {
  return {
    TDF_ALERTS: kv as unknown as KVNamespace,
    TELEGRAM_BOT_TOKEN: "telegram-token",
    TELEGRAM_CHAT_ID: "123",
    COOKIE_FORM_TOKEN: "form-token"
  };
}

export function response(body: BodyInit | null, init: ResponseInit & { url?: string } = {}): Response {
  const result = new Response(body, init);
  Object.defineProperty(result, "url", {
    value: init.url ?? "https://example.test",
    configurable: true
  });
  return result;
}

export async function withFetch(
  fakeFetch: typeof fetch,
  testBody: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    await testBody();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function captureRuntimeEvents(action: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const capture = (value?: unknown) => {
    lines.push(String(value));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    await action();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

export function lastRunEvent(events: Array<Record<string, unknown>>): Record<string, unknown> {
  const event = events.filter((candidate) => candidate["event"] === "tdf-run-finished").at(-1);
  if (!event) {
    throw new Error("Expected a tdf-run-finished runtime event.");
  }
  return event;
}
