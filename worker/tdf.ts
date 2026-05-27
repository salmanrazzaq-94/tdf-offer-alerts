import { tdfMemberHomeUrl, tdfOffersUrl, tdfPerformancesUrl } from "./constants.js";
import { addStep } from "./logging.js";
import type { AlertItem, RunLog, TdfFetchResult, TdfOffer } from "./types.js";
import { classifyStatus, getSetCookieHeaders, isRecord, looksLikeAuthFailure, TdfError } from "./utils.js";

export async function fetchTdfOffers(cookie: string, run: RunLog): Promise<TdfFetchResult> {
  let activeCookie = await refreshTdfMemberSession(cookie, run);
  activeCookie = await touchTdfMainPage(activeCookie, run);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(tdfPerformancesUrl, {
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/json",
          Cookie: activeCookie,
          Referer: tdfOffersUrl,
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
          "X-Requested-With": "XMLHttpRequest"
        }
      });
      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();
      const details = {
        attempt,
        status: response.status,
        contentType,
        bodyBytes: body.length,
        durationMs: Date.now() - started
      };

      if (!response.ok) {
        addStep(run, "fetch-tdf-performances", "failure", details);
        throw new TdfError(`TDF returned ${response.status}: ${body.slice(0, 200)}`, classifyStatus(response.status));
      }
      if (!contentType.includes("application/json")) {
        addStep(run, "fetch-tdf-performances", "failure", {
          ...details,
          bodyPreview: body.slice(0, 200)
        });
        throw new TdfError(
          `TDF returned non-JSON content (${contentType}): ${body.slice(0, 200)}`,
          looksLikeAuthFailure(body) ? "auth" : "unexpected"
        );
      }

      const parsed = JSON.parse(body) as unknown;
      const offers = parseOffers(parsed);
      addStep(run, "fetch-tdf-performances", "success", {
        ...details,
        shows: offers.length,
        performances: countPerformances(offers)
      });
      return { offers, cookie: activeCookie };
    } catch (error) {
      lastError = error;
      if (attempt < 3 && classifyTdfFetchError(error) === "transient") {
        addStep(run, "fetch-tdf-retry-wait", "success", { attempt, waitMs: attempt * 1000 });
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

async function refreshTdfMemberSession(cookie: string, run: RunLog): Promise<string> {
  const started = Date.now();
  const response = await fetch(tdfMemberHomeUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"
    }
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  const setCookies = getSetCookieHeaders(response);
  const setCookieNames = setCookies.map((value) => value.split("=", 1)[0]).filter(Boolean);
  const details = {
    status: response.status,
    finalUrl: response.url,
    contentType,
    bodyBytes: body.length,
    durationMs: Date.now() - started,
    setCookieCount: setCookies.length,
    setCookieNames
  };

  if (response.url.includes("/account/login")) {
    addStep(run, "refresh-tdf-member-session", "failure", details);
    throw new TdfError(`TDF member page redirected to login: ${response.url}`, "auth");
  }

  if (!response.ok) {
    addStep(run, "refresh-tdf-member-session", "failure", details);
    return cookie;
  }

  addStep(run, "refresh-tdf-member-session", "success", details);
  return mergeSetCookies(cookie, setCookies);
}

async function touchTdfMainPage(cookie: string, run: RunLog): Promise<string> {
  const started = Date.now();
  const response = await fetch(tdfOffersUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"
    }
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  const setCookies = getSetCookieHeaders(response);
  const setCookieNames = setCookies.map((value) => value.split("=", 1)[0]).filter(Boolean);
  const authenticated = /logged\s+in\s+as|log\s*out|current offers/i.test(body);
  const details = {
    status: response.status,
    finalUrl: response.url,
    contentType,
    bodyBytes: body.length,
    durationMs: Date.now() - started,
    authenticatedSignals: authenticated,
    setCookieCount: setCookies.length,
    setCookieNames
  };

  if (response.url.includes("/account/login") || response.url.includes("my.tdf.org/account")) {
    addStep(run, "touch-tdf-main-page", "failure", details);
    throw new TdfError(`TDF main page redirected to login: ${response.url}`, "auth");
  }
  if (!response.ok) {
    addStep(run, "touch-tdf-main-page", "failure", details);
    throw new TdfError(`TDF main page returned ${response.status}: ${body.slice(0, 200)}`, classifyStatus(response.status));
  }
  if (looksLikeAuthFailure(body) && !authenticated) {
    addStep(run, "touch-tdf-main-page", "failure", {
      ...details,
      bodyPreview: body.slice(0, 200)
    });
    throw new TdfError("TDF main page showed a login or access challenge.", "auth");
  }

  addStep(run, "touch-tdf-main-page", "success", details);
  return mergeSetCookies(cookie, setCookies);
}

export function parseOffers(input: unknown): TdfOffer[] {
  if (!Array.isArray(input)) {
    throw new TdfError("TDF response was not a JSON array.", "unexpected");
  }
  return input.map((item) => {
    if (!isRecord(item) || !Array.isArray(item["performances"])) {
      throw new TdfError("TDF response had an invalid offer shape.", "unexpected");
    }
    const offer: TdfOffer = {
      productionSeasonId: Number(item["productionSeasonId"]),
      title: String(item["title"]),
      facility: String(item["facility"]),
      performances: item["performances"].map((performance) => {
        if (!isRecord(performance)) {
          throw new TdfError("TDF response had an invalid performance shape.", "unexpected");
        }
        return {
          performanceId: Number(performance["performanceId"]),
          performanceDate: String(performance["performanceDate"])
        };
      })
    };
    if (typeof item["thumbnail"] === "string") {
      offer.thumbnail = item["thumbnail"];
    }
    return offer;
  });
}

export function flattenOffers(offers: TdfOffer[]): AlertItem[] {
  return offers.flatMap((offer) =>
    offer.performances.map((performance) => ({
      id: `${offer.productionSeasonId}:${performance.performanceId}`,
      title: offer.title,
      facility: offer.facility,
      performanceDate: performance.performanceDate
    }))
  );
}

export function countPerformances(offers: TdfOffer[]): number {
  return offers.reduce((total, offer) => total + offer.performances.length, 0);
}

export function mergeSetCookies(cookie: string, setCookies: string[]): string {
  if (setCookies.length === 0) {
    return cookie;
  }

  const values = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex > 0) {
      values.set(trimmed.slice(0, separatorIndex), trimmed.slice(separatorIndex + 1));
    }
  }

  for (const setCookie of setCookies) {
    const [nameValue] = setCookie.split(";");
    if (!nameValue) {
      continue;
    }
    const separatorIndex = nameValue.indexOf("=");
    if (separatorIndex > 0) {
      values.set(nameValue.slice(0, separatorIndex).trim(), nameValue.slice(separatorIndex + 1));
    }
  }

  return [...values.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function classifyTdfFetchError(error: unknown): "auth" | "transient" | "unexpected" {
  if (error instanceof TdfError) {
    return error.kind;
  }
  if (error instanceof Error && /timeout|fetch failed/i.test(error.message)) {
    return "transient";
  }
  return "unexpected";
}
