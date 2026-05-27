export class TdfError extends Error {
  readonly kind: "auth" | "transient" | "unexpected";

  constructor(message: string, kind: TdfError["kind"]) {
    super(message);
    this.name = "TdfError";
    this.kind = kind;
  }
}

export function classifyStatus(status: number): TdfError["kind"] {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 408 || status === 429 || status >= 500) {
    return "transient";
  }
  return "unexpected";
}

export function classifyError(error: unknown): TdfError["kind"] {
  if (error instanceof TdfError) {
    return error.kind;
  }
  if (error instanceof Error && /timeout|fetch failed/i.test(error.message)) {
    return "transient";
  }
  return "unexpected";
}

export function looksLikeAuthFailure(body: string): boolean {
  return /captcha|access denied|error 15|forbidden|unauthori[sz]ed|password|sign\s+in|log\s+in/i.test(body);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function json(value: unknown): Response {
  return new Response(JSON.stringify(value, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
}

export function isAuthorized(url: URL, token: string): boolean {
  return Boolean(token) && url.searchParams.get("token") === token;
}

export function sanitizeText(value: string): string {
  return value
    .replaceAll(/token=[^&\s]+/gi, "token=[redacted]")
    .replaceAll(/bot[0-9]+:[A-Za-z0-9_-]+/g, "bot[redacted]");
}

export function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "[redacted]" : sanitizeUnknown(item)
      ])
    );
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "cookie" ||
    normalized === "cookieheader" ||
    normalized === "authorization" ||
    normalized === "password" ||
    normalized === "secret" ||
    normalized === "token" ||
    normalized.endsWith("_token") ||
    normalized.endsWith("-token")
  );
}

export function getSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (setCookies.length > 0) {
    return setCookies;
  }

  const setCookie = response.headers.get("set-cookie");
  return setCookie ? [setCookie] : [];
}
