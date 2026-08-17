import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { showToast } from "../lib/ui/toast.ts";
import { mountPage } from "../components/wallet.tsx";
import { useWallet } from "../hooks/use-wallet.ts";
import { useOfferingState } from "../hooks/use-offering-state.ts";
import {
  fmtUsd,
  fmtPct,
  fmtTokens,
  fmtDate,
  relDays,
  usdcBaseUnitsToDollars,
  basescanTx,
  errMsg,
  MS_PER_DAY,
} from "../lib/format.ts";
import {
  costForUnits,
  unitsForBudget,
  valuationForUnitIndex,
} from "../lib/chain/curve.ts";
import { TOTAL_LIQUID_SPLIT_UNITS } from "../lib/chain/liquid-split.ts";
import { isSameAddress } from "../lib/validate.ts";
import { debugActive } from "../lib/ui/debug-menu.ts";
import { useDebugMenu } from "../hooks/use-debug-menu.ts";
import {
  currentOfferingAddress,
  currentVoucherFragment,
} from "../lib/routes.ts";
import {
  availablePublicUnits,
  quotePublicPurchase,
  getProjectName,
  isAllocationConsumed,
  buyPublicOffering,
  buyPrivateOffering,
  offeringStateCurve,
  refundOffering,
} from "../lib/chain/onchain.ts";
import type { OfferingState } from "../lib/chain/onchain.ts";
import type { DecodedVoucherLink } from "../lib/chain/voucher.ts";
import { listBought } from "../lib/chain/offerings.ts";
import { decodeVoucherFragment } from "../lib/chain/voucher.ts";
import {
  AddressLink,
  Button,
  CheckIcon,
  DefList,
  Field,
  Notice,
  SectionTitle,
  Sub,
} from "../components/ui.tsx";
import "./buy.css";

const TOTAL_TOKENS = TOTAL_LIQUID_SPLIT_UNITS;
const offeringAddress = currentOfferingAddress();
const fragment = currentVoucherFragment();

function parseFragment(): {
  voucher: DecodedVoucherLink | null;
  voucherError: string;
} {
  if (!fragment) return { voucher: null, voucherError: "" };
  try {
    return { voucher: decodeVoucherFragment(fragment), voucherError: "" };
  } catch (err) {
    return {
      voucher: null,
      voucherError:
        "This allocation link is malformed or from an older version. Ask the issuer for a fresh link.",
    };
  }
}
const { voucher: voucherPayload, voucherError } = parseFragment();

// The offering fields the page renders. Debug snapshots synthesize them
// without an address/owner/treasury; live reads carry the full state.
type OfferingView = Omit<
  OfferingState,
  "offeringAddress" | "owner" | "treasury" | "pactToken"
> &
  Partial<
    Pick<OfferingState, "offeringAddress" | "owner" | "treasury" | "pactToken">
  >;

function debugOfferingSnapshot(
  live: OfferingView | null,
  debugState: string,
): OfferingView | null {
  if (!debugActive(debugState)) return live;
  const base = {
    remainingUnits: 150,
    unitsSold: 50,
    minMet: false,
    state: 0,
    raised: 55_000000,
    withdrawn: 0,
    raiseMin: 100_000000,
    closeDate: Math.floor((Date.now() + 7 * MS_PER_DAY) / 1000),
    priceStart: 1_000000,
    priceSlope: 1000,
    publicUnits: 100,
    publicUnitsSold: 20,
    deposit: 0,
    ...(live || {}),
  };
  if (debugState === "funding") return { ...base, state: 0, minMet: false };
  if (debugState === "failed")
    return {
      ...base,
      state: 1,
      minMet: false,
      closeDate: Math.floor((Date.now() - MS_PER_DAY) / 1000),
      deposit: 25_000000,
    };
  if (debugState === "refunded")
    return {
      ...base,
      state: 1,
      minMet: false,
      closeDate: Math.floor((Date.now() - MS_PER_DAY) / 1000),
      deposit: 0,
    };
  if (debugState === "closed") return { ...base, state: 2, minMet: true };
  return live;
}

