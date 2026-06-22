import assert from "node:assert/strict";
import test from "node:test";
import {
  tdfMemberHomeUrl,
  tdfOffersUrl,
  tdfPerformancesCategoryId,
  tdfSessionContextUrl
} from "../worker/constants.js";
import { createRun } from "../worker/logging.js";
import { fetchTdfOffers, mergeSetCookies, parseOffers } from "../worker/tdf.js";
import { response, sampleOffers, storefrontProductsFromSample, storefrontSearch, withFetch } from "./worker-helpers.js";

const csrfTokenModule = "LWR.define('@app/csrfToken', [], function() { return \"csrf-token\"; });";

function productPerformancesResponse(selectable = true): string {
  return JSON.stringify({ returnValue: selectable ? [{ id: "selectable-performance" }] : [] });
}

function productIdFromApexInit(init: RequestInit | undefined): string {
  const body = JSON.parse(requestBodyText(init)) as { params?: { productId?: string } };
  return body.params?.productId ?? "";
}

function productIdsFromAvailabilityInit(init: RequestInit | undefined): string[] {
  const body = JSON.parse(requestBodyText(init)) as { params?: { productionIds?: string[] } };
  return body.params?.productionIds ?? [];
}

function apexMethodFromInit(init: RequestInit | undefined): string {
  const body = JSON.parse(requestBodyText(init)) as { method?: string };
  return body.method ?? "";
}

function apexResponseForProductIds(init: RequestInit | undefined, productIds: string[]): string {
  if (apexMethodFromInit(init) === "getProductionsWithAvailability") {
    assert.deepEqual(productIdsFromAvailabilityInit(init), productIds);
    return JSON.stringify({ returnValue: productIds });
  }

  assert.ok(productIds.includes(productIdFromApexInit(init)));
  return productPerformancesResponse();
}

function requestBodyText(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "{}";
}

test("TDF endpoints use the current members host", () => {
  assert.equal(tdfMemberHomeUrl, "https://members.tdf.org/store/");
  assert.equal(tdfOffersUrl, "https://members.tdf.org/store/");
  assert.equal(tdfPerformancesCategoryId, "0ZGPe0000000AtpOAE");
  assert.match(tdfSessionContextUrl, /commerce\/webstores\/0ZEfK000000qcIvWAI\/session-context/);
  assert.match(tdfSessionContextUrl, /asGuest=false/);
  assert.doesNotMatch(tdfSessionContextUrl, /effectiveAccountId=000000000000000/);
});

