import assert from "node:assert/strict";

import { test } from "vitest";

import {
  fmtUsd,
  formatAmountInput,
  MS_PER_DAY,
  parseMoney,
  relDays,
} from "#lib/format.ts";

test("fmtUsd auto shows cents only when present", () => {
  assert.equal(fmtUsd(1234), "$1,234");
  assert.equal(fmtUsd(1234.5), "$1,234.50");
  assert.equal(fmtUsd(0.5), "$0.50");
  assert.equal(fmtUsd(0), "$0");
});

test("fmtUsd cents always shows two decimals", () => {
  assert.equal(fmtUsd(5, "cents"), "$5.00");
  assert.equal(fmtUsd(1234.567, "cents"), "$1,234.57");
});

test("fmtUsd whole rounds to whole dollars", () => {
  assert.equal(fmtUsd(1234.6, "whole"), "$1,235");
});

test("fmtUsd price uses four decimals below a dollar", () => {
  assert.equal(fmtUsd(0.1234, "price"), "$0.1234");
  assert.equal(fmtUsd(5, "price"), "$5.00");
});

test("fmtUsd compact abbreviates thousands and millions", () => {
  assert.equal(fmtUsd(2_000_000, "compact"), "$2M");
  assert.equal(fmtUsd(1_500_000, "compact"), "$1.50M");
  assert.equal(fmtUsd(250_000, "compact"), "$250K");
  assert.equal(fmtUsd(999, "compact"), "$999");
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

test("formatAmountInput formats as the user types", () => {
  assert.equal(formatAmountInput("1234"), "1,234");
  assert.equal(formatAmountInput("1234.567"), "1,234.56");
  assert.equal(formatAmountInput(".5"), "0.5");
  assert.equal(formatAmountInput("0042"), "42");
  assert.equal(formatAmountInput(""), "");
});
