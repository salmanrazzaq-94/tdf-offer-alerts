import assert from "node:assert/strict";
import test from "node:test";
import { formatAlertMessage, formatAuthFailureMessage } from "../src/telegram.js";
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

test("formats a Telegram alert message", () => {
  const message = formatAlertMessage(item);

  assert.match(message, /<b>New TDF offer<\/b>/);
  assert.match(message, /Passport: Dog Day Afternoon - \$20 Seats/);
  assert.match(message, /August Wilson Theatre/);
  assert.match(message, /Performance ID: 242526/);
  assert.match(message, /Passport Ticket Offers \| Broadway \| Play\/Drama/);
  assert.match(message, /https:\/\/media\.tdf\.org/);
});

test("escapes auth failure text", () => {
  const message = formatAuthFailureMessage("Returned <html> & login page");

  assert.match(message, /TDF login needs attention/);
  assert.match(message, /Returned &lt;html&gt; &amp; login page/);
});