// Everything the page renders, derived from one offering snapshot. Pure so
// the JSX below stays scannable.
function deriveBuyView({
  offeringState,
  receipt,
  wallet,
  units,
  consumed,
  debugState,
}: {
  offeringState: OfferingView;
  receipt: { units: number; cost: number; txHash: string | null } | null;
  wallet: string | null;
  units: string;
  consumed: boolean | null;
  debugState: string;
}) {
  const curve = offeringStateCurve(offeringState);
  const closeDate = offeringState.closeDate * 1000;
  const offeringFailed = offeringState.state === 1;
  const raiseClosed =
    offeringFailed ||
    offeringState.state === 2 ||
    (offeringState.state === 0 &&
      Date.now() > closeDate &&
      !offeringState.minMet);
  const debugRefunded = debugState === "refunded";
  const raisedTotal = usdcBaseUnitsToDollars(offeringState.raised);
  const remainingUnits = offeringState.remainingUnits;
  const publicRemaining = availablePublicUnits(offeringState);
  const remainingCapacity = usdcBaseUnitsToDollars(
    costForUnits(curve, offeringState.unitsSold, remainingUnits),
  );
  const raiseCapacity = Math.max(
    raisedTotal + remainingCapacity,
    usdcBaseUnitsToDollars(offeringState.raiseMin),
    raisedTotal,
  );
  const valuationStart = valuationForUnitIndex(curve, 0, TOTAL_TOKENS);
  const valuationEnd = valuationForUnitIndex(
    curve,
    offeringState.unitsSold + remainingUnits,
    TOTAL_TOKENS,
  );
  const minUsd = usdcBaseUnitsToDollars(offeringState.raiseMin);

  const isPaid =
    !!receipt || (debugActive(debugState) && (offeringState.deposit || 0) > 0);
  const paidUnits = receipt ? receipt.units : 0;
  const paidCostUsd = usdcBaseUnitsToDollars(
    receipt ? receipt.cost : offeringState.deposit || 0,
  );
  const pricePer = paidUnits > 0 ? paidCostUsd / paidUnits : 0;

  // Quote for what the buyer is about to purchase.
  const budgetUsdc = voucherPayload
    ? Number(voucherPayload.voucher.amountCapUsdc)
    : 0;
  const requestedPublicUnits = Number(units) || 0;
  const publicUnitsValid =
    Number.isInteger(requestedPublicUnits) &&
    requestedPublicUnits >= 1 &&
    requestedPublicUnits <= publicRemaining;
  const quoteUnits = voucherPayload
    ? budgetUsdc > 0
      ? unitsForBudget(
          curve,
          offeringState.unitsSold,
          remainingUnits,
          budgetUsdc,
        )
      : 0
    : publicUnitsValid
      ? requestedPublicUnits
      : 0;
  const quoteCost = usdcBaseUnitsToDollars(
    costForUnits(curve, offeringState.unitsSold, quoteUnits),
  );
  const quotePricePer = quoteUnits > 0 ? quoteCost / quoteUnits : 0;

  const claimedByOther = !!voucherPayload && !!consumed && !isPaid;
  const refundableDeposit =
    offeringFailed && wallet && (offeringState.deposit || 0) > 0
      ? usdcBaseUnitsToDollars(offeringState.deposit)
      : 0;
  const canStillPurchase =
    !isPaid &&
    !claimedByOther &&
    !raiseClosed &&
    (!!voucherPayload || publicRemaining > 0);

  return {
    closeDate,
    offeringFailed,
    raiseClosed,
    debugRefunded,
    offeringIsPrivate: offeringState.publicUnits === 0,
    publicRemaining,
    raiseCapacity,
    valuationStart,
    valuationEnd,
    minUsd,
    isPaid,
    paidUnits,
    paidCostUsd,
    pricePer,
    budgetUsdc,
    requestedPublicUnits,
    quoteUnits,
    quoteCost,
    quotePricePer,
    claimedByOther,
    refundableDeposit,
    canStillPurchase,
  };
}

function PageNotice({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Notice className="mb-8">
      <div className="font-bold mb-1">{title}</div>
      <div className="t-muted text-sm">{children}</div>
    </Notice>
  );
}

// Filled status dot for purchase/refund states: check mark, or an
// exclamation while a refund is still claimable.
function StatusDot({ refundable = false }) {
  return (
    <span
      className={`status-dot${refundable ? " refundable" : ""}`}
      aria-hidden="true"
    >
      {refundable ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 7v6" />
          <path d="M12 17h.01" />
        </svg>
      ) : (
        <CheckIcon />
      )}
    </span>
  );
}

