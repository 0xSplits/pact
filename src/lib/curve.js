// Bonding-curve math, shared by the create/buy/status pages and the onchain
// module. Prices are in USDC base units per whole Liquid Split unit; the
// contract sells unit `i` (zero-indexed) at `priceStart + priceSlope * i`.
import { USDC_SCALE } from './chain.js';
import { TOTAL_LIQUID_SPLIT_UNITS } from './liquid-split.js';

// fraction of the project sold once a cumulative $R has been raised along the curve
export function fractionAt(pact, R) {
  const cap = pact.valuation.effectiveCap, vMin = pact.valuation.floor, vMax = pact.valuation.ceiling;
  const F = pact.maxDilutionPct / 100, rmax = pact.raise.max;
  if (R <= 0) return 0;
  if (R >= rmax) return F;
  if (vMax === vMin) return Math.min(R / cap, F);
  const a = (vMax - vMin) / (2 * F);
  return Math.min((-vMin + Math.sqrt(vMin * vMin + 4 * a * R)) / (2 * a), F);
}

export const tokensBetween = (pact, R0, R1) => (fractionAt(pact, R1) - fractionAt(pact, R0)) * pact.totalTokens;

// Contract curve parameters derived from a valuation band. Returns null when
// the band or offering size is invalid.
export function deriveOfferingCurve(pact) {
  const floor = Number(pact && pact.valuation && pact.valuation.floor);
  const ceiling = Number(pact && pact.valuation && pact.valuation.ceiling);
  const offeringUnits = Number(pact && pact.newMoney && pact.newMoney.tokens);
  if (!(floor > 0) || !(ceiling >= floor) || !(offeringUnits > 0)) return null;
  const priceStart = Math.max(1, Math.floor(floor * USDC_SCALE / TOTAL_LIQUID_SPLIT_UNITS));
  const slopeRaw = Math.floor((ceiling - floor) * USDC_SCALE / TOTAL_LIQUID_SPLIT_UNITS / offeringUnits);
  const priceSlope = ceiling > floor ? Math.max(1, slopeRaw) : 0;
  return { priceStart, priceSlope };
}

// Curve parameters for an existing PACT: what the contract was deployed with,
// falling back to re-deriving them from the stored valuation band.
export function offeringCurveParams(pact) {
  if (pact && pact.curveParams && Number(pact.curveParams.priceStart) > 0) return pact.curveParams;
  return deriveOfferingCurve(pact);
}

// Total cost in USDC base units for `units` whole units starting after `sold`.
export function costForUnits(curve, sold, units) {
  if (!curve || !(units > 0)) return 0;
  return units * Number(curve.priceStart || 0) + Number(curve.priceSlope || 0) * (sold * units + (units * (units - 1)) / 2);
}

// Largest whole-unit purchase that fits within `budget` USDC base units.
export function unitsForBudget(curve, sold, remaining, budget) {
  let units = 0;
  for (let candidate = 1; candidate <= remaining; candidate++) {
    if (costForUnits(curve, sold, candidate) > budget) break;
    units = candidate;
  }
  return units;
}

export function valuationForUnitIndex(curve, unitIndex, totalTokens) {
  if (!curve) return 0;
  const price = Number(curve.priceStart || 0) + Number(curve.priceSlope || 0) * Math.max(0, Number(unitIndex || 0));
  return price * Number(totalTokens || 0) / USDC_SCALE;
}
