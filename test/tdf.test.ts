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

test("diffs first run, second run, and a later new performance", () => {
  const alerts = flattenOffers(parseTdfOffers(sampleResponse));
  const emptyState = { seen: [] };
  const firstRun = findNewAlerts(alerts, emptyState);

  assert.equal(firstRun.length, 2);

  const afterFirstRun = markSeen(emptyState, firstRun);
  assert.equal(findNewAlerts(alerts, afterFirstRun).length, 0);

  const laterAlerts = [
    ...alerts,
    {
      ...alerts[0],
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
