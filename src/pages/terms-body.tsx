// Shared body of the PACT document, rendered by /terms in two modes: a
// reference template when the page has no `tx` param, and an executed
// certificate for a specific buyer when it does.
import type { ReactNode } from "react";
import type { Address } from "viem";

import { AddressLink, Notice, SectionTitle } from "#components/ui.tsx";
import { costForUnits, valuationForUnitIndex } from "#lib/chain/curve.ts";
import { TOTAL_LIQUID_SPLIT_UNITS } from "#lib/chain/liquid-split.ts";
import { offeringStateCurve } from "#lib/chain/onchain.ts";
import type { OfferingState } from "#lib/chain/onchain.ts";
import {
  fmtDate,
  fmtPct,
  fmtUsd,
  usdcBaseUnitsToDollars,
} from "#lib/format.ts";
import { UNITS_DISCLAIMER } from "#pages/pact-copy.tsx";

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

function Placeholder({ label }: { label: string }) {
  return <span className="t-muted italic">[{label}]</span>;
}

function Filled({ children }: { children: ReactNode }) {
  return <span className="font-bold">{children}</span>;
}

export function TermsHeading({
  filled,
  projectName,
  title = "Purchase Agreement for Community Tokens",
  subtitle,
}: {
  filled: FilledTerms | null;
  projectName: string | null;
  title?: string;
  subtitle?: ReactNode;
}) {
  return (
    <div className="mb-10 text-center">
      {filled ? (
        <p className="text-2xl font-bold mb-2">
          {projectName || "PACT offering"}
        </p>
      ) : null}
      <h1 className="text-2xl font-bold uppercase tracking-wide">{title}</h1>
      {subtitle ? <p className="text-sm t-muted mt-2">{subtitle}</p> : null}
    </div>
  );
}

export function TermsLoadNotice({
  loading,
  loadError,
}: {
  loading: boolean;
  loadError: string | null;
}) {
  if (loadError)
    return (
      <Notice className="mb-6">
        Could not read this offering from Base. Showing the blank template
        instead. ({loadError})
      </Notice>
    );
  if (loading) return <Notice className="mb-6">Loading offering…</Notice>;
  return null;
}

// The particulars of a specific buyer's purchase, woven into the executed
// preamble when present. Swaps the opening paragraph from a generic template
// ("shall issue…") to a SAFE-style certificate ("in exchange for the payment
// by X of $Y on [date], the Project has issued to the Buyer N Units…").
export interface ExecutedPurchase {
  buyer: Address;
  buyerName: string | null;
  amountUsd: number;
  units: number;
  dateMs: number | null;
}

