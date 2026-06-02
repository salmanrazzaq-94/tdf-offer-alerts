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

test("details file removes redundant Passport prefix", () => {
  const message = formatDetails([passportOffer], [newItem]);

  assert.match(message, /Dog Day Afternoon - \$20 Seats/);
  assert.doesNotMatch(message, /Passport: Dog Day Afternoon/);
});
