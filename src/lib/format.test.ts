import assert from "node:assert/strict";

import { test } from "vitest";

import {
  fmtUsd,
  formatAmountInput,
  MS_PER_DAY,
  parseMoney,
  relDays,
  usdcBaseUnitsToDollars,
} from "#lib/format.ts";

// Display rounds to cents by design; sub-cent dust from whole-unit curve
// costs is handled by exact bigint math upstream, not the formatter.
test("fmtUsd formats per its documented modes", () => {
  assert.equal(fmtUsd(5), "$5");
  assert.equal(fmtUsd(5.5), "$5.50");
  assert.equal(fmtUsd(4.9995), "$5.00");
  assert.equal(fmtUsd(5, "cents"), "$5.00");
  assert.equal(fmtUsd(1234.56), "$1,234.56");
  assert.equal(fmtUsd(0.0529, "price"), "$0.0529");
  assert.equal(fmtUsd(1500000, "compact"), "$1.50M");
  assert.equal(fmtUsd(4.9995, "whole"), "$5");
});

test("relDays covers future, today, and past", () => {
  const now = Date.now();
  assert.equal(relDays(now + 2.5 * MS_PER_DAY), "in 3 days");
  assert.equal(relDays(now + 0.5 * MS_PER_DAY), "in 1 day");
  assert.equal(relDays(now), "today");
  assert.equal(relDays(now - 1.5 * MS_PER_DAY), "1 day ago");
  assert.equal(relDays(now - 2.5 * MS_PER_DAY), "2 days ago");
});

test("relDays hides past dates when asked", () => {
  const now = Date.now();
  assert.equal(relDays(now - 2.5 * MS_PER_DAY, { pastDates: false }), "");
  assert.equal(relDays(now, { pastDates: false }), "today");
});

test("parseMoney strips separators and junk", () => {
  assert.equal(parseMoney("1,234.56"), 1234.56);
  assert.equal(parseMoney("$50"), 50);
  assert.equal(parseMoney("abc"), 0);
});

test("usdcBaseUnitsToDollars converts bigint, number, string, and empty values", () => {
  assert.equal(usdcBaseUnitsToDollars(1500000n), 1.5);
  assert.equal(usdcBaseUnitsToDollars(1500000), 1.5);
  // Legacy localStorage caches hold decimal strings.
  assert.equal(usdcBaseUnitsToDollars("1500000"), 1.5);
  assert.equal(usdcBaseUnitsToDollars(null), 0);
  assert.equal(usdcBaseUnitsToDollars(undefined), 0);
});

test("formatAmountInput formats as the user types", () => {
  assert.equal(formatAmountInput("1234"), "1,234");
  assert.equal(formatAmountInput("1234.567"), "1,234.56");
  assert.equal(formatAmountInput(".5"), "0.5");
  assert.equal(formatAmountInput("0042"), "42");
  assert.equal(formatAmountInput(""), "");
});
