import assert from "node:assert/strict";
import test from "node:test";
import {
  findNewAlerts,
  flattenOffers,
  markSeen,
  parseSeenState,
  parseTdfOffers
} from "../src/tdf.js";

const sampleResponse = [
  {
    productionSeasonId: 230117,
    title: "Passport: Dog Day Afternoon - $20 Seats",
    facility: "August Wilson Theatre",
    keywords: [
      {
        categoryId: 6,
        categoryName: "Venue",
        keywordId: 15,
        keywordName: "Broadway"
      }
    ],
    thumbnail: "https://media.tdf.org/images/TNEW/dog day.jpg",
    performances: [
      {
        performanceId: 242526,
        performanceDate: "2026-05-26T19:00:00-04:00"
      },
      {
        performanceId: 242527,
        performanceDate: "2026-05-28T19:00:00-04:00"
      }
    ],
    isTAP: false,
    isNew: true,
    promotions: [
      {
        categoryId: 14,
        categoryName: "Promotion",
        keywordId: 71,
        keywordName: "Passport Ticket Offers"
      }
    ]
  }
];

test("parses and flattens TDF offers", () => {
  const offers = parseTdfOffers(sampleResponse);
  const alerts = flattenOffers(offers);

  assert.equal(alerts.length, 2);
  assert.equal(alerts[0]?.id, "230117:242526");
  assert.equal(alerts[0]?.title, "Passport: Dog Day Afternoon - $20 Seats");
  assert.deepEqual(alerts[0]?.promotions, ["Passport Ticket Offers"]);
});

test("parses Salesforce Storefront products grouped by show", () => {
  const offers = parseTdfOffers({
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
      }
    ]
  });
  const alerts = flattenOffers(offers);

  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.title, "Small - $20 Seats");
  assert.equal(offers[0]?.performances.length, 2);
  assert.equal(alerts[0]?.id, "Small - $20 Seats:01t-one");
});

test("parses readable Salesforce Storefront venue names and skips nameless products", () => {
  const offers = parseTdfOffers({
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
});

test("diffs first run, second run, and a later new performance", () => {
  const alerts = flattenOffers(parseTdfOffers(sampleResponse));
  const emptyState = { seen: [] };
  const firstRun = findNewAlerts(alerts, emptyState);

  assert.equal(firstRun.length, 2);

  const afterFirstRun = markSeen(emptyState, firstRun);
  assert.equal(findNewAlerts(alerts, afterFirstRun).length, 0);

  const firstAlert = alerts[0];
  assert.ok(firstAlert);
  const laterAlerts = [
    ...alerts,
    {
      ...firstAlert,
      id: "230117:242528",
      performanceId: 242528,
      performanceDate: "2026-05-27T19:00:00-04:00"
    }
  ];

  const laterNew = findNewAlerts(laterAlerts, afterFirstRun);
  assert.equal(laterNew.length, 1);
  assert.equal(laterNew[0]?.performanceId, 242528);
});

test("normalizes seen state", () => {
  assert.deepEqual(parseSeenState({ seen: ["b", "a", "a"] }), { seen: ["a", "b"] });
  assert.throws(() => parseSeenState({ seen: [123] }), /non-string/);
});

test("rejects malformed TDF offer payloads before flattening alerts", () => {
  assert.throws(() => parseTdfOffers({}), /not a JSON array/);
  assert.throws(() => parseTdfOffers([null]), /not an object/);
  assert.throws(
    () => parseTdfOffers([{ ...sampleResponse[0], productionSeasonId: Number.POSITIVE_INFINITY }]),
    /invalid productionSeasonId/
  );
  assert.throws(
    () => parseTdfOffers([{ ...sampleResponse[0], title: 123 }]),
    /invalid title/
  );
  assert.throws(
    () => parseTdfOffers([{ ...sampleResponse[0], performances: [null] }]),
    /Performance at index 0\.0 was not an object/
  );
  assert.throws(
    () => parseTdfOffers([{ ...sampleResponse[0], performances: [{ performanceId: 1, performanceDate: 123 }] }]),
    /invalid performanceDate/
  );
  assert.throws(
    () => parseTdfOffers([{ ...sampleResponse[0], keywords: [null] }]),
    /keywords at index 0\.0 was not an object/
  );
  assert.throws(
    () => parseTdfOffers([{ ...sampleResponse[0], promotions: "bad" }]),
    /invalid promotions/
  );
  assert.throws(
    () => parseTdfOffers([{ ...sampleResponse[0], isNew: "yes" }]),
    /invalid isNew/
  );
  assert.throws(() => parseSeenState(null), /seen array/);
});