// The doctrinal body of the PACT — everything after the header. Rendered with
// blanks when `filled` is null, and with the offering's numbers otherwise.
// `executed`: swaps the preamble for the filled-in certificate form when the
// document is a receipt for a specific purchase.
export function TermsBody({
  filled,
  executed = null,
}: {
  filled: FilledTerms | null;
  executed?: ExecutedPurchase | null;
}) {
  const nameField = filled?.projectName ? (
    <Filled>{filled.projectName}</Filled>
  ) : filled ? (
    <span className="t-muted italic">Unnamed project</span>
  ) : (
    <Placeholder label="Project Name" />
  );
  const minField = filled ? (
    <Filled>{fmtUsd(filled.minUsd, "cents").replace(/^\$/, "")}</Filled>
  ) : (
    <Placeholder label="Minimum" />
  );
  const maxField = filled ? (
    <Filled>{fmtUsd(filled.maxUsd, "cents").replace(/^\$/, "")}</Filled>
  ) : (
    <Placeholder label="Maximum" />
  );
  const dilutionField = filled ? (
    <Filled>{fmtPct(filled.dilutionPct)}</Filled>
  ) : (
    <>
      <Placeholder label="Dilution" />%
    </>
  );
  const closeField = filled ? (
    <Filled>{fmtDate(filled.closeDateMs)}</Filled>
  ) : (
    <Placeholder label="Close Date" />
  );
  const treasuryField = filled ? (
    <AddressLink address={filled.treasury} />
  ) : (
    <Placeholder label="Treasury Address" />
  );
  const capField = filled ? (
    <Filled>{fmtUsd(filled.cap, "whole").replace(/^\$/, "")}</Filled>
  ) : (
    <Placeholder label="Effective Cap" />
  );
  const discountField = filled ? (
    <Filled>{fmtPct(filled.discountPct)}</Filled>
  ) : (
    <>
      <Placeholder label="Discount" />%
    </>
  );
  const floorField = filled ? (
    <Filled>{fmtUsd(filled.floor, "whole").replace(/^\$/, "")}</Filled>
  ) : (
    <Placeholder label="Floor" />
  );
  const ceilingField = filled ? (
    <Filled>{fmtUsd(filled.ceiling, "whole").replace(/^\$/, "")}</Filled>
  ) : (
    <Placeholder label="Ceiling" />
  );

  return (
    <>
      <p className="text-sm uppercase text-justify mb-9">{UNITS_DISCLAIMER}</p>

      {executed ? (
        <p className="mb-9 text-justify">
          This Purchase Agreement for Community Tokens (this &ldquo;PACT&rdquo;)
          certifies that {nameField} (the &ldquo;Project&rdquo;) has issued to{" "}
          {executed.buyerName ? (
            <>
              <Filled>{executed.buyerName}</Filled> (
              <AddressLink address={executed.buyer} />)
            </>
          ) : (
            <Filled>
              <AddressLink address={executed.buyer} />
            </Filled>
          )}{" "}
          (the &ldquo;Buyer&rdquo;){" "}
          <Filled>{executed.units.toLocaleString("en-US")}</Filled> community
          units (the &ldquo;Units&rdquo;) in consideration of the Buyer&rsquo;s
          payment of <Filled>{fmtUsd(executed.amountUsd, "cents")}</Filled> (the
          &ldquo;Purchase Amount&rdquo;)
          {executed.dateMs ? (
            <>
              {" "}
              on <Filled>{fmtDate(executed.dateMs)}</Filled>
            </>
          ) : null}
          , upon and subject to the terms set forth herein.
        </p>
      ) : (
        <p className="mb-9 text-justify">
          This Purchase Agreement for Community Tokens (this &ldquo;PACT&rdquo;)
          certifies that {nameField} (the &ldquo;Project&rdquo;) shall issue
          community units (the &ldquo;Units&rdquo;) to those who buy into the
          Offering described below, upon and subject to the terms set forth
          herein.
        </p>
      )}

      <SectionTitle>&sect;1. The Offering</SectionTitle>
      <p className="mb-4 text-justify">
        The Project intends to raise no less than ${minField} (the
        &ldquo;Minimum&rdquo;) and no more than ${maxField} (the
        &ldquo;Maximum&rdquo;) of new capital and, in consideration thereof,
        shall make available for purchase no more than {dilutionField} of the
        Units (the &ldquo;Offering&rdquo;). Should the Maximum not be met, any
        unsold Units may be reclaimed solely by the Treasury.
      </p>
      <p className="mb-9 pl-4 text-justify">
        <span className="font-bold">(a) Close Date.</span>{" "}
        {filled ? (
          <>
            Should the Minimum not be met by {closeField} (the &ldquo;Close
            Date&rdquo;), buyers shall be entitled to burn their Units and
            reclaim the full amount of their purchase.
          </>
        ) : (
          <>
            Should the Minimum not be met by {closeField} (the &ldquo;Close
            Date&rdquo;), set at issuance, buyers shall be entitled to burn
            their Units and reclaim the full amount of their purchase.
          </>
        )}
      </p>

      <SectionTitle>&sect;2. Use of Proceeds</SectionTitle>
      <p className="mb-9 text-justify">
        The net proceeds of the Offering shall be delivered to the
        Project&rsquo;s treasury account (the &ldquo;Treasury&rdquo;) at{" "}
        {treasuryField}.
      </p>

      <SectionTitle>&sect;3. Resulting Terms</SectionTitle>
      <p className="mb-4 text-justify">
        Accordingly, upon full subscription the effective post-money valuation
        shall be ${capField}.
      </p>
      <p className="mb-9 pl-4 text-justify">
        <span className="font-bold">(a) Discount.</span> The earliest
        subscriptions shall be priced at a {discountField} discount to the
        effective post-money valuation. Thereafter, pricing shall progress
        linearly along the Curve, beginning at a floor of ${floorField} and
        reaching a ceiling of ${ceilingField}, an equivalent premium at full
        subscription.
      </p>
    </>
  );
}
