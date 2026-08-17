import assert from "node:assert/strict";

import { test } from "vitest";

import {
  costForUnits,
  fractionAt,
  fractionAtRaise,
  unitsForBudget,
} from "#lib/chain/curve.ts";
import type { Pact } from "#lib/chain/curve.ts";

const band = { vMin: 40_000, vMax: 60_000, cap: 50_000, F: 0.2, rmax: 10_000 };

test("fractionAtRaise pins the endpoints", () => {
  assert.equal(fractionAtRaise(band, 0), 0);
  assert.equal(fractionAtRaise(band, -5), 0);
  assert.equal(fractionAtRaise(band, band.rmax), band.F);
  assert.equal(fractionAtRaise(band, band.rmax * 2), band.F);
});

test("fractionAtRaise is flat-band linear and monotonic otherwise", () => {
  const flat = { ...band, vMin: 50_000, vMax: 50_000 };
  assert.equal(fractionAtRaise(flat, 5_000), 5_000 / 50_000);
  const quarter = fractionAtRaise(band, 2_500);
  const half = fractionAtRaise(band, 5_000);
  assert.ok(quarter > 0 && quarter < half && half < band.F);
});

test("fractionAt delegates to fractionAtRaise", () => {
  const pact = {
    valuation: { floor: band.vMin, ceiling: band.vMax, effectiveCap: band.cap },
    maxDilutionPct: band.F * 100,
    raise: { max: band.rmax },
  } as Pact;
  assert.equal(fractionAt(pact, 5_000), fractionAtRaise(band, 5_000));
});

test("costForUnits sums the linear curve", () => {
  const curve = { priceStart: 100n, priceSlope: 10n };
  // units 3,4: (100+3*10) + (100+4*10)
  assert.equal(costForUnits(curve, 3, 2), 270n);
  assert.equal(costForUnits(curve, 0, 0), 0n);
  assert.equal(costForUnits(null, 0, 5), 0n);
});

// The costs must mirror the contract's uint256 arithmetic bit-for-bit,
// including a budget that lands between whole-unit boundaries.
test("costForUnits and unitsForBudget mirror contract integer math", () => {
  const curve = { priceStart: 40000n, priceSlope: 100n };
  assert.equal(costForUnits(curve, 0, 110), 4999500n);
  assert.equal(costForUnits(curve, 110, 19), 986100n);
  // A 5_000000 budget floors to 110 whole units, leaving sub-unit dust.
  assert.equal(unitsForBudget(curve, 0, 200, 5000000n), 110);
});
