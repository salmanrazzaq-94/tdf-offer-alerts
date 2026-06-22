import {
  tdfApexExecuteUrl,
  tdfApiBaseUrl,
  tdfCsrfTokenModuleUrl,
  tdfMemberHomeUrl,
  tdfOffersUrl,
  tdfPerformancesCategoryId,
  tdfProductionAvailabilityClassName,
  tdfProductFields,
  tdfSessionContextUrl,
  tdfTicketVariationsCategoryId,
  tdfTicketBookingClassName
} from "./constants.js";
import { addStep } from "./logging.js";
import type { AlertItem, RunLog, TdfFetchResult, TdfOffer } from "./types.js";
import { classifyStatus, getSetCookieHeaders, isRecord, looksLikeAuthFailure, TdfError } from "./utils.js";

type StorefrontPerformance = Record<string, unknown>;

export async function fetchTdfOffers(cookie: string, run: RunLog): Promise<TdfFetchResult> {
  let activeCookie = await refreshTdfMemberSession(cookie, run);
  activeCookie = await verifyMemberSession(activeCookie, run);
  activeCookie = await touchTdfMainPageWithRetry(activeCookie, run);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const started = Date.now();
    try {
      const productIds = await fetchPerformanceProductIds(activeCookie, run, attempt);
      const csrfToken = await fetchCsrfToken(activeCookie, run, attempt);
      const availableProductIds = await fetchAvailableProductIds(activeCookie, csrfToken, productIds, run, attempt);
      const selectablePerformances = await fetchSelectablePerformances(activeCookie, csrfToken, availableProductIds, run, attempt);
      const priceLabels = await fetchTicketPriceLabels(activeCookie, selectablePerformances, run, attempt);
      const offers = await fetchProductDetails(activeCookie, [...selectablePerformances.keys()], selectablePerformances, run, attempt);
      applyPriceLabels(offers, priceLabels);
      const details = {
        attempt,
        products: productIds.length,
        availableProducts: availableProductIds.length,
        selectableProducts: selectablePerformances.size,
        selectablePerformances: countSelectablePerformances(selectablePerformances),
        durationMs: Date.now() - started
      };
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

async function touchTdfMainPageWithRetry(cookie: string, run: RunLog): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await touchTdfMainPage(cookie, run);
    } catch (error) {
      lastError = error;
      if (attempt < 3 && classifyTdfFetchError(error) === "transient") {
        addStep(run, "touch-tdf-main-page-retry-wait", "success", { attempt, waitMs: attempt * 1000 });
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

  if (isLoginRedirect(response.url)) {
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

async function verifyMemberSession(cookie: string, run: RunLog): Promise<string> {
  const started = Date.now();
  const response = await fetch(tdfSessionContextUrl, {
    headers: jsonHeaders(cookie, tdfMemberHomeUrl)
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

  if (!response.ok) {
    addStep(run, "tdf-session-context", "failure", details);
    throw new TdfError(`TDF session context returned ${response.status}: ${body.slice(0, 200)}`, classifyStatus(response.status));
  }
  if (!contentType.includes("application/json")) {
    addStep(run, "tdf-session-context", "failure", {
      ...details,
      bodyPreview: body.slice(0, 200)
    });
    throw new TdfError(
      `TDF session context returned non-JSON content (${contentType}): ${body.slice(0, 200)}`,
      looksLikeAuthFailure(body) ? "auth" : "unexpected"
    );
  }

  const parsed = JSON.parse(body) as unknown;
  const guestUser = isRecord(parsed) ? parsed["guestUser"] : undefined;
  if (guestUser !== false) {
    addStep(run, "tdf-session-context", "failure", {
      ...details,
      guestUser
    });
    throw new TdfError("TDF session context is still a guest session.", "auth");
  }

  addStep(run, "tdf-session-context", "success", {
    ...details,
    guestUser
  });
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
  const authenticated = /logged\s+in\s+as|log\s*out|current offers|my offers|my tickets|my account|\borders\b/i.test(body);
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

  if (isLoginRedirect(response.url)) {
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
  const storefrontProducts = productsFromStorefrontPayload(input);
  if (storefrontProducts) {
    return offersFromStorefrontProducts(storefrontProducts);
  }

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
    if (typeof item["priceLabel"] === "string") {
      offer.priceLabel = item["priceLabel"];
    }
    return offer;
  });
}

async function fetchPerformanceProductIds(cookie: string, run: RunLog, attempt: number): Promise<string[]> {
  const productIds: string[] = [];
  const seen = new Set<string>();
  let page = 0;
  let total = Number.POSITIVE_INFINITY;

  while (productIds.length < total) {
    const started = Date.now();
    const url = productSearchUrl(page);
    const response = await fetch(url, {
      headers: jsonHeaders(cookie, tdfOffersUrl)
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const details = {
      attempt,
      page,
      status: response.status,
      contentType,
      bodyBytes: body.length,
      durationMs: Date.now() - started
    };

    if (!response.ok) {
      addStep(run, "fetch-tdf-product-search", "failure", details);
      throw new TdfError(`TDF product search returned ${response.status}: ${body.slice(0, 200)}`, classifyStatus(response.status));
    }
    if (!contentType.includes("application/json")) {
      addStep(run, "fetch-tdf-product-search", "failure", {
        ...details,
        bodyPreview: body.slice(0, 200)
      });
      throw new TdfError(
        `TDF product search returned non-JSON content (${contentType}): ${body.slice(0, 200)}`,
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
    addStep(run, "fetch-tdf-product-search", "success", {
      ...details,
      pageProducts: pageProducts.length,
      productsSoFar: productIds.length,
      total
    });
    if (pageProducts.length === 0) {
      break;
    }
    page += 1;
  }

  return productIds;
}

async function fetchSelectablePerformances(
  cookie: string,
  csrfToken: string,
  productIds: string[],
  run: RunLog,
  attempt: number
): Promise<Map<string, StorefrontPerformance[]>> {
  if (productIds.length === 0) {
    return new Map();
  }

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
    addStep(run, "fetch-tdf-product-performances", "success", {
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

async function fetchAvailableProductIds(
  cookie: string,
  csrfToken: string,
  productIds: string[],
  run: RunLog,
  attempt: number
): Promise<string[]> {
  if (productIds.length === 0) {
    return [];
  }

  const started = Date.now();
  const response = await fetch(tdfApexExecuteUrl, {
    method: "POST",
    headers: {
      ...jsonHeaders(cookie, tdfOffersUrl),
      "Content-Type": "application/json; charset=utf-8",
      "csrf-token": csrfToken
    },
    body: JSON.stringify({
      namespace: "",
      classname: tdfProductionAvailabilityClassName,
      method: "getProductionsWithAvailability",
      isContinuation: false,
      params: { productionIds: productIds },
      cacheable: false
    })
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  const details = {
    attempt,
    requestedProducts: productIds.length,
    status: response.status,
    contentType,
    bodyBytes: body.length,
    durationMs: Date.now() - started
  };

  if (!response.ok) {
    addStep(run, "fetch-tdf-production-availability", "failure", details);
    throw new TdfError(`TDF production availability returned ${response.status}: ${body.slice(0, 200)}`, classifyStatus(response.status));
  }
  if (!contentType.includes("application/json")) {
    addStep(run, "fetch-tdf-production-availability", "failure", {
      ...details,
      bodyPreview: body.slice(0, 200)
    });
    throw new TdfError(
      `TDF production availability returned non-JSON content (${contentType}): ${body.slice(0, 200)}`,
      looksLikeAuthFailure(body) ? "auth" : "unexpected"
    );
  }

  const parsed = JSON.parse(body) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed["returnValue"])) {
    addStep(run, "fetch-tdf-production-availability", "failure", {
      ...details,
      bodyPreview: body.slice(0, 200)
    });
    throw new TdfError("TDF production availability had an invalid response shape.", "unexpected");
  }

  const available = new Set(parsed["returnValue"].filter((value): value is string => typeof value === "string"));
  const availableProductIds = productIds.filter((productId) => available.has(productId));
  addStep(run, "fetch-tdf-production-availability", "success", {
    ...details,
    availableProducts: availableProductIds.length
  });
  return availableProductIds;
}

async function fetchCsrfToken(cookie: string, run: RunLog, attempt: number): Promise<string> {
  const started = Date.now();
  const response = await fetch(tdfCsrfTokenModuleUrl, {
    headers: {
      ...jsonHeaders(cookie, tdfOffersUrl),
      Accept: "application/javascript, text/javascript, */*"
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
    addStep(run, "fetch-tdf-csrf-token", "failure", details);
    throw new TdfError(`TDF CSRF token module returned ${response.status}: ${body.slice(0, 200)}`, classifyStatus(response.status));
  }

  const token = csrfTokenFromModule(body);
  if (!token) {
    addStep(run, "fetch-tdf-csrf-token", "failure", {
      ...details,
      bodyPreview: body.slice(0, 200)
    });
    throw new TdfError("TDF CSRF token module did not contain a token.", "unexpected");
  }

  addStep(run, "fetch-tdf-csrf-token", "success", details);
  return token;
}

async function fetchProductPerformances(
  cookie: string,
  csrfToken: string,
  productId: string
): Promise<{ productId: string; performances: StorefrontPerformance[] }> {
  const response = await fetch(tdfApexExecuteUrl, {
    method: "POST",
    headers: {
      ...jsonHeaders(cookie, tdfOffersUrl),
      "Content-Type": "application/json; charset=utf-8",
      "csrf-token": csrfToken
    },
    body: JSON.stringify({
      namespace: "",
      classname: tdfTicketBookingClassName,
      method: "getPerformances",
      isContinuation: false,
      params: { productId },
      cacheable: false
    })
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  if (!response.ok) {
    throw new TdfError(`TDF product performances returned ${response.status}: ${body.slice(0, 200)}`, classifyStatus(response.status));
  }
  if (!contentType.includes("application/json")) {
    throw new TdfError(
      `TDF product performances returned non-JSON content (${contentType}): ${body.slice(0, 200)}`,
      looksLikeAuthFailure(body) ? "auth" : "unexpected"
    );
  }

  const parsed = JSON.parse(body) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed["returnValue"])) {
    throw new TdfError("TDF product performances had an invalid response shape.", "unexpected");
  }

  return { productId, performances: parsed["returnValue"].filter(isRecord) };
}

async function fetchProductDetails(
  cookie: string,
  productIds: string[],
  selectablePerformances: Map<string, StorefrontPerformance[]>,
  run: RunLog,
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
      headers: jsonHeaders(cookie, tdfOffersUrl)
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const details = {
      attempt,
      chunk: index / chunkSize,
      requestedProducts: chunk.length,
      status: response.status,
      contentType,
      bodyBytes: body.length,
      durationMs: Date.now() - started
    };

    if (!response.ok) {
      addStep(run, "fetch-tdf-product-details", "failure", details);
      throw new TdfError(`TDF product details returned ${response.status}: ${body.slice(0, 200)}`, classifyStatus(response.status));
    }
    if (!contentType.includes("application/json")) {
      addStep(run, "fetch-tdf-product-details", "failure", {
        ...details,
        bodyPreview: body.slice(0, 200)
      });
      throw new TdfError(
        `TDF product details returned non-JSON content (${contentType}): ${body.slice(0, 200)}`,
        looksLikeAuthFailure(body) ? "auth" : "unexpected"
      );
    }

    let parsedOffers: TdfOffer[];
    try {
      const parsed = JSON.parse(body) as unknown;
      parsedOffers = parseOffers(expandStorefrontProductsWithPerformances(parsed, selectablePerformances));
    } catch (error) {
      addStep(run, "fetch-tdf-product-details", "failure", {
        ...details,
        bodyPreview: body.slice(0, 200),
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    offers.push(...parsedOffers);
    addStep(run, "fetch-tdf-product-details", "success", {
      ...details,
      parsedProducts: parsedOffers.length
    });
  }

  return mergeStorefrontOffers(offers);
}

async function fetchTicketPriceLabels(
  cookie: string,
  selectablePerformances: Map<string, StorefrontPerformance[]>,
  run: RunLog,
  attempt: number
): Promise<Map<string, string>> {
  const tickets = await fetchMatchingTicketVariations(cookie, selectablePerformances, run, attempt);
  if (tickets.length === 0) {
    return new Map();
  }

  const prices = await fetchTicketPrices(cookie, tickets.map((ticket) => ticket.productId), run, attempt);
  const grouped = new Map<string, Set<string>>();
  for (const ticket of tickets) {
    const price = prices.get(ticket.productId);
    if (!price) {
      continue;
    }
    const key = productionKey(ticket.productionId);
    const values = grouped.get(key) ?? new Set<string>();
    values.add(price);
    grouped.set(key, values);
  }

  return new Map([...grouped].flatMap(([productionId, values]) => {
    const label = formatPriceLabel([...values]);
    return label ? [[productionId, label]] : [];
  }));
}

type TicketVariation = {
  productId: string;
  productionId: string;
  performanceDate: string;
};

async function fetchMatchingTicketVariations(
  cookie: string,
  selectablePerformances: Map<string, StorefrontPerformance[]>,
  run: RunLog,
  attempt: number
): Promise<TicketVariation[]> {
  const wanted = new Set<string>();
  for (const [productionId, performances] of selectablePerformances) {
    for (const performance of performances) {
      const performanceDate = normalizedDateKey(fieldString(performance, [
        "Performance_Date__c",
        "PerformanceDate__c",
        "Start_Date__c",
        "StartDate__c",
        "Event_Date__c"
      ]));
      if (performanceDate) {
        wanted.add(ticketVariationKey(productionId, performanceDate));
      }
    }
  }
  if (wanted.size === 0) {
    return [];
  }

  const tickets: TicketVariation[] = [];
  let page = 0;
  let total = Number.POSITIVE_INFINITY;
  while (page * 200 < total) {
    const started = Date.now();
    const response = await fetch(ticketVariationSearchUrl(page), {
      headers: jsonHeaders(cookie, tdfOffersUrl)
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const details = {
      attempt,
      page,
      status: response.status,
      contentType,
      bodyBytes: body.length,
      durationMs: Date.now() - started
    };

    if (!response.ok) {
      addStep(run, "fetch-tdf-ticket-variations", "failure", details);
      throw new TdfError(`TDF ticket variations returned ${response.status}: ${body.slice(0, 200)}`, classifyStatus(response.status));
    }
    if (!contentType.includes("application/json")) {
      addStep(run, "fetch-tdf-ticket-variations", "failure", {
        ...details,
        bodyPreview: body.slice(0, 200)
      });
      throw new TdfError(
        `TDF ticket variations returned non-JSON content (${contentType}): ${body.slice(0, 200)}`,
        looksLikeAuthFailure(body) ? "auth" : "unexpected"
      );
    }

    const parsed = JSON.parse(body) as unknown;
    const products = productsFromSearchPayload(parsed);
    for (const product of products) {
      const fields = isRecord(product["fields"]) ? product["fields"] : {};
      const productId = stringValue(product["id"]);
      const productionId = fieldString(fields, ["Production__c", "ProductionSeasonId__c", "Production_Season_Id__c"]);
      const performanceDate = normalizedDateKey(fieldString(fields, [
        "Performance_Date__c",
        "PerformanceDate__c",
        "Start_Date__c",
        "StartDate__c",
        "Event_Date__c"
      ]));
      if (!productId || !productionId || !performanceDate) {
        continue;
      }
      if (wanted.has(ticketVariationKey(productionId, performanceDate))) {
        tickets.push({ productId, productionId, performanceDate });
      }
    }

    total = totalFromSearchPayload(parsed) ?? products.length;
    addStep(run, "fetch-tdf-ticket-variations", "success", {
      ...details,
      pageProducts: products.length,
      ticketsSoFar: tickets.length,
      total
    });
    if (products.length === 0) {
      break;
    }
    page += 1;
  }

  return tickets;
}

async function fetchTicketPrices(
  cookie: string,
  productIds: string[],
  run: RunLog,
  attempt: number
): Promise<Map<string, string>> {
  const prices = new Map<string, string>();
  const chunkSize = 50;
  for (let index = 0; index < productIds.length; index += chunkSize) {
    const chunk = productIds.slice(index, index + chunkSize);
    const started = Date.now();
    const response = await fetch(ticketPricingUrl(chunk), {
      headers: jsonHeaders(cookie, tdfOffersUrl)
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const details = {
      attempt,
      chunk: index / chunkSize,
      requestedProducts: chunk.length,
      status: response.status,
      contentType,
      bodyBytes: body.length,
      durationMs: Date.now() - started
    };

    if (!response.ok) {
      addStep(run, "fetch-tdf-ticket-prices", "failure", details);
      throw new TdfError(`TDF ticket prices returned ${response.status}: ${body.slice(0, 200)}`, classifyStatus(response.status));
    }
    if (!contentType.includes("application/json")) {
      addStep(run, "fetch-tdf-ticket-prices", "failure", {
        ...details,
        bodyPreview: body.slice(0, 200)
      });
      throw new TdfError(
        `TDF ticket prices returned non-JSON content (${contentType}): ${body.slice(0, 200)}`,
        looksLikeAuthFailure(body) ? "auth" : "unexpected"
      );
    }

    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed["pricingLineItemResults"])) {
      addStep(run, "fetch-tdf-ticket-prices", "failure", {
        ...details,
        bodyPreview: body.slice(0, 200)
      });
      throw new TdfError("TDF ticket prices had an invalid response shape.", "unexpected");
    }
    for (const item of parsed["pricingLineItemResults"]) {
      if (!isRecord(item) || item["success"] !== true) {
        continue;
      }
      const productId = stringValue(item["productId"]);
      const unitPrice = stringValue(item["unitPrice"]);
      if (productId && unitPrice && Number(unitPrice) > 0) {
        prices.set(productId, formatCurrency(Number(unitPrice)));
      }
    }
    addStep(run, "fetch-tdf-ticket-prices", "success", {
      ...details,
      pricedProducts: prices.size
    });
  }
  return prices;
}

function applyPriceLabels(offers: TdfOffer[], priceLabels: Map<string, string>): void {
  for (const offer of offers) {
    const priceLabel = priceLabels.get(productionKey(String(offer.productionSeasonId)));
    if (priceLabel) {
      offer.priceLabel = priceLabel;
    }
  }
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

function productSearchUrl(page: number): string {
  const params = new URLSearchParams({
    categoryId: tdfPerformancesCategoryId,
    page: String(page),
    pageSize: "200",
    fields: "Id,Name,Venue_Name__c,StockKeepingUnit",
    includeProductVariationInfo: "false",
    language: "en-US",
    asGuest: "false",
    htmlEncode: "false"
  });
  return `${tdfApiBaseUrl}/search/products?${params.toString()}`;
}

function ticketVariationSearchUrl(page: number): string {
  const params = new URLSearchParams({
    categoryId: tdfTicketVariationsCategoryId,
    page: String(page),
    pageSize: "200",
    fields: "Id,Name,Venue_Name__c,StockKeepingUnit,Performance_Date__c,Production__c",
    includeProductVariationInfo: "false",
    language: "en-US",
    asGuest: "false",
    htmlEncode: "false"
  });
  return `${tdfApiBaseUrl}/search/products?${params.toString()}`;
}

function ticketPricingUrl(productIds: string[]): string {
  const params = new URLSearchParams({
    productIds: productIds.join(","),
    language: "en-US",
    asGuest: "false",
    htmlEncode: "false"
  });
  return `${tdfApiBaseUrl}/pricing/products?${params.toString()}`;
}

function productDetailsUrl(productIds: string[]): string {
  const params = new URLSearchParams({
    ids: productIds.join(","),
    fields: tdfProductFields,
    language: "en-US",
    asGuest: "false",
    htmlEncode: "false"
  });
  return `${tdfApiBaseUrl}/products?${params.toString()}`;
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

function productsFromStorefrontPayload(input: unknown): Array<Record<string, unknown>> | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  if (Array.isArray(input["products"])) {
    return input["products"].filter(isRecord);
  }
  if (isRecord(input["productsPage"])) {
    return productsFromSearchPayload(input);
  }
  return undefined;
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

function offerFromStorefrontProduct(product: Record<string, unknown>, index: number): TdfOffer | undefined {
  const fields = isRecord(product["fields"]) ? product["fields"] : {};
  const id = stringValue(product["id"]) ?? `product-${index}`;
  const title = fieldString(fields, ["Name"]) ?? stringValue(product["name"]);
  if (!title) {
    return undefined;
  }
  const facility =
    venueNameFromDescription(fieldString(fields, ["Description"])) ??
    displayVenueField(fields, ["Venue_Name__c", "Venue__c", "Facility__c", "Location__c", "Theater__c", "Theatre__c"]) ??
    "TDF";
  const productionSeasonId = fieldString(fields, ["ProductionSeasonId__c", "Production_Season_Id__c"]) ?? title;
  const performanceId = fieldString(fields, ["PerformanceId__c", "Performance_Id__c"]) ?? id;
  const performanceDate =
    fieldString(fields, ["Performance_Date__c", "PerformanceDate__c", "Start_Date__c", "StartDate__c", "Event_Date__c"]) ??
    "Date unavailable";
  const offer: TdfOffer = {
    productionSeasonId,
    title,
    facility,
    performances: [
      {
        performanceId,
        performanceDate
      }
    ]
  };
  const thumbnail = storefrontImageUrl(product["defaultImage"]);
  if (thumbnail) {
    offer.thumbnail = thumbnail;
  }
  return offer;
}

function offersFromStorefrontProducts(products: Array<Record<string, unknown>>): TdfOffer[] {
  const grouped = new Map<string, TdfOffer>();
  products.forEach((product, index) => {
    const offer = offerFromStorefrontProduct(product, index);
    if (!offer) {
      return;
    }
    const key = storefrontGroupKey(product, offer);
    const existing = grouped.get(key);
    if (existing) {
      existing.performances.push(...offer.performances);
      if (!existing.thumbnail && offer.thumbnail) {
        existing.thumbnail = offer.thumbnail;
      }
      return;
    }
    grouped.set(key, offer);
  });
  return Array.from(grouped.values());
}

function storefrontGroupKey(product: Record<string, unknown>, offer: TdfOffer): string {
  const fields = isRecord(product["fields"]) ? product["fields"] : {};
  const productionSeasonId = fieldString(fields, ["ProductionSeasonId__c", "Production_Season_Id__c"]);
  if (productionSeasonId) {
    return `season:${productionSeasonId}`;
  }
  return `show:${normalizedKeyPart(offer.title)}:${normalizedKeyPart(offer.facility)}`;
}

function normalizedKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function venueNameFromDescription(description: string | undefined): string | undefined {
  if (!description) {
    return undefined;
  }
  const match = description.match(/<span\b[^>]*(?:id|class)=["']venue_name["'][^>]*>(.*?)<\/span>/is);
  return match?.[1] ? normalizeHtmlText(match[1]) : undefined;
}

function displayVenueField(fields: Record<string, unknown>, candidates: string[]): string | undefined {
  const value = fieldString(fields, candidates);
  if (!value || /^001[A-Za-z0-9]{12,}$/.test(value)) {
    return undefined;
  }
  return value;
}

function normalizeHtmlText(value: string): string | undefined {
  const text = value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&mdash;/gi, "-")
    .replace(/&ndash;/gi, "-")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
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
  if (typeof value === "string") {
    return value.trim() ? value : undefined;
  }
  if (isRecord(value) && typeof value["value"] === "string") {
    return value["value"].trim() ? value["value"] : undefined;
  }
  return undefined;
}

function ticketVariationKey(productionId: string, performanceDate: string): string {
  return `${productionKey(productionId)}:${performanceDate}`;
}

function productionKey(productionId: string): string {
  return /^01t[A-Za-z0-9]{12,15}$/.test(productionId) ? productionId.slice(0, 15) : productionId;
}

function normalizedDateKey(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString();
}

function formatPriceLabel(prices: string[]): string | undefined {
  const values = [...new Set(prices)].sort((left, right) => numericPrice(left) - numericPrice(right));
  if (values.length === 0) {
    return undefined;
  }
  if (values.length === 1) {
    return values[0];
  }
  const first = values[0] ?? "";
  const last = values[values.length - 1] ?? "";
  return `${first}-${last}`;
}

function formatCurrency(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

function numericPrice(value: string): number {
  return Number(value.replace(/[^0-9.]/g, ""));
}

function storefrontImageUrl(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const url = stringValue(value["url"]) ?? stringValue(value["thumbnailUrl"]);
  if (!url || url.includes("/default-product-image.svg")) {
    return undefined;
  }
  return url.startsWith("/") ? `https://members.tdf.org${url}` : url;
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

function countSelectablePerformances(selectablePerformances: Map<string, StorefrontPerformance[]>): number {
  let total = 0;
  for (const performances of selectablePerformances.values()) {
    total += performances.length;
  }
  return total;
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

function isLoginRedirect(url: string): boolean {
  return url.includes("/account/login") || url.includes("/store/login") || url.includes("members.tdf.org/account");
}