test("fetchTdfOffers refreshes session cookies and returns parsed offers", async () => {
  const run = createRun("delta", "test");
  const calls: string[] = [];

  await withFetch(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === tdfMemberHomeUrl) {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html", "set-cookie": "TNEW=fresh; path=/" },
        url: tdfMemberHomeUrl
      });
    }
    if (url.includes("/session-context")) {
      return response(JSON.stringify({ guestUser: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/category/performances/")) {
      return response("<html>Performances Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html", "set-cookie": "anti=fresh; path=/" },
        url
      });
    }
    if (url.includes("/search/products")) {
      return response(storefrontSearch(), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/module/@app/csrfToken")) {
      return response(csrfTokenModule, {
        status: 200,
        headers: { "content-type": "application/javascript" },
        url
      });
    }
    if (url.includes("/api/apex/execute")) {
      return response(apexResponseForProductIds(init, ["01t-test-1"]), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/products?")) {
      return response(storefrontProductsFromSample(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }, async () => {
    const result = await fetchTdfOffers("TNEW=old; .TDFCustomOfferings.Session=session", run);
    assert.equal(result.offers.length, 1);
    assert.match(result.cookie, /TNEW=fresh/);
  });

  assert.equal(calls.length, 8);
  assert.ok(run.steps.some((step) => `${step.name}:${step.status}` === "fetch-tdf-performances:success"));
});

test("fetchTdfOffers uses authenticated Storefront requests and batches product details", async () => {
  const run = createRun("delta", "test");
  const productIds = Array.from({ length: 21 }, (_, index) => `01t-test-${index + 1}`);
  const productDetailCalls: string[] = [];

  await withFetch(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === tdfMemberHomeUrl) {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: tdfMemberHomeUrl
      });
    }
    if (url.includes("/session-context")) {
      assert.match(url, /asGuest=false/);
      assert.doesNotMatch(url, /effectiveAccountId=000000000000000/);
      return response(JSON.stringify({ guestUser: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/category/performances/")) {
      return response("<html>My Offers My Tickets Log In</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    if (url.includes("/search/products")) {
      assert.match(url, /asGuest=false/);
      return response(storefrontSearch(productIds), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/module/@app/csrfToken")) {
      return response(csrfTokenModule, {
        status: 200,
        headers: { "content-type": "application/javascript" },
        url
      });
    }
    if (url.includes("/api/apex/execute")) {
      return response(apexResponseForProductIds(init, productIds), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/products?")) {
      assert.match(url, /asGuest=false/);
      productDetailCalls.push(url);
      const ids = new URL(url).searchParams.get("ids")?.split(",") ?? [];
      assert.ok(ids.length <= 20);
      return response(JSON.stringify({
        products: ids.map((id) => ({
          id,
          fields: {
            Name: "Batched Show",
            Venue__c: "Theatre",
            Performance_Date__c: "2026-06-25T18:00:00Z"
          }
        }))
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }, async () => {
    const result = await fetchTdfOffers("TNEW=old; .TDFCustomOfferings.Session=session", run);
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0]?.performances.length, 21);
  });

  assert.equal(productDetailCalls.length, 2);
});

test("fetchTdfOffers filters products with no selectable performances", async () => {
  const run = createRun("delta", "test");
  const productDetailIds: string[] = [];

  await withFetch(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === tdfMemberHomeUrl) {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: tdfMemberHomeUrl
      });
    }
    if (url.includes("/session-context")) {
      return response(JSON.stringify({ guestUser: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/category/performances/")) {
      return response("<html>Performances Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    if (url.includes("/search/products")) {
      return response(storefrontSearch(["01t-empty-picker", "01t-selectable"]), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/module/@app/csrfToken")) {
      return response(csrfTokenModule, {
        status: 200,
        headers: { "content-type": "application/javascript" },
        url
      });
    }
    if (url.includes("/api/apex/execute")) {
      if (apexMethodFromInit(init) === "getProductionsWithAvailability") {
        assert.deepEqual(productIdsFromAvailabilityInit(init), ["01t-empty-picker", "01t-selectable"]);
        return response(JSON.stringify({ returnValue: ["01t-selectable"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
          url
        });
      }
      const productId = productIdFromApexInit(init);
      return response(JSON.stringify({
        returnValue: [
          {
            Id: productId === "01t-selectable" ? "performance-one" : "hidden-performance",
            Name: productId === "01t-selectable" ? "Selectable Show" : "Hidden Show",
            Production__c: productId,
            Performance_Date__c: "2026-06-25T18:00:00Z"
          },
          {
            Id: productId === "01t-selectable" ? "performance-two" : "hidden-performance-two",
            Name: productId === "01t-selectable" ? "Selectable Show" : "Hidden Show",
            Production__c: productId,
            Performance_Date__c: "2026-06-26T18:00:00Z"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/products?")) {
      productDetailIds.push(...(new URL(url).searchParams.get("ids")?.split(",") ?? []));
      return response(JSON.stringify({
        products: [
          {
            id: "01t-selectable",
            fields: {
              Name: "Selectable Show",
              Venue__c: "Theatre",
              Performance_Date__c: "2026-06-25T18:00:00Z"
            }
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }, async () => {
    const result = await fetchTdfOffers("TNEW=old; .TDFCustomOfferings.Session=session", run);
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0]?.performances.length, 2);
    assert.equal(result.offers[0]?.performances[0]?.performanceId, "performance-one");
    assert.equal(result.offers[0]?.performances[1]?.performanceDate, "2026-06-26T18:00:00Z");
    assert.deepEqual(productDetailIds, ["01t-selectable"]);
  });
});

test("fetchTdfOffers labels offers with ticket variation prices", async () => {
  const run = createRun("delta", "test");

  await withFetch(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === tdfMemberHomeUrl) {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: tdfMemberHomeUrl
      });
    }
    if (url.includes("/session-context")) {
      return response(JSON.stringify({ guestUser: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/category/performances/")) {
      return response("<html>Performances Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    if (url.includes("/search/products")) {
      const categoryId = new URL(url).searchParams.get("categoryId");
      if (categoryId === tdfPerformancesCategoryId) {
        return response(storefrontSearch(["01t-production-small"]), {
          status: 200,
          headers: { "content-type": "application/json" },
          url
        });
      }
      return response(JSON.stringify({
        productsPage: {
          products: [
            {
              id: "01t-ticket-small",
              fields: {
                Name: { value: "Small" },
                Production__c: { value: "01t-production-small" },
                Performance_Date__c: { value: "2026-06-24T23:00:00Z" },
                StockKeepingUnit: { value: "TKT-SMALL-20260624-700PM-Passport-Tier 1" }
              }
            }
          ],
          total: 1
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/module/@app/csrfToken")) {
      return response(csrfTokenModule, {
        status: 200,
        headers: { "content-type": "application/javascript" },
        url
      });
    }
    if (url.includes("/api/apex/execute")) {
      if (apexMethodFromInit(init) === "getProductionsWithAvailability") {
        return response(JSON.stringify({ returnValue: ["01t-production-small"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
          url
        });
      }
      return response(JSON.stringify({
        returnValue: [
          {
            Id: "01t-performance-small",
            Name: "Small",
            Production__c: "01t-production-small",
            Performance_Date__c: "2026-06-24T23:00:00.000Z"
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/pricing/products")) {
      assert.match(url, /01t-ticket-small/);
      return response(JSON.stringify({
        currencyIsoCode: "USD",
        pricingLineItemResults: [
          {
            productId: "01t-ticket-small",
            success: true,
            unitPrice: "20"
          }
        ],
        success: true
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/products?")) {
      return response(JSON.stringify({
        products: [
          {
            id: "01t-production-small",
            fields: {
              Name: "Small",
              Venue__c: "Theatre",
              Performance_Date__c: "2026-06-24T23:00:00Z"
            }
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }, async () => {
    const result = await fetchTdfOffers("TNEW=old; .TDFCustomOfferings.Session=session", run);
    assert.equal(result.offers[0]?.title, "Small");
    assert.equal(result.offers[0]?.priceLabel, "$20");
  });
});

test("fetchTdfOffers classifies login redirects as auth failures", async () => {
  const run = createRun("delta", "test");

  await withFetch(async () =>
    response("<html>login</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
      url: "https://members.tdf.org/store/login"
    }), async () => {
    await assert.rejects(
      () => fetchTdfOffers("TNEW=old; .TDFCustomOfferings.Session=session", run),
      /redirected to login/
    );
  });

  assert.equal(run.steps[0]?.name, "refresh-tdf-member-session");
  assert.equal(run.steps[0]?.status, "failure");
});

test("fetchTdfOffers classifies non-JSON auth challenges before parsing", async () => {
  const run = createRun("delta", "test");

  await withFetch(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === tdfMemberHomeUrl) {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: tdfMemberHomeUrl
      });
    }
    if (url.includes("/session-context")) {
      return response(JSON.stringify({ guestUser: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/category/performances/")) {
      return response("<html>Performances Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    if (url.includes("/search/products")) {
      return response("<html>access denied password</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }, async () => {
    await assert.rejects(
      () => fetchTdfOffers("TNEW=old; .TDFCustomOfferings.Session=session", run),
      /non-JSON content/
    );
  });

  const searchStep = run.steps.find((step) => step.name === "fetch-tdf-product-search");
  assert.equal(searchStep?.status, "failure");
  assert.match(String(searchStep?.details?.["bodyPreview"]), /access denied/);
});

test("fetchTdfOffers retries transient main page failures before fetching performances", async () => {
  const run = createRun("delta", "test");
  const currentPageStatuses = [522, 200];
  let memberHomeCalls = 0;
  const calls: string[] = [];

  await withFetch(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === tdfMemberHomeUrl) {
      memberHomeCalls += 1;
      const status = memberHomeCalls === 1 ? 200 : (currentPageStatuses.shift() ?? 200);
      return response(status === 200 ? "<html>Events My Account</html>" : "error code: 522", {
        status,
        headers: { "content-type": status === 200 ? "text/html" : "text/plain" },
        url: tdfMemberHomeUrl
      });
    }
    if (url.includes("/session-context")) {
      return response(JSON.stringify({ guestUser: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/search/products")) {
      return response(storefrontSearch(), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/module/@app/csrfToken")) {
      return response(csrfTokenModule, {
        status: 200,
        headers: { "content-type": "application/javascript" },
        url
      });
    }
    if (url.includes("/api/apex/execute")) {
      return response(apexResponseForProductIds(init, ["01t-test-1"]), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/products?")) {
      return response(storefrontProductsFromSample(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }, async () => {
    const result = await fetchTdfOffers("TNEW=old; .TDFCustomOfferings.Session=session", run);
    assert.equal(result.offers.length, 1);
  });

  assert.equal(calls.filter((url) => url === tdfMemberHomeUrl).length, 3);
  assert.ok(run.steps.some((step) => `${step.name}:${step.status}` === "touch-tdf-main-page:failure"));
  assert.ok(run.steps.some((step) => `${step.name}:${step.status}` === "touch-tdf-main-page:success"));
  assert.ok(run.steps.some((step) => `${step.name}:${step.status}` === "fetch-tdf-performances:success"));
});

test("fetchTdfOffers logs JSON parse failures with response metadata", async () => {
  const run = createRun("delta", "test");

  await withFetch(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === tdfMemberHomeUrl) {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: tdfMemberHomeUrl
      });
    }
    if (url.includes("/session-context")) {
      return response(JSON.stringify({ guestUser: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/category/performances/")) {
      return response("<html>Performances Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    if (url.includes("/search/products")) {
      return response(storefrontSearch(), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/module/@app/csrfToken")) {
      return response(csrfTokenModule, {
        status: 200,
        headers: { "content-type": "application/javascript" },
        url
      });
    }
    if (url.includes("/api/apex/execute")) {
      return response(apexResponseForProductIds(init, ["01t-test-1"]), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/products?")) {
      return response("{broken-json", {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }, async () => {
    await assert.rejects(
      () => fetchTdfOffers("TNEW=old; .TDFCustomOfferings.Session=session", run),
      /JSON/
    );
  });

  const detailsStep = run.steps.find((step) => step.name === "fetch-tdf-product-details");
  assert.equal(detailsStep?.status, "failure");
  assert.equal(detailsStep?.details?.["status"], 200);
  assert.equal(detailsStep?.details?.["contentType"], "application/json");
});

test("parseOffers rejects invalid payloads with a TDF response error", () => {
  assert.throws(() => parseOffers({ nope: true }), /not a JSON array/);
  assert.throws(() => parseOffers([{ title: "Missing performances" }]), /invalid offer shape/);
});

test("parseOffers accepts Salesforce Storefront product details", () => {
  const offers = parseOffers(JSON.parse(storefrontProductsFromSample(sampleOffers)));
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.productionSeasonId, "1");
  assert.equal(offers[0]?.title, "Show One");
  assert.equal(offers[0]?.facility, "Theatre");
  assert.equal(offers[0]?.performances[0]?.performanceId, "10");
});

test("parseOffers groups Salesforce Storefront performances by show", () => {
  const offers = parseOffers({
    products: [
      {
        id: "01t-one",
        fields: {
          Name: "Small - $20 Seats",
          Venue__c: "59E59 Theaters",
          Performance_Date__c: "2026-06-25T18:00:00Z"
        }
      },
      {
        id: "01t-two",
        fields: {
          Name: "Small - $20 Seats",
          Venue__c: "59E59 Theaters",
          Performance_Date__c: "2026-06-26T18:00:00Z"
        }
      },
      {
        id: "01t-three",
        fields: {
          Name: "Jerome - $20 Seats",
          Venue__c: "Theatre Row",
          Performance_Date__c: "2026-06-26T18:00:00Z"
        }
      }
    ]
  });

  assert.equal(offers.length, 2);
  assert.equal(offers[0]?.title, "Small - $20 Seats");
  assert.equal(offers[0]?.performances.length, 2);
  assert.equal(offers[0]?.performances[0]?.performanceId, "01t-one");
  assert.equal(offers[1]?.title, "Jerome - $20 Seats");
  assert.equal(offers[1]?.performances.length, 1);
});

test("parseOffers uses readable Storefront venue names and skips nameless products", () => {
  const offers = parseOffers({
    products: [
      {
        id: "01t-one",
        fields: {
          Description: '<div><span class="venue_name" id="venue_name" style="font-weight:bold">Lucille Lortel Theatre</span></div>',
          Name: "Kenrex",
          Venue__c: "001Pe00001Hpr5P",
          Performance_Date__c: "2026-06-25T18:00:00Z"
        }
      },
      {
        error: {
          message: "Unavailable product"
        },
        fields: {}
      }
    ]
  });

  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.facility, "Lucille Lortel Theatre");
  assert.equal(offers[0]?.title, "Kenrex");
});

test("mergeSetCookies replaces matching cookies and keeps unrelated values", () => {
  assert.equal(
    mergeSetCookies("TNEW=old; keep=value", ["TNEW=fresh; path=/", "anti=token; path=/"]),
    "TNEW=fresh; keep=value; anti=token"
  );
});