function BuyApp() {
  const [receipt, setReceipt] = useState<{
    units: number;
    cost: number;
    txHash: string | null;
  } | null>(null); // for the connected wallet
  const [units, setUnits] = useState("");
  const [publicQuote, setPublicQuote] = useState<{
    units: number;
    costUsd: number;
  } | null>(null);
  const [publicQuoteLoading, setPublicQuoteLoading] = useState(false);
  const publicQuoteSeq = useRef(0);
  const [buyerName, setBuyerName] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [signerNameError, setSignerNameError] = useState("");
  const [busy, setBusy] = useState<"refund" | "pay" | null>(null);
  const [debugPreview, setDebugPreview] = useState(false);
  const recoveringRef = useRef(false);

  const debugState = useDebugMenu([
    { value: "live", label: "Live" },
    { value: "funding", label: "Funding" },
    { value: "failed", label: "Failed" },
    { value: "refunded", label: "Refunded" },
    { value: "closed", label: "Closed" },
  ]);

  const wallet = useWallet();
  const queryClient = useQueryClient();
  const { offering, refresh: refreshOffering } = useOfferingState({
    offeringAddress,
    buyer: wallet,
  });

  const pactToken =
    offering && offering.status === "loaded" ? offering.pactToken : null;
  const projectName =
    useQuery({
      queryKey: ["project-name", pactToken],
      enabled: !!pactToken,
      // A failed read degrades to the generic heading, matching the old catch.
      queryFn: () => getProjectName({ pactToken: pactToken! }).catch(() => ""),
    }).data ?? null;

  useEffect(() => {
    if (projectName) document.title = `${projectName} | PACT`;
  }, [projectName]);

  // Voucher mode: check whether the allocation was already claimed,
  // rechecking whenever units sell.
  const unitsSoldTick =
    offering && offering.status === "loaded" ? offering.unitsSold : null;
  const consumed =
    useQuery({
      queryKey: [
        "allocation-consumed",
        offeringAddress,
        voucherPayload?.voucher.allocationId ?? null,
      ],
      enabled: !!voucherPayload && !!offeringAddress,
      queryFn: () =>
        isAllocationConsumed({
          offeringAddress: offeringAddress!,
          allocationId: voucherPayload!.voucher.allocationId,
        }),
    }).data ?? null;
  useEffect(() => {
    if (unitsSoldTick == null) return;
    queryClient.invalidateQueries({
      queryKey: ["allocation-consumed", offeringAddress],
    });
  }, [unitsSoldTick]);

  useEffect(() => {
    if (voucherPayload || !offeringAddress || debugActive(debugState)) {
      setPublicQuote(null);
      setPublicQuoteLoading(false);
      return;
    }
    const requested = Number(units) || 0;
    if (!Number.isInteger(requested) || requested < 1) {
      setPublicQuote(null);
      setPublicQuoteLoading(false);
      return;
    }
    const seq = ++publicQuoteSeq.current;
    setPublicQuoteLoading(true);
    const timer = window.setTimeout(async () => {
      let quote: { units: number; costUsd: number } | null = null;
      try {
        const fresh = await quotePublicPurchase({
          offeringAddress,
          units: requested,
        });
        quote = {
          units: requested,
          costUsd: usdcBaseUnitsToDollars(fresh.cost),
        };
      } catch {
        // Invalid or temporarily unavailable quotes render as an em dash.
      }
      if (seq !== publicQuoteSeq.current) return;
      setPublicQuote(quote);
      setPublicQuoteLoading(false);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [units, debugState, unitsSoldTick]);

  // Self-heal: the receipt lives onchain, not in a local database. A wallet
  // with a deposit recovers its purchases from Bought events.
  const deposit =
    offering && offering.status === "loaded"
      ? Number(offering.deposit || 0)
      : 0;
  useEffect(() => {
    if (
      !wallet ||
      !offeringAddress ||
      deposit <= 0 ||
      receipt ||
      recoveringRef.current
    )
      return;
    if (debugActive(debugState)) return;
    recoveringRef.current = true;
    (async () => {
      try {
        const bought = await listBought({ offering: offeringAddress });
        // Voucher mode is allocation-scoped: only this link's purchase counts,
        // so a wallet's earlier claim doesn't shadow a fresh allocation.
        const mine = bought.filter(
          (p) =>
            isSameAddress(p.buyer, wallet) &&
            (!voucherPayload ||
              String(p.allocationId).toLowerCase() ===
                String(voucherPayload.voucher.allocationId).toLowerCase()),
        );
        const last = mine[mine.length - 1];
        if (last) {
          setReceipt({
            units: mine.reduce((s, p) => s + p.units, 0),
            cost: mine.reduce((s, p) => s + p.cost, 0),
            txHash: last.txHash,
          });
        }
      } catch (err) {
        console.warn("Could not recover onchain purchase", err);
      } finally {
        recoveringRef.current = false;
      }
    })();
  }, [wallet, deposit, debugState, receipt]);

  async function handleRefund() {
    if (debugActive(debugState)) {
      setDebugPreview(true);
      setTimeout(() => setDebugPreview(false), 900);
      return;
    }
    if (!wallet) {
      showToast("Connect the purchasing wallet before refunding.");
      return;
    }
    setBusy("refund");
    try {
      await refundOffering({ offeringAddress: offeringAddress!, from: wallet });
      await refreshOffering();
    } catch (err) {
      showToast(errMsg(err, "Could not complete refund."));
    }
    setBusy(null);
  }

  async function handlePay() {
    if (!termsAccepted || !signerName.trim()) {
      showToast("Accept the terms and sign your name before purchasing.");
      return;
    }
    if (!wallet) {
      showToast("Connect a wallet before purchasing this offering.");
      return;
    }
    setBusy("pay");
    try {
      let purchase;
      if (voucherPayload) {
        purchase = await buyPrivateOffering({
          buyer: wallet,
          offeringAddress: offeringAddress!,
          voucher: voucherPayload.voucher,
          ownerSig: voucherPayload.ownerSig,
          linkPrivateKey: voucherPayload.linkPrivateKey,
        });
      } else {
        purchase = await buyPublicOffering({
          buyer: wallet,
          offeringAddress: offeringAddress!,
          units: Number(units),
          buyerName: buyerName.trim(),
        });
      }
      setReceipt((prev) => ({
        units: (prev ? prev.units : 0) + (purchase.units || 0),
        cost: (prev ? prev.cost : 0) + (purchase.cost || 0),
        txHash: purchase.buyTxHash,
      }));
      refreshOffering();
    } catch (err) {
      showToast(errMsg(err, "Could not complete purchase."));
    }
    setBusy(null);
  }

  if (!offeringAddress)
    return (
      <PageNotice title="Link not found">
        This buy link doesn’t name an offering contract.
      </PageNotice>
    );
  if (voucherError)
    return <PageNotice title="Link not valid">{voucherError}</PageNotice>;

  const liveOfferingState =
    offering && offering.status === "loaded" ? offering : null;
  const offeringState = debugOfferingSnapshot(liveOfferingState, debugState);
  if (!offeringState) {
    return offering && offering.status === "error" ? (
      <PageNotice title="Contract read failed">
        Could not read this offering from Base. Refresh to retry.
      </PageNotice>
    ) : (
      <p className="t-muted">Loading offering…</p>
    );
  }

  const {
    closeDate,
    offeringFailed,
    raiseClosed,
    debugRefunded,
    offeringIsPrivate,
    publicRemaining,
    raiseCapacity,
    valuationStart,
    valuationEnd,
    minUsd,
    isPaid,
    paidUnits,
    paidCostUsd,
    pricePer,
    budgetUsdc,
    requestedPublicUnits,
    quoteUnits,
    quoteCost,
    quotePricePer,
    claimedByOther,
    refundableDeposit,
    canStillPurchase,
  } = deriveBuyView({
    offeringState,
    receipt,
    wallet,
    units,
    consumed,
    debugState,
  });
  const txLabel =
    receipt && receipt.txHash ? (
      <a
        className="linkbtn"
        href={basescanTx(receipt.txHash)}
        target="_blank"
        rel="noreferrer"
      >
        View transaction
      </a>
    ) : null;
  const publicUnitsValid =
    Number.isInteger(requestedPublicUnits) &&
    requestedPublicUnits >= 1 &&
    requestedPublicUnits <= publicRemaining;
  const estimatedCostUsd = debugActive(debugState)
    ? quoteUnits > 0
      ? quoteCost
      : null
    : publicQuote &&
        publicUnitsValid &&
        publicQuote.units === requestedPublicUnits
      ? publicQuote.costUsd
      : null;
  const estimatedCostLoading =
    publicUnitsValid && !debugActive(debugState) && publicQuoteLoading;

  const failedRefundCopy = debugRefunded
    ? "This project failed to meet the minimum before the close date."
    : wallet
      ? "This project failed to meet the minimum before the close date. You can claim your full refund; your units return to the project."
      : "This project failed to meet the minimum before the close date. Connect the purchasing wallet to claim your full refund.";

  // The single call-to-action for the page state; first match wins.
  function renderAction() {
    if (isPaid && offeringFailed && debugRefunded) return null;
    if (offeringFailed && refundableDeposit > 0)
      return (
        <div className="flex justify-end mt-10">
          <Button
            className="px-6 py-3 text-base font-semibold"
            data-act="refund"
            disabled={busy === "refund"}
            onClick={handleRefund}
          >
            {debugPreview
              ? "Debug preview only"
              : busy === "refund"
                ? "Refunding…"
                : `Claim ${fmtUsd(refundableDeposit, "cents")} refund`}
          </Button>
        </div>
      );
    if (isPaid) return null;
    if (claimedByOther)
      return (
        <Notice className="mt-10">
          This allocation link has already been claimed or revoked. Ask the
          issuer for a fresh link.
        </Notice>
      );
    if (raiseClosed)
      return (
        <Notice className="mt-10">
          {offeringFailed
            ? "This project failed to meet the minimum before the close date."
            : "This offering has closed."}{" "}
          No further buy-ins can be made.
        </Notice>
      );
    if (!voucherPayload && publicRemaining <= 0)
      return (
        <Notice className="mt-10">
          {offeringIsPrivate
            ? "This offering is private."
            : "The public allocation of this offering is fully subscribed."}{" "}
          Ask the issuer for a private allocation link.
        </Notice>
      );
    if (!wallet)
      return (
        <Notice className="mt-8">
          Connect a wallet before purchasing this offering.
        </Notice>
      );
    return (
      <div className="flex justify-end mt-8">
        <Button
          className="px-6 py-3 text-base font-semibold"
          data-act="pay"
          disabled={
            busy === "pay" ||
            quoteUnits <= 0 ||
            !termsAccepted ||
            !signerName.trim()
          }
          onClick={handlePay}
        >
          {busy === "pay"
            ? "Purchasing…"
            : `Purchase ${projectName || "this offering"}`}
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-10 text-center">
        <p className="text-2xl font-bold mb-2">
          {projectName || "PACT offering"}
        </p>
        <h1 className="text-2xl font-bold uppercase tracking-wide">
          Purchase Agreement for Community Tokens
        </h1>
        {voucherPayload ? (
          <p className="text-sm t-muted mt-2">
            Private allocation for {voucherPayload.voucher.buyerName}
          </p>
        ) : null}
      </div>

      <SectionTitle>Offering details</SectionTitle>
      <DefList className="mb-8">
        <Field label="Raising">
          <span>Up to {fmtUsd(raiseCapacity, "cents")}</span>
          <Sub>{fmtUsd(minUsd, "cents")} minimum</Sub>
        </Field>
        <Field label="Valuation range" align="none">
          {fmtUsd(valuationStart)}–{fmtUsd(valuationEnd)} post-money
        </Field>
        <Field label="Close date">
          <span>{fmtDate(closeDate)}</span>
          <Sub>{relDays(closeDate)}</Sub>
        </Field>
        <Field label="Treasury" align="none">
          {offeringState.treasury ? (
            <AddressLink address={offeringState.treasury} />
          ) : (
            <span className="t-muted">Not set</span>
          )}
        </Field>
        <Field label="Contract" align="none">
          <AddressLink address={offeringAddress} />
        </Field>
      </DefList>

      {isPaid && offeringFailed ? (
        <Notice className="mb-5 text-sm">{failedRefundCopy}</Notice>
      ) : null}

      {!isPaid && !raiseClosed && !claimedByOther ? (
        voucherPayload ? (
          <>
            <SectionTitle>Allocation details</SectionTitle>
            <DefList className="mb-5">
              <Field label="Buyer" align="none">
                {voucherPayload.voucher.buyerName}
              </Field>
              <Field label="Amount" align="none">
                {fmtUsd(usdcBaseUnitsToDollars(budgetUsdc), "cents")}
              </Field>
              <Field label="Implied ownership">
                <span>{fmtPct((quoteUnits / TOTAL_TOKENS) * 100)}</span>
                <Sub>{fmtTokens(quoteUnits)} units</Sub>
              </Field>
              <Field label="Price per unit" align="none">
                {fmtUsd(quotePricePer, "cents")}
              </Field>
            </DefList>
          </>
        ) : publicRemaining > 0 ? (
          <>
            <SectionTitle>Your purchase</SectionTitle>
            <DefList className="mb-5">
              <Field label="Units" align="none">
                <span>
                  <input
                    className="blank w-28 text-left"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="0"
                    autoComplete="off"
                    value={units}
                    onChange={(e) => {
                      if (/^\d*$/.test(e.target.value))
                        setUnits(e.target.value);
                    }}
                  />
                  {requestedPublicUnits > publicRemaining ? (
                    <span className="t-danger ml-2">
                      Max {fmtTokens(publicRemaining)}
                    </span>
                  ) : (
                    <span className="t-muted ml-2">
                      ({fmtTokens(publicRemaining)} available)
                    </span>
                  )}
                </span>
              </Field>
              <Field label="Estimated cost" loading={estimatedCostLoading}>
                <span>
                  {estimatedCostUsd != null
                    ? fmtUsd(estimatedCostUsd, "cents")
                    : "—"}
                </span>
                <Sub>
                  {estimatedCostUsd != null && requestedPublicUnits > 0
                    ? `${fmtUsd(estimatedCostUsd / requestedPublicUnits, "cents")} / unit`
                    : "— / unit"}
                </Sub>
              </Field>
              <Field label="Implied ownership">
                <span>{fmtPct((quoteUnits / TOTAL_TOKENS) * 100)}</span>
                <Sub>{fmtTokens(quoteUnits)} units</Sub>
              </Field>
              <Field label="Display name" align="none">
                <input
                  className="blank w-44 text-left"
                  placeholder="Optional, public"
                  autoComplete="off"
                  value={buyerName}
                  onChange={(e) => setBuyerName(e.target.value)}
                />
              </Field>
            </DefList>
          </>
        ) : null
      ) : null}

      {isPaid && offeringFailed ? (
        <>
          <SectionTitle>Refund details</SectionTitle>
          <DefList className="mb-5">
            <dt>Status</dt>
            <dd className="status-value">
              <span className="status-state">
                <StatusDot refundable={!debugRefunded} />
                <span>{debugRefunded ? "Refunded" : "Refundable"}</span>
              </span>
              {debugRefunded ? txLabel : null}
            </dd>
            <Field label="Refund amount" align="none">
              {fmtUsd(refundableDeposit || paidCostUsd, "cents")}
            </Field>
          </DefList>
        </>
      ) : isPaid ? (
        <>
          <SectionTitle>Purchase details</SectionTitle>
          <DefList className="mb-5">
            <dt>Status</dt>
            <dd className="status-value">
              <span className="status-state">
                <StatusDot />
                <span>Purchased</span>
              </span>
              {txLabel}
            </dd>
            <Field label="Amount" align="none">
              {fmtUsd(paidCostUsd, "cents")}
            </Field>
            <Field label="Ownership" align="none">
              <span>{fmtPct((paidUnits / TOTAL_TOKENS) * 100)}</span>
              <span className="t-muted ml-2">{fmtTokens(paidUnits)} units</span>
            </Field>
            <Field label="Price per unit" align="none">
              {fmtUsd(pricePer, "cents")}
            </Field>
          </DefList>
        </>
      ) : null}

      {canStillPurchase ? (
        <section className="purchase-terms">
          <SectionTitle>Terms</SectionTitle>
          <label className="terms-confirmation">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
            />
            <span>
              I understand that this is a Purchase Agreement for Community
              Tokens (a &ldquo;PACT&rdquo;), and that the Units confer no legal
              rights but may participate in the Project&rsquo;s future value as
              its creator expressly provides. The Units exist solely to align
              their holders with the Project, and it is for the creator to
              determine what, if anything, they are used for. My purchase is
              refundable in full if the offering does not reach its minimum of{" "}
              {fmtUsd(minUsd, "cents")} by {fmtDate(closeDate)}.
            </span>
          </label>
          <div className="signature-row terms-signature">
            <div className="signature-inner">
              <span className="signature-by">By:</span>
              <div className="signature-block">
                <div className="signature-preview" aria-hidden="true">
                  {signerName || "\u00a0"}
                </div>
                <label className="sr-only" htmlFor="buyerSignatureName">
                  Name
                </label>
                <input
                  id="buyerSignatureName"
                  className={`blank signature-input${signerNameError ? " error" : ""}`}
                  data-error={signerNameError || undefined}
                  aria-invalid={!!signerNameError}
                  type="text"
                  placeholder="Name (required, private)"
                  autoComplete="name"
                  required
                  value={signerName}
                  onChange={(e) => {
                    setSignerName(e.target.value);
                    if (e.target.value.trim()) setSignerNameError("");
                  }}
                  onBlur={() =>
                    setSignerNameError(
                      signerName.trim() ? "" : "Enter your name.",
                    )
                  }
                />
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {renderAction()}
    </>
  );
}

mountPage(<BuyApp />);
