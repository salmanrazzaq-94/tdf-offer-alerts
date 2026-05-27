import assert from "node:assert/strict";
import test from "node:test";
import { createRun } from "../worker/logging.js";
import { fetchTdfOffers, mergeSetCookies, parseOffers } from "../worker/tdf.js";
import { response, sampleOffers, withFetch } from "./worker-helpers.js";

test("fetchTdfOffers refreshes session cookies and returns parsed offers", async () => {
  const run = createRun("delta", "test");
  const calls: string[] = [];

  await withFetch(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html", "set-cookie": "TNEW=fresh; path=/" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html", "set-cookie": "anti=fresh; path=/" },
        url
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }, async () => {
    const result = await fetchTdfOffers("TNEW=old; .TDFCustomOfferings.Session=session", run);
    assert.equal(result.offers.length, 1);
    assert.match(result.cookie, /TNEW=fresh/);
    assert.match(result.cookie, /anti=fresh/);
  });

  assert.equal(calls.length, 3);
  assert.ok(run.steps.some((step) => `${step.name}:${step.status}` === "fetch-tdf-performances:success"));
});

test("fetchTdfOffers classifies login redirects as auth failures", async () => {
  const run = createRun("delta", "test");

  await withFetch(async () =>
    response("<html>login</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
      url: "https://my.tdf.org/account/login"
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
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response("<html>access denied password</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
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

  const performanceStep = run.steps.find((step) => step.name === "fetch-tdf-performances");
  assert.equal(performanceStep?.status, "failure");
  assert.match(String(performanceStep?.details?.["bodyPreview"]), /access denied/);
});

test("fetchTdfOffers logs JSON parse failures with response metadata", async () => {
  const run = createRun("delta", "test");

  await withFetch(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response("{broken-json", {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
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

  const performanceStep = run.steps.find((step) => step.name === "fetch-tdf-performances");
  assert.equal(performanceStep?.status, "failure");
  assert.equal(performanceStep?.details?.["status"], 200);
  assert.equal(performanceStep?.details?.["contentType"], "application/json");
  assert.match(String(performanceStep?.details?.["bodyPreview"]), /broken-json/);
  assert.match(String(performanceStep?.details?.["message"]), /JSON/);
});

test("parseOffers rejects invalid payloads with a TDF response error", () => {
  assert.throws(() => parseOffers({ nope: true }), /not a JSON array/);
  assert.throws(() => parseOffers([{ title: "Missing performances" }]), /invalid offer shape/);
});

test("mergeSetCookies replaces matching cookies and keeps unrelated values", () => {
  assert.equal(
    mergeSetCookies("TNEW=old; keep=value", ["TNEW=fresh; path=/", "anti=token; path=/"]),
    "TNEW=fresh; keep=value; anti=token"
  );
});
