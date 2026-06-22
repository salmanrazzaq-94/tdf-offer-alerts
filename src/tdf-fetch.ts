import {
  parseTdfOffers,
  TDF_APEX_EXECUTE_URL,
  TDF_API_BASE_URL,
  TDF_CSRF_TOKEN_MODULE_URL,
  TDF_MEMBER_HOME_URL,
  TDF_OFFERS_URL,
  TDF_PERFORMANCES_CATEGORY_ID,
  TDF_PRODUCT_FIELDS,
  TDF_SESSION_CONTEXT_URL,
  TDF_TICKET_BOOKING_CLASS_NAME,
  type TdfOffer
} from "./tdf.js";
import type { OperationLogger } from "./observability.js";

type TdfFetchErrorKind = "auth" | "transient" | "unexpected";
type StorefrontPerformance = Record<string, unknown>;

class TdfFetchError extends Error {
  readonly kind: TdfFetchErrorKind;
  readonly status: number | undefined;

  constructor(message: string, kind: TdfFetchErrorKind, status?: number) {
    super(message);
    this.name = "TdfFetchError";
    this.kind = kind;
    this.status = status;
  }
}

export async function fetchTdfOffersWithCookie(
  cookie: string,
  logger?: OperationLogger
): Promise<TdfOffer[]> {
  let lastError: unknown;
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      logger?.info("tdf-fetch-attempt:start", { attempt, maxAttempts });
      const offers = await fetchTdfOffersOnce(cookie, logger, attempt);
      logger?.info("tdf-fetch-attempt:success", {
        attempt,
        shows: offers.length,
        performances: offers.reduce((total, offer) => total + offer.performances.length, 0)
      });
      return offers;
    } catch (error) {
      lastError = error;
      logger?.warn("tdf-fetch-attempt:failure", {
        attempt,
        maxAttempts,
        retryable: attempt < maxAttempts && isRetryableTdfError(error),
        kind: error instanceof TdfFetchError ? error.kind : "unknown",
        status: error instanceof TdfFetchError ? error.status : undefined,
        message: error instanceof Error ? error.message : String(error)
      });
      if (attempt < maxAttempts && isRetryableTdfError(error)) {
        const waitMs = retryDelayMs(attempt);
        logger?.info("tdf-fetch-retry-wait:start", { attempt, waitMs });
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

async function fetchTdfOffersOnce(
  cookie: string,
  logger: OperationLogger | undefined,
  attempt: number
): Promise<TdfOffer[]> {
  await verifyAuthenticatedSession(cookie, logger, attempt);
  await verifyAuthenticatedOffersPage(cookie, logger, attempt);

  const productIds = await fetchPerformanceProductIds(cookie, logger, attempt);
  const selectablePerformances = await fetchSelectablePerformances(cookie, productIds, logger, attempt);
  return fetchProductDetails(cookie, [...selectablePerformances.keys()], selectablePerformances, logger, attempt);
}

async function verifyAuthenticatedSession(
  cookie: string,
  logger: OperationLogger | undefined,
  attempt: number
): Promise<void> {
  const started = Date.now();
  const response = await fetch(TDF_SESSION_CONTEXT_URL, {
    headers: jsonHeaders(cookie, TDF_MEMBER_HOME_URL),
    signal: AbortSignal.timeout(60_000)
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  logger?.info("tdf-session-context-response", {
    attempt,
    status: response.status,
    finalUrl: response.url,
    contentType,
    bodyBytes: body.length,
    durationMs: Date.now() - started
  });

  if (!response.ok) {
    throw new TdfFetchError(
      `TDF session context returned ${response.status}: ${body.slice(0, 300)}`,
      classifyStatus(response.status),
      response.status
    );
  }

  if (!contentType.includes("application/json")) {
    throw new TdfFetchError(
      `TDF session context returned non-JSON content (${contentType}): ${body.slice(0, 300)}`,
      looksLikeAuthFailure(body) ? "auth" : "unexpected"
    );
  }

  const parsed = JSON.parse(body) as unknown;
  const guestUser = isRecord(parsed) ? parsed["guestUser"] : undefined;
  if (guestUser !== false) {
    throw new TdfFetchError("TDF session context is still a guest session.", "auth", response.status);
  }
}

async function verifyAuthenticatedOffersPage(
  cookie: string,
  logger: OperationLogger | undefined,
  attempt: number
): Promise<void> {
  const started = Date.now();
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
  logger?.info("tdf-offers-page-response", {
    attempt,
    status: response.status,
    finalUrl: response.url,
    bodyBytes: body.length,
    durationMs: Date.now() - started
  });

  if (
    response.url.includes("/account/login") ||
    response.url.includes("/store/login") ||
    response.url.includes("members.tdf.org/account")
  ) {
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

  const authenticated = /logged\s+in\s+as|log\s*out|current offers|my offers|my tickets|my account|\borders\b/i.test(body);
  if (looksLikeAuthFailure(body) && !authenticated) {
    throw new TdfFetchError("TDF offers page showed a login or access challenge.", "auth");
  }
}

async function fetchPerformanceProductIds(
  cookie: string,
  logger: OperationLogger | undefined,
  attempt: number
): Promise<string[]> {
  const productIds: string[] = [];
  const seen = new Set<string>();
  let page = 0;
  let total = Number.POSITIVE_INFINITY;

  while (productIds.length < total) {
    const started = Date.now();
    const response = await fetch(productSearchUrl(page), {
      headers: jsonHeaders(cookie, TDF_OFFERS_URL),
      signal: AbortSignal.timeout(60_000)
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    logger?.info("tdf-product-search-response", {
      attempt,
      page,
      status: response.status,
      contentType,
      bodyBytes: body.length,
      durationMs: Date.now() - started
    });

    if (!response.ok) {
      throw new TdfFetchError(
        `TDF product search returned ${response.status}: ${body.slice(0, 300)}`,
        classifyStatus(response.status),
        response.status
      );
    }
    if (!contentType.includes("application/json")) {
      throw new TdfFetchError(
        `TDF product search returned non-JSON content (${contentType}): ${body.slice(0, 300)}`,
        looksLikeAuthFailure(body) ? "auth" : "unexpected"
      );
    }

    const parsed = JSON.parse(body) as unknown;
    const pageProducts = productsFromSearchPayload(parsed);
    const pageTotal = totalFromSearchPayload(parsed);
    for (const product of pageProducts) {
      const id = stringValue(product["id"]);
      if (id && !seen.has(id)) {
        seen.add(id);
        productIds.push(id);
      }
    }
    total = pageTotal ?? productIds.length;
    if (pageProducts.length === 0) {
      break;
    }
    page += 1;
  }

  return productIds;
}

async function fetchSelectablePerformances(
  cookie: string,
  productIds: string[],
  logger: OperationLogger | undefined,
  attempt: number
): Promise<Map<string, StorefrontPerformance[]>> {
  if (productIds.length === 0) {
    return new Map();
  }

  const csrfToken = await fetchCsrfToken(cookie, logger, attempt);
  const selectablePerformances = new Map<string, StorefrontPerformance[]>();
  const chunkSize = 10;
  for (let index = 0; index < productIds.length; index += chunkSize) {
    const chunk = productIds.slice(index, index + chunkSize);
    const started = Date.now();
    const results = await Promise.all(chunk.map((productId) => fetchProductPerformances(cookie, csrfToken, productId)));
    for (const result of results) {
      if (result.performances.length > 0) {
        selectablePerformances.set(result.productId, result.performances);
      }
    }
    logger?.info("tdf-product-performances-response", {
      attempt,
      chunk: index / chunkSize,
      requestedProducts: chunk.length,
      selectableProducts: results.filter((result) => result.performances.length > 0).length,
      selectablePerformances: results.reduce((total, result) => total + result.performances.length, 0),
      productsSoFar: selectablePerformances.size,
      performancesSoFar: countSelectablePerformances(selectablePerformances),
      durationMs: Date.now() - started
    });
  }

  return selectablePerformances;
}

async function fetchCsrfToken(
  cookie: string,
  logger: OperationLogger | undefined,
  attempt: number
): Promise<string> {
  const started = Date.now();
  const response = await fetch(TDF_CSRF_TOKEN_MODULE_URL, {
    headers: {
      ...jsonHeaders(cookie, TDF_OFFERS_URL),
      Accept: "application/javascript, text/javascript, */*"
    },
    signal: AbortSignal.timeout(60_000)
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  logger?.info("tdf-csrf-token-response", {
    attempt,
    status: response.status,
    contentType,
    bodyBytes: body.length,
    durationMs: Date.now() - started
  });

  if (!response.ok) {
    throw new TdfFetchError(
      `TDF CSRF token module returned ${response.status}: ${body.slice(0, 300)}`,
      classifyStatus(response.status),
      response.status
    );
  }

  const token = csrfTokenFromModule(body);
  if (!token) {
    throw new TdfFetchError("TDF CSRF token module did not contain a token.", "unexpected", response.status);
  }

  return token;
}

async function fetchProductPerformances(
  cookie: string,
  csrfToken: string,
  productId: string
): Promise<{ productId: string; performances: StorefrontPerformance[] }> {
  const response = await fetch(TDF_APEX_EXECUTE_URL, {
    method: "POST",
    headers: {
      ...jsonHeaders(cookie, TDF_OFFERS_URL),
      "Content-Type": "application/json; charset=utf-8",
      "csrf-token": csrfToken
    },
    body: JSON.stringify({
      namespace: "",
      classname: TDF_TICKET_BOOKING_CLASS_NAME,
      method: "getPerformances",
      isContinuation: false,
      params: { productId },
      cacheable: false
    }),
    signal: AbortSignal.timeout(60_000)
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  if (!response.ok) {
    throw new TdfFetchError(
      `TDF product performances returned ${response.status}: ${body.slice(0, 300)}`,
      classifyStatus(response.status),
      response.status
    );
  }
  if (!contentType.includes("application/json")) {
    throw new TdfFetchError(
      `TDF product performances returned non-JSON content (${contentType}): ${body.slice(0, 300)}`,
      looksLikeAuthFailure(body) ? "auth" : "unexpected"
    );
  }

  const parsed = JSON.parse(body) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed["returnValue"])) {
    throw new TdfFetchError("TDF product performances had an invalid response shape.", "unexpected", response.status);
  }

  return { productId, performances: parsed["returnValue"].filter(isRecord) };
}

async function fetchProductDetails(
  cookie: string,
  productIds: string[],
  selectablePerformances: Map<string, StorefrontPerformance[]>,
  logger: OperationLogger | undefined,
  attempt: number
): Promise<TdfOffer[]> {
  if (productIds.length === 0) {
    return [];
  }

  const offers: TdfOffer[] = [];
  const chunkSize = 20;
  for (let index = 0; index < productIds.length; index += chunkSize) {
    const chunk = productIds.slice(index, index + chunkSize);
    const started = Date.now();
    const response = await fetch(productDetailsUrl(chunk), {
      headers: jsonHeaders(cookie, TDF_OFFERS_URL),
      signal: AbortSignal.timeout(60_000)
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    logger?.info("tdf-product-details-response", {
      attempt,
      chunk: index / chunkSize,
      requestedProducts: chunk.length,
      status: response.status,
      contentType,
      bodyBytes: body.length,
      durationMs: Date.now() - started
    });

    if (!response.ok) {
      throw new TdfFetchError(
        `TDF product details returned ${response.status}: ${body.slice(0, 300)}`,
        classifyStatus(response.status),
        response.status
      );
    }
    if (!contentType.includes("application/json")) {
      throw new TdfFetchError(
        `TDF product details returned non-JSON content (${contentType}): ${body.slice(0, 300)}`,
        looksLikeAuthFailure(body) ? "auth" : "unexpected"
      );
    }

    const parsed = JSON.parse(body) as unknown;
    offers.push(...parseTdfOffers(expandStorefrontProductsWithPerformances(parsed, selectablePerformances)));
  }

  return mergeStorefrontOffers(offers);
}

function expandStorefrontProductsWithPerformances(
  input: unknown,
  selectablePerformances: Map<string, StorefrontPerformance[]>
): unknown {
  if (!isRecord(input) || !Array.isArray(input["products"])) {
    return input;
  }

  return {
    ...input,
    products: input["products"].filter(isRecord).flatMap((product) => {
      const productId = stringValue(product["id"]);
      const performances = productId ? selectablePerformances.get(productId) : undefined;
      if (!performances || performances.length === 0) {
        return [product];
      }
      return performances.map((performance, index) =>
        storefrontProductWithPerformance(product, performance, index)
      );
    })
  };
}

function storefrontProductWithPerformance(
  product: Record<string, unknown>,
  performance: StorefrontPerformance,
  index: number
): Record<string, unknown> {
  const fields = isRecord(product["fields"]) ? product["fields"] : {};
  const productId = stringValue(product["id"]);
  const performanceId = fieldString(performance, ["Id", "id", "PerformanceId__c", "Performance_Id__c"]);
  const performanceDate = fieldString(performance, [
    "Performance_Date__c",
    "PerformanceDate__c",
    "Start_Date__c",
    "StartDate__c",
    "Event_Date__c"
  ]);
  const productionSeasonId = fieldString(performance, ["Production__c", "ProductionSeasonId__c", "Production_Season_Id__c"]);
  const title = fieldString(performance, ["Name", "name"]);

  return {
    ...product,
    id: performanceId ?? (productId ? `${productId}:${index}` : product["id"]),
    fields: {
      ...fields,
      ...(title ? { Name: title } : {}),
      ...(productionSeasonId ? { ProductionSeasonId__c: productionSeasonId } : {}),
      ...(performanceId ? { PerformanceId__c: performanceId } : {}),
      ...(performanceDate ? { Performance_Date__c: performanceDate } : {})
    }
  };
}

function mergeStorefrontOffers(offers: TdfOffer[]): TdfOffer[] {
  const grouped = new Map<string, TdfOffer>();
  for (const offer of offers) {
    const key = [
      normalizedKeyPart(String(offer.productionSeasonId)),
      normalizedKeyPart(offer.title),
      normalizedKeyPart(offer.facility)
    ].join(":");
    const existing = grouped.get(key);
    if (existing) {
      existing.performances.push(...offer.performances);
      if (!existing.thumbnail && offer.thumbnail) {
        existing.thumbnail = offer.thumbnail;
      }
      continue;
    }
    grouped.set(key, { ...offer, performances: [...offer.performances] });
  }
  return Array.from(grouped.values());
}

function normalizedKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function countSelectablePerformances(selectablePerformances: Map<string, StorefrontPerformance[]>): number {
  let total = 0;
  for (const performances of selectablePerformances.values()) {
    total += performances.length;
  }
  return total;
}

function productSearchUrl(page: number): string {
  const params = new URLSearchParams({
    categoryId: TDF_PERFORMANCES_CATEGORY_ID,
    page: String(page),
    pageSize: "200",
    fields: "Name",
    includeQuantityRule: "false",
    skipDecoration: "true",
    language: "en-US",
    asGuest: "false",
    htmlEncode: "false"
  });
  return `${TDF_API_BASE_URL}/search/products?${params.toString()}`;
}

function productDetailsUrl(productIds: string[]): string {
  const params = new URLSearchParams({
    ids: productIds.join(","),
    fields: TDF_PRODUCT_FIELDS,
    language: "en-US",
    asGuest: "false",
    htmlEncode: "false"
  });
  return `${TDF_API_BASE_URL}/products?${params.toString()}`;
}

function jsonHeaders(cookie: string, referer: string): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: cookie,
    Referer: referer,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"
  };
}

function csrfTokenFromModule(body: string): string | undefined {
  const match = body.match(/@app\/csrfToken["'][\s\S]*?return\s+"([^"]+)"/);
  const token = match?.[1];
  if (!token) {
    return undefined;
  }
  try {
    return JSON.parse(`"${token}"`) as string;
  } catch {
    return token.replace(/\\u003d/g, "=");
  }
}

function productsFromSearchPayload(input: unknown): Array<Record<string, unknown>> {
  if (!isRecord(input) || !isRecord(input["productsPage"]) || !Array.isArray(input["productsPage"]["products"])) {
    return [];
  }
  return input["productsPage"]["products"].filter(isRecord);
}

function totalFromSearchPayload(input: unknown): number | undefined {
  if (!isRecord(input) || !isRecord(input["productsPage"])) {
    return undefined;
  }
  const total = input["productsPage"]["total"];
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

function fieldString(fields: Record<string, unknown>, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const value = stringValue(fields[candidate]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
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
  if (/log\s*out|logged\s+in\s+as/i.test(body)) {
    return false;
  }

  return /captcha|access denied|error 15|forbidden|unauthori[sz]ed|password|sign\s+in|log\s+in/i.test(
    body
  );
}
