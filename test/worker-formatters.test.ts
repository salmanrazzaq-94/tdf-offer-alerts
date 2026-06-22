import assert from "node:assert/strict";
import test from "node:test";
import { formatDetails, formatSummary } from "../worker/formatters.js";
import type { AlertItem, TdfOffer } from "../worker/types.js";

const passportOffer: TdfOffer = {
  productionSeasonId: 230117,
  title: "Passport: Dog Day Afternoon - $20 Seats",
  facility: "August Wilson Theatre",
  performances: [
    {
      performanceId: 242526,
      performanceDate: "2026-05-26T19:00:00-04:00"
    },
    {
      performanceId: 242527,
      performanceDate: "2026-05-27T19:00:00-04:00"
    }
  ]
};

const newItem: AlertItem = {
  id: "230117:242526",
  title: "Passport: Dog Day Afternoon - $20 Seats",
  facility: "August Wilson Theatre",
  performanceDate: "2026-05-26T19:00:00-04:00"
};

test("summary removes redundant Passport prefix from display titles", () => {
  const message = formatSummary([passportOffer], [newItem]);

  assert.match(message, /Dog Day Afternoon - \$20 Seats/);
  assert.doesNotMatch(message, /Passport: Dog Day Afternoon/);
});

test("delta summary lists only matching shows when message contains a subset", () => {
  const message = formatSummary([passportOffer], [newItem]);

  assert.match(message, /1 new performance/);
  assert.match(message, /Full current list attached/);
  assert.match(message, /Dog Day Afternoon - \$20 Seats \(1 new\)/);
  assert.doesNotMatch(message, /2\)/);
});

test("daily summary uses the simple Telegram shape", () => {
  const offers: TdfOffer[] = [
    {
      productionSeasonId: "are-you-now",
      title: "Are You Now or Have You Ever Been? - $20 Seats",
      facility: "Theatre",
      performances: Array.from({ length: 7 }, (_, index) => ({
        performanceId: `are-you-now-${index}`,
        performanceDate: "2026-06-25T18:00:00Z"
      }))
    },
    {
      productionSeasonId: "jerome",
      title: "Jerome - $20 Seats",
      facility: "Theatre",
      performances: Array.from({ length: 5 }, (_, index) => ({
        performanceId: `jerome-${index}`,
        performanceDate: "2026-06-25T18:00:00Z"
      }))
    }
  ];
  const items = offers.flatMap((offer) =>
    offer.performances.map((performance): AlertItem => ({
      id: `${offer.productionSeasonId}:${performance.performanceId}`,
      title: offer.title,
      facility: offer.facility,
      performanceDate: performance.performanceDate
    }))
  );

  assert.equal(formatSummary(offers, items), [
    "TDF Offers",
    "2 shows, 12 performances available.",
    "12 new performances in this message.",
    "",
    "Available shows",
    "• Are You Now or Have You Ever Been? - $20 Seats (7)",
    "• Jerome - $20 Seats (5)"
  ].join("\n"));
});

test("details file keeps performances grouped under each show", () => {
  const offers: TdfOffer[] = [
    {
      productionSeasonId: "small",
      title: "Small - $20 Seats",
      facility: "59E59 Theaters",
      performances: [
        {
          performanceId: "small-1",
          performanceDate: "2026-06-25T18:00:00Z"
        },
        {
          performanceId: "small-2",
          performanceDate: "2026-06-26T18:00:00Z"
        }
      ]
    }
  ];

  const message = formatDetails(offers, []);

  assert.match(message, /1\. Small - \$20 Seats \(2\)/);
  assert.match(message, /Small - \$20 Seats\n59E59 Theaters\nThu, Jun 25, 2:00 PM\nFri, Jun 26, 2:00 PM/);
});

test("summary appends Storefront ticket price labels", () => {
  const offers: TdfOffer[] = [
    {
      productionSeasonId: "small",
      title: "Small",
      priceLabel: "$20",
      facility: "59E59 Theaters",
      performances: [
        {
          performanceId: "small-1",
          performanceDate: "2026-06-25T18:00:00Z"
        }
      ]
    }
  ];

  assert.match(formatSummary(offers, []), /Small - \$20 Seats \(1\)/);
});

test("summary stays under Telegram message limits for large offer sets", () => {
  const offers = Array.from({ length: 581 }, (_, index): TdfOffer => ({
    productionSeasonId: `season-${index}`,
    title: `Passport: Very Long Broadway Show Title ${index} With Extra Descriptive Copy`,
    facility: "A Theater",
    performances: [
      {
        performanceId: `performance-${index}`,
        performanceDate: "2026-05-26T19:00:00-04:00"
      }
    ]
  }));

  const message = formatSummary(offers, []);

  assert.ok(message.length < 4096, `summary was ${message.length} characters`);
  assert.match(message, /581 shows, 581 performances available/);
  assert.match(message, /Full current list attached/);
  assert.match(message, /\.\.\.and \d+ more shows/);
});

test("details file removes redundant Passport prefix", () => {
  const message = formatDetails([passportOffer], [newItem]);

  assert.match(message, /Dog Day Afternoon - \$20 Seats/);
  assert.doesNotMatch(message, /Passport: Dog Day Afternoon/);
});
