import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOfferingFactoryInputs } from '../src/lib/liquid-split.js';
import { deriveOfferingCurve, costForUnits, unitsForBudget } from '../src/lib/curve.js';
import { toUsdcBaseUnits } from '../src/lib/chain.js';

const addr = n => '0x' + String(n).padStart(40, '0');

test('builds sorted factory inputs without needing the future offering address', () => {
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

test('aggregates duplicate recipients before deploying', () => {
  const result = buildOfferingFactoryInputs({
    holders: [
      { address: addr(1), tokens: 300 },
      { address: addr(1).toUpperCase().replace('X', 'x'), tokens: 500 },
    ],
    newMoney: { tokens: 200 },
  });

  assert.deepEqual(result.holderAccounts, [addr(1)]);
  assert.deepEqual(result.holderAllocations, [800]);
  assert.equal(result.offeringUnits, 200);
});

test('rejects allocations that do not total one thousand units', () => {
  assert.throws(() => buildOfferingFactoryInputs({
    holders: [{ address: addr(1), tokens: 700 }],
    newMoney: { tokens: 200 },
  }), /total 1,000/);
});

test('derives conservative USDC curve params', () => {
  const result = deriveOfferingCurve({
    valuation: { floor: 40000, ceiling: 60000 },
    newMoney: { tokens: 200 },
  });

  assert.equal(result.priceStart, 40000000);
  assert.equal(result.priceSlope, 100000);
  assert.equal(toUsdcBaseUnits(123.4567899), 123456789);
});

test('quotes whole units within a USDC budget along the curve', () => {
  const curve = { priceStart: 40000000, priceSlope: 100000 };
  const units = unitsForBudget(curve, 50, 150, 1500000000);
  assert.equal(units, 32);
  assert.ok(costForUnits(curve, 50, units) <= 1500000000);
  assert.ok(costForUnits(curve, 50, units + 1) > 1500000000);
  assert.equal(unitsForBudget(curve, 0, 150, 1000), 0);
});
