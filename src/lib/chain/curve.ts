// Bonding-curve math, shared by the create/buy/status pages and the onchain
// module. Prices are in USDC base units per whole Liquid Split unit; the
// contract sells unit `i` (zero-indexed) at `priceStart + priceSlope * i`.
// Base-unit amounts are bigint so the math mirrors the contract's uint256
// arithmetic exactly; only the valuation-band derivation (sqrt) and display
// conversions run in floats.
import { formatUnits } from "viem";

import { toUsdcBaseUnits, USDC_DECIMALS } from "#lib/chain/chain.ts";
import { TOTAL_LIQUID_SPLIT_UNITS } from "#lib/chain/liquid-split.ts";

// Contract curve parameters: USDC base units per whole unit.
export interface CurveParams {
  priceStart: bigint;
  priceSlope: bigint;
}

// The PACT document the create flow assembles (see buildPact in create.tsx).
export interface Pact {
  projectName: string;
  raise: { min: number; max: number };
  minimum: { deadlineDays: number; refundIfUnmet: string };
  issuerWallet: string | null;
  maximum: { reclaimUnsoldBy: string };
  maxDilutionPct: number;
  proceedsAddress: string;
  valuation: {
    effectiveCap: number;
    bandPct: number;
    floor: number;
    ceiling: number;
    curve: string;
  };
  totalTokens: number;
  holders: Array<{
    address: string;
    beforePct: number;
    afterPct: number;
    tokens: number;
    delivery: string;
  }>;
  newMoney: { afterPct: number; tokens: number; delivery: string };
  publicUnits: number;
}

// The subset of a Pact the curve derivation needs.
export interface PactCurveInputs {
  valuation: { floor: number; ceiling: number };
  newMoney: { tokens: number };
}

// The valuation band a raise fraction is computed against; the Pact-free
// shape the create form works with before a Pact document exists.
export interface ValuationBand {
  vMin: number;
  vMax: number;
  cap: number;
  F: number;
  rmax: number;
}

// fraction of the project sold once a cumulative $R has been raised along
// the curve — the inverse of the area under the linear price curve, the
// trickiest math in the repo, so it lives exactly once.
export function fractionAtRaise(band: ValuationBand, R: number): number {
  const { vMin, vMax, cap, F, rmax } = band;
  if (R <= 0) return 0;
  if (R >= rmax) return F;
  if (vMax === vMin) return Math.min(R / cap, F);
  const a = (vMax - vMin) / (2 * F);
  return Math.min((-vMin + Math.sqrt(vMin * vMin + 4 * a * R)) / (2 * a), F);
}

// Contract curve parameters derived from a valuation band. Returns null when
// the band or offering size is invalid.
export function deriveOfferingCurve(pact: PactCurveInputs): CurveParams | null {
  const floor = pact.valuation.floor;
  const ceiling = pact.valuation.ceiling;
  const offeringUnits = pact.newMoney.tokens;
  if (
    !(floor > 0) ||
    !(ceiling >= floor) ||
    !Number.isInteger(offeringUnits) ||
    offeringUnits <= 0
  )
    return null;
  const perUnitFloor =
    toUsdcBaseUnits(floor) / BigInt(TOTAL_LIQUID_SPLIT_UNITS);
  const priceStart = perUnitFloor > 1n ? perUnitFloor : 1n;
  const slopeRaw =
    (toUsdcBaseUnits(ceiling) - toUsdcBaseUnits(floor)) /
    BigInt(TOTAL_LIQUID_SPLIT_UNITS) /
    BigInt(offeringUnits);
  const priceSlope = ceiling > floor ? (slopeRaw > 1n ? slopeRaw : 1n) : 0n;
  return { priceStart, priceSlope };
}

// Total cost in USDC base units for `units` whole units starting after `sold`.
export function costForUnits(
  curve: CurveParams | null | undefined,
  sold: number,
  units: number,
): bigint {
  if (!curve || !Number.isInteger(units) || units <= 0) return 0n;
  const u = BigInt(units);
  return (
    u * curve.priceStart +
    curve.priceSlope * (BigInt(sold) * u + (u * (u - 1n)) / 2n)
  );
}

// Largest whole-unit purchase that fits within `budget` USDC base units.
export function unitsForBudget(
  curve: CurveParams,
  sold: number,
  remaining: number,
  budget: bigint,
): number {
  let units = 0;
  for (let candidate = 1; candidate <= remaining; candidate++) {
    if (costForUnits(curve, sold, candidate) > budget) break;
    units = candidate;
  }
  return units;
}

export function valuationForUnitIndex(
  curve: CurveParams | null | undefined,
  unitIndex: number,
  totalTokens: number,
): number {
  if (!curve) return 0;
  const price =
    curve.priceStart + curve.priceSlope * BigInt(Math.max(0, unitIndex));
  return Number(formatUnits(price * BigInt(totalTokens), USDC_DECIMALS));
}
