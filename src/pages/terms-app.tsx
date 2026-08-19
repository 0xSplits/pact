// Reference copy of the PACT template. With no ?offering= param, renders the
// blank template with bracketed placeholders. With one, loads the offering's
// live state and fills each blank so buyers can inspect the exact document
// they are agreeing to. The cap-table exhibit and curve chart are omitted —
// they belong on the status page.
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ReactNode } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";

import { AddressLink, Notice, SectionTitle } from "#components/ui.tsx";
import { useOfferingState } from "#hooks/use-offering-state.ts";
import { costForUnits, valuationForUnitIndex } from "#lib/chain/curve.ts";
import { TOTAL_LIQUID_SPLIT_UNITS } from "#lib/chain/liquid-split.ts";
import { getProjectName, offeringStateCurve } from "#lib/chain/onchain.ts";
import type { OfferingState } from "#lib/chain/onchain.ts";
import {
  fmtDate,
  fmtPct,
  fmtUsd,
  usdcBaseUnitsToDollars,
} from "#lib/format.ts";
import { currentOfferingAddress } from "#lib/routes.ts";

const offeringAddress = currentOfferingAddress();

interface FilledTerms {
  projectName: string;
  minUsd: number;
  maxUsd: number;
  dilutionPct: number;
  closeDateMs: number;
  publicPct: number;
  treasury: Address;
  cap: number;
  floor: number;
  ceiling: number;
  discountPct: number;
}

// Same derivations the create form and status page use, applied to the live
// state. `remainingUnits + unitsSold` is the escrow's current inventory — the
// number the curve was priced for — which matches what the buy page displays.
function deriveFilledTerms(
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
    publicPct: offeredUnits > 0 ? (state.publicUnits / offeredUnits) * 100 : 0,
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

export function TermsApp() {
  const wallet = useAccount().address ?? null;
  const { offering } = useOfferingState({
    offeringAddress,
    buyer: wallet,
  });
  const pactToken =
    offering && offering.status === "loaded" ? offering.pactToken : null;
  const projectName =
    useQuery({
      queryKey: ["project-name", pactToken],
      enabled: !!pactToken,
      queryFn: () => getProjectName({ pactToken: pactToken! }).catch(() => ""),
    }).data ?? null;

  useEffect(() => {
    if (projectName) document.title = `${projectName} | PACT`;
  }, [projectName]);

  const filled: FilledTerms | null =
    offering && offering.status === "loaded"
      ? deriveFilledTerms(offering, projectName || "")
      : null;

  const loading =
    !!offeringAddress && (!offering || offering.status === "loading");
  const loadError =
    offering && offering.status === "error" ? offering.error : null;

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
  const publicField = filled ? (
    <Filled>{fmtPct(filled.publicPct)}</Filled>
  ) : (
    <>
      <Placeholder label="Public" />%
    </>
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
      <div className="mb-10 text-center">
        {filled ? (
          <p className="text-2xl font-bold mb-2">
            {projectName || "PACT offering"}
          </p>
        ) : null}
        <h1 className="text-2xl font-bold uppercase tracking-wide">
          Purchase Agreement for Community Tokens
        </h1>
        {!filled ? (
          <p className="text-sm t-muted mt-2">
            Reference template — values are filled in for each offering.
          </p>
        ) : null}
      </div>

      {loadError ? (
        <Notice className="mb-6">
          Could not read this offering from Base. Showing the blank template
          instead. ({loadError})
        </Notice>
      ) : loading ? (
        <Notice className="mb-6">Loading offering…</Notice>
      ) : null}

      <p className="text-sm uppercase text-justify mb-9">
        The Units issued pursuant to this instrument confer no legal rights, but
        may participate in the Project&rsquo;s future value as its creator
        expressly provides. They exist solely to align their holders with the
        Project, and it is for the creator to determine what, if anything, the
        Units are used for.
      </p>

      <p className="mb-9 text-justify">
        This Purchase Agreement for Community Tokens (this &ldquo;PACT&rdquo;)
        certifies that {nameField} (the &ldquo;Project&rdquo;) shall issue
        community units (the &ldquo;Units&rdquo;) to those who buy into the
        Offering described below, upon and subject to the terms set forth
        herein.
      </p>

      <SectionTitle>&sect;1. The Offering</SectionTitle>
      <p className="mb-4 text-justify">
        The Project intends to raise no less than ${minField} (the
        &ldquo;Minimum&rdquo;) and no more than ${maxField} (the
        &ldquo;Maximum&rdquo;) of new capital and, in consideration thereof,
        shall make available for purchase no more than {dilutionField} of the
        Units (the &ldquo;Offering&rdquo;). Should the Maximum not be met, any
        unsold Units may be reclaimed solely by the Treasury.
      </p>
      <p className="mb-4 pl-4 text-justify">
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
      <p className="mb-9 pl-4 text-justify">
        <span className="font-bold">(b) Public Portion.</span> Up to{" "}
        {publicField} of the Offering shall be purchasable publicly; the
        remainder shall be reserved for private allocations.
      </p>

      <SectionTitle>&sect;2. Use of Proceeds</SectionTitle>
      <p className="mb-9 text-justify">
        The net proceeds of the Offering shall be delivered to the
        Project&rsquo;s treasury account (the &ldquo;Treasury&rdquo;) at{" "}
        {treasuryField}.
      </p>

      <SectionTitle>&sect;3. Capitalization</SectionTitle>
      <p className="mb-4 text-justify">
        The capital structure of the Project, before and after the Offering, is
        set forth in an exhibit fixed at issuance, listing each holder&rsquo;s
        wallet, pre-Offering percentage, post-Offering percentage, and Unit
        count, together with the Units reserved for the Offering itself. Upon
        issuance, each holder receives their Units directly in their wallet(s),
        as defined in the exhibit.
      </p>

      <SectionTitle>&sect;4. Resulting Terms</SectionTitle>
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
