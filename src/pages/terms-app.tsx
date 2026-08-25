// The PACT document. Two modes:
//
//   /terms?offering=0x…            → reference template with blanks filled by
//                                    the offering's live state.
//   /terms?offering=0x…&tx=0x…     → executed certificate for one buyer's
//                                    purchase, with SAFE-style preamble and
//                                    static signature rows.
//
// With no offering the page renders the blank template.
import {
  offeringPhase,
  refundStatuses,
} from "@splits/pact-core/chain/offering-status.ts";
import {
  currentOfferingAddress,
  currentTxHash,
} from "@splits/pact-core/routes.ts";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";

import { AddressLink, Notice } from "#components/ui.tsx";
import { useOfferingState } from "#hooks/use-offering-state.ts";
import { listBought, listLifecycle } from "#lib/chain/offerings.ts";
import { getBlockTimestamp, getProjectName } from "#lib/chain/onchain.ts";
import { basescanTx, usdcBaseUnitsToDollars } from "#lib/format.ts";
import { deriveFilledTerms } from "#lib/terms-fields.ts";
import {
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

  // Only the executed mode needs Bought events, block timestamps, and (on a
  // failed round) lifecycle events. Enable those queries only when tx is set.
  const boughtQuery = useQuery({
    queryKey: ["bought", offeringAddress],
    enabled: !!offeringAddress && !!txHash,
    queryFn: () => listBought({ offering: offeringAddress! }),
  });
  const purchase = (boughtQuery.data || []).find(
    (p) => txHash && p.transactionHash.toLowerCase() === txHash.toLowerCase(),
  );

  const timestampQuery = useQuery({
    queryKey: ["block-ts", purchase?.blockNumber ?? null],
    enabled: !!purchase && purchase.blockNumber != null,
    queryFn: () => getBlockTimestamp(purchase!.blockNumber!),
    staleTime: Infinity,
  });
  const timestampMs = timestampQuery.data ? timestampQuery.data * 1000 : null;

  const phase =
    offering && offering.status === "loaded" ? offeringPhase(offering) : "live";
  const lifecycleQuery = useQuery({
    queryKey: ["lifecycle", offeringAddress],
    enabled: !!offeringAddress && !!txHash && phase === "failed",
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

  useEffect(() => {
    if (!projectName) return;
    document.title = txHash
      ? `${projectName} — Receipt | PACT`
      : `${projectName} | PACT`;
  }, [projectName]);

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

  const purchaseMissing =
    !!offeringAddress && !!txHash && !boughtQuery.isLoading && !purchase;

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
      <TermsHeading
        filled={filled}
        projectName={projectName}
        subtitle={
          !filled
            ? "Reference template — values are filled in for each offering."
            : undefined
        }
      />
      <TermsLoadNotice loading={loading} loadError={loadError} />
      {purchaseMissing ? (
        <Notice className="mb-6">
          Could not find a purchase in transaction {txHash!.slice(0, 10)}… on
          this offering.
        </Notice>
      ) : null}
      <TermsBody filled={filled} executed={executed} />
      {purchase ? (
        <>
          {refundNote ? <Notice className="mt-10">{refundNote}</Notice> : null}
          <SignatureRow address={purchase.buyer} role="Buyer" />
          {offering && offering.status === "loaded" ? (
            <SignatureRow address={offering.owner} role="Issuer" />
          ) : null}
          {purchase.transactionHash ? (
            <div className="signature-row signature-static-row">
              <div className="signature-inner">
                <span className="signature-by">Transaction:</span>
                <div className="signature-block">
                  <div className="signature-static">
                    <a
                      className="value-link"
                      href={basescanTx(purchase.transactionHash)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {purchase.transactionHash.slice(0, 10)}…
                      {purchase.transactionHash.slice(-8)}
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
