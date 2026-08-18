import assert from "node:assert/strict";

import { test } from "vitest";

import { toUsdcBaseUnits } from "#lib/chain/chain.ts";

test("toUsdcBaseUnits coerces invalid dollar inputs to zero", () => {
  assert.equal(toUsdcBaseUnits(-5), 0n);
  assert.equal(toUsdcBaseUnits(NaN), 0n);
  assert.equal(toUsdcBaseUnits(Infinity), 0n);
  assert.equal(toUsdcBaseUnits("abc"), 0n);
});

test("toUsdcBaseUnits parses string dollar amounts exactly", () => {
  assert.equal(toUsdcBaseUnits("12.34"), 12340000n);
  assert.equal(toUsdcBaseUnits("0.29"), 290000n);
  assert.equal(toUsdcBaseUnits(0), 0n);
});
