// Per-purchase receipt: the PACT document filled in with the offering's
// values AND this buyer's specific purchase woven into the preamble
// (SAFE-style). Route is /receipt?offering=0x…&tx=0x… — the tx hash uniquely
// identifies the purchase within an offering. The buyer's onchain address is
// their signature; the tx is its provenance.
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Address } from "viem";

import { AddressLink, Notice } from "#components/ui.tsx";
import { useOfferingState } from "#hooks/use-offering-state.ts";
import { offeringPhase, refundStatuses } from "#lib/chain/offering-status.ts";
import { listBought, listLifecycle } from "#lib/chain/offerings.ts";
import { getBlockTimestamp, getProjectName } from "#lib/chain/onchain.ts";
import { basescanTx, usdcBaseUnitsToDollars } from "#lib/format.ts";
import { currentOfferingAddress, currentTxHash } from "#lib/routes.ts";
import {
  deriveFilledTerms,
  TermsBody,
  TermsHeading,
  TermsLoadNotice,
} from "#pages/terms-body.tsx";
import type { ExecutedPurchase } from "#pages/terms-body.tsx";

const offeringAddress = currentOfferingAddress();
const txHash = currentTxHash();

function SignatureRow({ address, role }: { address: Address; role: string }) {
  return (
    <div className="signature-row signature-static-row">
      <div className="signature-inner">
        <span className="signature-by">{role}:</span>
        <div className="signature-block">
          <div className="signature-static">
            <AddressLink address={address} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ReceiptApp() {
  const { offering } = useOfferingState({ offeringAddress });

  const pactToken =
    offering && offering.status === "loaded" ? offering.pactToken : null;
  const projectName =
    useQuery({
      queryKey: ["project-name", pactToken],
      enabled: !!pactToken,
      queryFn: () => getProjectName({ pactToken: pactToken! }).catch(() => ""),
    }).data ?? null;

  useEffect(() => {
    if (projectName) document.title = `${projectName} — Receipt | PACT`;
  }, [projectName]);

  const boughtQuery = useQuery({
    queryKey: ["bought", offeringAddress],
    enabled: !!offeringAddress,
    queryFn: () => listBought({ offering: offeringAddress! }),
  });
  const purchase = (boughtQuery.data || []).find(
    (p) =>
      txHash && p.txHash && p.txHash.toLowerCase() === txHash.toLowerCase(),
  );

  const timestampQuery = useQuery({
    queryKey: ["block-ts", purchase?.blockNumber ?? null],
    enabled: !!purchase && purchase.blockNumber != null,
    queryFn: () => getBlockTimestamp(purchase!.blockNumber!),
    staleTime: Infinity,
  });
  const timestampMs = timestampQuery.data ? timestampQuery.data * 1000 : null;

  // Refund status only matters once the offering has ended in failure.
  const phase =
    offering && offering.status === "loaded" ? offeringPhase(offering) : "live";
  const lifecycleQuery = useQuery({
    queryKey: ["lifecycle", offeringAddress],
    enabled: !!offeringAddress && phase === "failed",
    queryFn: () => listLifecycle({ offering: offeringAddress! }),
  });
  const refundMap =
    phase === "failed" && purchase
      ? refundStatuses([purchase], lifecycleQuery.data || [])
      : null;
  const refundStatus =
    refundMap && purchase
      ? refundMap.get(purchase.buyer.toLowerCase())
      : undefined;

  const filled =
    offering && offering.status === "loaded"
      ? deriveFilledTerms(offering, projectName || "")
      : null;
  const executed: ExecutedPurchase | null = purchase
    ? {
        buyer: purchase.buyer,
        buyerName: purchase.buyerName || null,
        amountUsd: usdcBaseUnitsToDollars(purchase.cost),
        units: purchase.units,
        dateMs: timestampMs,
      }
    : null;

  const loading =
    !!offeringAddress && (!offering || offering.status === "loading");
  const loadError =
    offering && offering.status === "error" ? offering.error : null;

  const boughtLoading = boughtQuery.isLoading;
  const purchaseMissing =
    !!offeringAddress && !!txHash && !boughtLoading && !purchase;

  if (!offeringAddress || !txHash) {
    return (
      <>
        <TermsHeading filled={null} projectName={null} />
        <Notice className="mb-6">
          A receipt link needs both an offering address and a transaction hash.
        </Notice>
      </>
    );
  }

  const refundNote =
    refundStatus === "refunded"
      ? "This Purchase was refunded; the Buyer's Units have been returned to the Project."
      : refundStatus === "skipped"
        ? "A refund attempt was skipped; the Buyer may reclaim their Purchase Amount directly from the Project."
        : refundStatus === "pending"
          ? "The Buyer's refund is pending."
          : null;

  return (
    <>
      <TermsHeading filled={filled} projectName={projectName} />
      <TermsLoadNotice loading={loading} loadError={loadError} />
      {purchaseMissing ? (
        <Notice className="mb-6">
          Could not find a purchase in transaction {txHash.slice(0, 10)}… on
          this offering.
        </Notice>
      ) : null}
      <TermsBody filled={filled} omitCapitalization executed={executed} />
      {purchase ? (
        <>
          {refundNote ? <Notice className="mt-10">{refundNote}</Notice> : null}
          <SignatureRow address={purchase.buyer} role="Buyer" />
          {offering && offering.status === "loaded" ? (
            <SignatureRow address={offering.owner} role="Issuer" />
          ) : null}
          {purchase.txHash ? (
            <div className="signature-row signature-static-row">
              <div className="signature-inner">
                <span className="signature-by">Transaction:</span>
                <div className="signature-block">
                  <div className="signature-static">
                    <a
                      className="value-link"
                      href={basescanTx(purchase.txHash)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {purchase.txHash.slice(0, 10)}…{purchase.txHash.slice(-8)}
                    </a>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
