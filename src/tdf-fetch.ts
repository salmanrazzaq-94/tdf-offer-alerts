import { parseTdfOffers, TDF_OFFERS_URL, TDF_PERFORMANCES_URL, type TdfOffer } from "./tdf.js";

export type TdfFetchErrorKind = "auth" | "transient" | "unexpected";

export class TdfFetchError extends Error {
  readonly kind: TdfFetchErrorKind;
  readonly status?: number;

  constructor(message: string, kind: TdfFetchErrorKind, status?: number) {
    super(message);
    this.name = "TdfFetchError";
    this.kind = kind;
    this.status = status;
  }
}

export async function fetchTdfOffersWithCookie(cookie: string): Promise<TdfOffer[]> {
  let lastError: unknown;
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchTdfOffersOnce(cookie);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isRetryableTdfError(error)) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

async function fetchTdfOffersOnce(cookie: string): Promise<TdfOffer[]> {
  await verifyAuthenticatedOffersPage(cookie);

  const response = await fetch(TDF_PERFORMANCES_URL, {
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      Cookie: cookie,
      Referer: TDF_OFFERS_URL,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
      "X-Requested-With": "XMLHttpRequest"
    },
    signal: AbortSignal.timeout(60_000)
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  if (!response.ok) {
    throw new TdfFetchError(
      `TDF performances endpoint returned ${response.status}: ${body.slice(0, 300)}`,
      classifyStatus(response.status),
      response.status
    );
  }

  if (!contentType.includes("application/json")) {
    throw new TdfFetchError(
      `TDF performances endpoint returned non-JSON content (${contentType}): ${body.slice(0, 300)}`,
      looksLikeAuthFailure(body) ? "auth" : "unexpected"
    );
  }

  const parsed = JSON.parse(body) as unknown;
  return parseTdfOffers(parsed);
}

async function verifyAuthenticatedOffersPage(cookie: string): Promise<void> {
  const response = await fetch(TDF_OFFERS_URL, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"
    },
    signal: AbortSignal.timeout(60_000)
  });
  const body = await response.text();

  if (response.url.includes("/account/login") || response.url.includes("my.tdf.org/account")) {
    throw new TdfFetchError(
      `TDF redirected to login page: ${response.url}`,
      "auth",
      response.status
    );
  }

  if (!response.ok) {
    throw new TdfFetchError(
      `TDF offers page returned ${response.status}: ${body.slice(0, 300)}`,
      classifyStatus(response.status),
      response.status
    );
  }

  if (looksLikeAuthFailure(body)) {
    throw new TdfFetchError("TDF offers page showed a login or access challenge.", "auth");
  }
}

function isRetryableTdfError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error instanceof TdfFetchError) {
    return error.kind === "transient";
  }

  return /timeout|fetch failed/i.test(error.message);
}

function retryDelayMs(attempt: number): number {
  return Math.min(30_000, attempt * attempt * 2_000);
}

function classifyStatus(status: number): TdfFetchErrorKind {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 408 || status === 429 || status >= 500) {
    return "transient";
  }
  return "unexpected";
}

function looksLikeAuthFailure(body: string): boolean {
  return /login|captcha|access denied|error 15|forbidden|unauthori[sz]ed/i.test(body);
}
