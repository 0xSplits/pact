import assert from "node:assert/strict";

import { getAddress } from "viem";
import { test } from "vitest";

import { toUsdcBaseUnits } from "#lib/chain/chain.ts";
import {
  costForUnits,
  deriveOfferingCurve,
  unitsForBudget,
} from "#lib/chain/curve.ts";
import { buildOfferingFactoryInputs } from "#lib/chain/liquid-split.ts";

const addr = (n: number) => "0x" + String(n).padStart(40, "0");

test("builds sorted factory inputs without needing the future offering address", () => {
  const result = buildOfferingFactoryInputs({
    holders: [
      { address: addr(3), tokens: 300 },
      { address: addr(1), tokens: 500 },
    ],
    newMoney: { tokens: 200 },
  });

  assert.deepEqual(result.holderAccounts, [addr(1), addr(3)]);
  assert.deepEqual(result.holderAllocations, [500, 300]);
  assert.equal(result.offeringUnits, 200);
});

test("aggregates duplicate recipients before deploying", () => {
  const result = buildOfferingFactoryInputs({
    holders: [
      { address: addr(1), tokens: 300 },
      { address: addr(1).toUpperCase().replace("X", "x"), tokens: 500 },
    ],
    newMoney: { tokens: 200 },
  });

  assert.deepEqual(result.holderAccounts, [addr(1)]);
  assert.deepEqual(result.holderAllocations, [800]);
  assert.equal(result.offeringUnits, 200);
});

test("rejects allocations that do not total one thousand units", () => {
  assert.throws(
    () =>
      buildOfferingFactoryInputs({
        holders: [{ address: addr(1), tokens: 700 }],
        newMoney: { tokens: 200 },
      }),
    /total 1,000/,
  );
});

test("rejects invalid holder addresses", () => {
  assert.throws(
    () =>
      buildOfferingFactoryInputs({
        holders: [{ address: "nope", tokens: 800 }],
        newMoney: { tokens: 200 },
      }),
    /invalid/i,
  );
});

test("checksums holder accounts", () => {
  const lower = "0x" + "ab".repeat(20);
  const result = buildOfferingFactoryInputs({
    holders: [{ address: lower, tokens: 800 }],
    newMoney: { tokens: 200 },
  });
  assert.deepEqual(result.holderAccounts, [getAddress(lower)]);
});

test("rejects fractional and negative holder tokens", () => {
  const build = (tokens: number) =>
    buildOfferingFactoryInputs({
      holders: [{ address: addr(1), tokens }],
      newMoney: { tokens: 200 },
    });
  assert.throws(() => build(1.5), /whole token units/);
  assert.throws(() => build(-5), /whole token units/);
});

test("skips zero-token holders", () => {
  const result = buildOfferingFactoryInputs({
    holders: [
      { address: addr(1), tokens: 800 },
      { address: addr(2), tokens: 0 },
    ],
    newMoney: { tokens: 200 },
  });
  assert.deepEqual(result.holderAccounts, [addr(1)]);
  assert.deepEqual(result.holderAllocations, [800]);
});

test("rejects a missing pact and non-positive or fractional offering units", () => {
  assert.throws(
    () => buildOfferingFactoryInputs(null as never),
    /PACT is required/,
  );
  const build = (tokens: number) =>
    buildOfferingFactoryInputs({
      holders: [{ address: addr(1), tokens: 800 }],
      newMoney: { tokens },
    });
  assert.throws(() => build(0), /positive whole number/);
  assert.throws(() => build(10.5), /positive whole number/);
});

// Guard-ordering quirk pinned as-is: with no holders the total check runs
// first, so a partial offering reports the misleading "total 1,000" error;
// the holder-count error only surfaces when the offering alone totals 1,000.
test("zero holders trips the total check before the holder-count check", () => {
  const build = (tokens: number) =>
    buildOfferingFactoryInputs({ holders: [], newMoney: { tokens } });
  assert.throws(() => build(200), /total 1,000/);
  assert.throws(() => build(1000), /at least one holder/);
});

test("derives conservative USDC curve params", () => {
  const result = deriveOfferingCurve({
    valuation: { floor: 40000, ceiling: 60000 },
    newMoney: { tokens: 200 },
  });

  assert.ok(result);
  assert.equal(result.priceStart, 40000000n);
  assert.equal(result.priceSlope, 100000n);
  // parseUnits rounds half-away-from-zero past six decimals; float dollars
  // with sub-base-unit noise never truncate a base unit away.
  assert.equal(toUsdcBaseUnits(123.4567899), 123456790n);
  assert.equal(toUsdcBaseUnits(2.01), 2010000n);
  assert.equal(toUsdcBaseUnits(4.2), 4200000n);
});

test("quotes whole units within a USDC budget along the curve", () => {
  const curve = { priceStart: 40000000n, priceSlope: 100000n };
  const units = unitsForBudget(curve, 50, 150, 1500000000n);
  assert.equal(units, 32);
  assert.ok(costForUnits(curve, 50, units) <= 1500000000n);
  assert.ok(costForUnits(curve, 50, units + 1) > 1500000000n);
  assert.equal(unitsForBudget(curve, 0, 150, 1000n), 0);
});
