// Derives the numeric fields that fill in the PACT document from an offering's
// live onchain state. Kept out of the JSX-rendering module so fast-refresh
// stays clean (react(only-export-components)).
import {
  costForUnits,
  valuationForUnitIndex,
} from "@splits/pact-core/chain/curve.ts";
import { TOTAL_LIQUID_SPLIT_UNITS } from "@splits/pact-core/chain/liquid-split.ts";
import { offeringStateCurve } from "@splits/pact-core/chain/reads.ts";
import type { OfferingState } from "@splits/pact-core/chain/reads.ts";
import type { Address } from "viem";

import { usdcBaseUnitsToDollars } from "#lib/format.ts";

export interface FilledTerms {
  projectName: string;
  minUsd: number;
  maxUsd: number;
  dilutionPct: number;
  closeDateMs: number;
  treasury: Address;
  cap: number;
  floor: number;
  ceiling: number;
  discountPct: number;
}

// Same derivations the create form and status page use, applied to the live
// state. `remainingUnits + unitsSold` is the escrow's current inventory — the
// number the curve was priced for — which matches what the buy page displays.
export function deriveFilledTerms(
  state: OfferingState,
  projectName: string,
): FilledTerms {
  const curve = offeringStateCurve(state);
  const offeredUnits = state.remainingUnits + state.unitsSold;
  const maxUsd = usdcBaseUnitsToDollars(costForUnits(curve, 0, offeredUnits));
  const floor = valuationForUnitIndex(curve, 0, TOTAL_LIQUID_SPLIT_UNITS);
  const ceiling = valuationForUnitIndex(
    curve,
    offeredUnits,
    TOTAL_LIQUID_SPLIT_UNITS,
  );
  const cap = (floor + ceiling) / 2;
  const discountPct = cap > 0 ? ((cap - floor) / cap) * 100 : 0;
  return {
    projectName,
    minUsd: usdcBaseUnitsToDollars(state.raiseMin),
    maxUsd,
    dilutionPct: (offeredUnits / TOTAL_LIQUID_SPLIT_UNITS) * 100,
    closeDateMs: state.closeDate * 1000,
    treasury: state.treasury,
    cap,
    floor,
    ceiling,
    discountPct,
  };
}
