import assert from "node:assert/strict";

import { test } from "vitest";

import { fmtUsd } from "#lib/format.ts";

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
