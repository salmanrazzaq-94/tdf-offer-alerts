import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAuthFailureMessage,
  formatDigestSummary,
  formatOfferDetailsFile,
  timestampedDetailsFilename
} from "../src/telegram.js";
import type { AlertItem } from "../src/tdf.js";

const item: AlertItem = {
  id: "230117:242526",
  productionSeasonId: 230117,
  performanceId: 242526,
  performanceDate: "2026-05-26T19:00:00-04:00",
  title: "Passport: Dog Day Afternoon - $20 Seats",
  facility: "August Wilson Theatre",
  thumbnail: "https://media.tdf.org/images/TNEW/dog day.jpg",
  categories: ["Broadway", "Play/Drama"],
  promotions: ["Passport Ticket Offers"]
};

const offer = {
  productionSeasonId: 230117,
  title: "Passport: Dog Day Afternoon - $20 Seats",
  facility: "August Wilson Theatre",
  thumbnail: "https://media.tdf.org/images/TNEW/dog day.jpg",
  isTAP: false,
  isNew: true,
  keywords: [
    {
      categoryId: 6,
      categoryName: "Venue",
      keywordId: 15,
      keywordName: "Broadway"
    }
  ],
  promotions: [
    {
      categoryId: 14,
      categoryName: "Promotion",
      keywordId: 71,
      keywordName: "Passport Ticket Offers"
    }
  ],
  performances: [
    {
      performanceId: 242526,
      performanceDate: "2026-05-26T19:00:00-04:00"
    }
  ]
};

test("formats a Telegram digest summary", () => {
  const message = formatDigestSummary([offer], [item]);

  assert.match(message, /<b>TDF Offers Update<\/b>/);
  assert.match(message, /1 new performances\. 1 shows, 1 performances available\./);
  assert.match(message, /<b>Available shows<\/b>/);
  assert.match(message, /Passport: Dog Day Afternoon - \$20 Seats/);
});

test("formats an attached offer details file", () => {
  const message = formatOfferDetailsFile([offer], [item]);

  assert.match(message, /TDF OFFERS/);
  assert.match(message, /Passport: Dog Day Afternoon - \$20 Seats/);
  assert.match(message, /August Wilson Theatre/);
  assert.match(message, /NEW Tue, May 26, 7:00 PM/);
  assert.doesNotMatch(message, /performanceId/);
});

test("escapes auth failure text", () => {
  const message = formatAuthFailureMessage("Returned <html> & login page");

  assert.match(message, /TDF login needs attention/);
  assert.match(message, /Returned &lt;html&gt; &amp; login page/);
});

test("formats timestamped details filenames", () => {
  const filename = timestampedDetailsFilename(
    "tdf-offers-current",
    new Date("2026-05-23T15:05:00Z")
  );

  assert.equal(filename, "tdf-offers-current-20260523-1105-ny.txt");
});
