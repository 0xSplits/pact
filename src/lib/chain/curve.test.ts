import test from "node:test";
import assert from "node:assert/strict";
import { costForUnits, fractionAt, fractionAtRaise } from "./curve.ts";
import type { Pact } from "./curve.ts";

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
  const curve = { priceStart: 100, priceSlope: 10 };
  // units 3,4: (100+3*10) + (100+4*10)
  assert.equal(costForUnits(curve, 3, 2), 270);
  assert.equal(costForUnits(curve, 0, 0), 0);
  assert.equal(costForUnits(null, 0, 5), 0);
});
