import { parseTdfOffers, TDF_OFFERS_URL, TDF_PERFORMANCES_URL, type TdfOffer } from "./tdf.js";

export async function fetchTdfOffersWithCookie(cookie: string): Promise<TdfOffer[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchTdfOffersOnce(cookie);
    } catch (error) {
      lastError = error;
      if (attempt < 3 && isRetryableTdfError(error)) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

async function fetchTdfOffersOnce(cookie: string): Promise<TdfOffer[]> {
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
    throw new Error(`TDF performances endpoint returned ${response.status}: ${body.slice(0, 300)}`);
  }

  if (!contentType.includes("application/json")) {
    throw new Error(
      `TDF performances endpoint returned non-JSON content (${contentType}): ${body.slice(0, 300)}`
    );
  }

  const parsed = JSON.parse(body) as unknown;
  return parseTdfOffers(parsed);
}

function isRetryableTdfError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /returned 5\d\d/.test(error.message) || /timeout|fetch failed/i.test(error.message);
}
