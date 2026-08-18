import assert from "node:assert/strict";

import { test } from "vitest";

import {
  costForUnits,
  deriveOfferingCurve,
  fractionAtRaise,
  unitsForBudget,
  valuationForUnitIndex,
} from "#lib/chain/curve.ts";

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

test("deriveOfferingCurve rejects invalid bands and unit counts", () => {
  const inputs = (floor: number, ceiling: number, tokens: number) => ({
    valuation: { floor, ceiling },
    newMoney: { tokens },
  });
  assert.equal(deriveOfferingCurve(inputs(0, 60000, 200)), null);
  assert.equal(deriveOfferingCurve(inputs(60000, 40000, 200)), null);
  assert.equal(deriveOfferingCurve(inputs(40000, 60000, 200.5)), null);
  assert.equal(deriveOfferingCurve(inputs(40000, 60000, 0)), null);
});

test("deriveOfferingCurve clamps dust prices to one base unit", () => {
  // A valuation so small the per-unit floor rounds to zero base units.
  const dust = deriveOfferingCurve({
    valuation: { floor: 0.0005, ceiling: 0.0005 },
    newMoney: { tokens: 200 },
  });
  assert.ok(dust);
  assert.equal(dust.priceStart, 1n);
  assert.equal(dust.priceSlope, 0n);
  // A rising band too narrow to yield a whole base unit of slope per unit.
  const narrow = deriveOfferingCurve({
    valuation: { floor: 100, ceiling: 100.001 },
    newMoney: { tokens: 200 },
  });
  assert.ok(narrow);
  assert.equal(narrow.priceStart, 100000n);
  assert.equal(narrow.priceSlope, 1n, "rising band never degrades to flat");
});

test("deriveOfferingCurve yields a flat curve when ceiling equals floor", () => {
  const flat = deriveOfferingCurve({
    valuation: { floor: 40000, ceiling: 40000 },
    newMoney: { tokens: 200 },
  });
  assert.ok(flat);
  assert.equal(flat.priceStart, 40000000n);
  assert.equal(flat.priceSlope, 0n);
});

test("valuationForUnitIndex maps curve prices back onto the valuation band", () => {
  assert.equal(valuationForUnitIndex(null, 5, 1000), 0);
  const curve = deriveOfferingCurve({
    valuation: { floor: 40000, ceiling: 60000 },
    newMoney: { tokens: 200 },
  });
  assert.ok(curve);
  assert.equal(valuationForUnitIndex(curve, 0, 1000), 40000);
  assert.equal(valuationForUnitIndex(curve, 200, 1000), 60000);
  assert.equal(
    valuationForUnitIndex(curve, -5, 1000),
    40000,
    "negative index clamps to the curve start",
  );
});

test("costForUnits returns zero for negative or fractional unit counts", () => {
  const curve = { priceStart: 100n, priceSlope: 10n };
  assert.equal(costForUnits(curve, 0, -3), 0n);
  assert.equal(costForUnits(curve, 0, 2.5), 0n);
});

test("unitsForBudget handles zero remaining, zero budget, and exact fits", () => {
  const curve = { priceStart: 100n, priceSlope: 0n };
  assert.equal(unitsForBudget(curve, 0, 0, 1000n), 0);
  assert.equal(unitsForBudget(curve, 0, 5, 0n), 0);
  // The comparison is strict `>`: a purchase costing exactly the budget fits.
  assert.equal(unitsForBudget(curve, 0, 5, 300n), 3);
});
