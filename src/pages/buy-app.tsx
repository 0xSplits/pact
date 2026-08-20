import "#pages/buy.css";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAccount } from "wagmi";

import {
  AddressLink,
  Button,
  CheckIcon,
  DefList,
  Field,
  Notice,
  SectionTitle,
  SignatureBlock,
  Sub,
  TextButton,
} from "#components/ui.tsx";
import { useDebugMenu } from "#hooks/use-debug-menu.ts";
import { useErrorTip } from "#hooks/use-error-tip.ts";
import { useOfferingState } from "#hooks/use-offering-state.ts";
import { toUsdcBaseUnits } from "#lib/chain/chain.ts";
import {
  costForUnits,
  unitsForBudget,
  valuationForUnitIndex,
} from "#lib/chain/curve.ts";
import { TOTAL_LIQUID_SPLIT_UNITS } from "#lib/chain/liquid-split.ts";
import { listBought } from "#lib/chain/offerings.ts";
import {
  availablePublicUnits,
  buyPrivateOffering,
  buyPublicOffering,
  getProjectName,
  isAllocationConsumed,
  offeringStateCurve,
  QuoteChangedError,
  refundOffering,
} from "#lib/chain/onchain.ts";
import type { OfferingState } from "#lib/chain/onchain.ts";
import type { DecodedVoucherLink } from "#lib/chain/voucher.ts";
import { decodeVoucherFragment } from "#lib/chain/voucher.ts";
import {
  basescanTx,
  errMsg,
  fmtDate,
  fmtPct,
  fmtTokens,
  fmtUsd,
  formatAmountInput,
  MS_PER_DAY,
  parseMoney,
  relDays,
  usdcBaseUnitsToDollars,
} from "#lib/format.ts";
import {
  currentOfferingAddress,
  currentVoucherFragment,
  receiptPath,
  termsPath,
} from "#lib/routes.ts";
import { debugActive } from "#lib/ui/debug-menu.ts";
import { showToast } from "#lib/ui/toast.ts";
import { isSameAddress } from "#lib/validate.ts";

const offeringAddress = currentOfferingAddress();
const fragment = currentVoucherFragment();

function parseFragment(): {
  voucher: DecodedVoucherLink | null;
  voucherError: string;
} {
  if (!fragment) return { voucher: null, voucherError: "" };
  try {
    return { voucher: decodeVoucherFragment(fragment), voucherError: "" };
  } catch {
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
    raised: 55_000000n,
    withdrawn: 0n,
    raiseMin: 100_000000n,
    closeDate: Math.floor((Date.now() + 7 * MS_PER_DAY) / 1000),
    priceStart: 1_000000n,
    priceSlope: 1000n,
    publicUnits: 100,
    publicUnitsSold: 20,
    deposit: 0n,
    ...(live || {}),
  };
  if (debugState === "funding") return { ...base, state: 0, minMet: false };
  if (debugState === "failed")
    return {
      ...base,
      state: 1,
      minMet: false,
      closeDate: Math.floor((Date.now() - MS_PER_DAY) / 1000),
      deposit: 25_000000n,
    };
  if (debugState === "refunded")
    return {
      ...base,
      state: 1,
      minMet: false,
      closeDate: Math.floor((Date.now() - MS_PER_DAY) / 1000),
      deposit: 0n,
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
  amount,
  consumed,
  debugState,
}: {
  offeringState: OfferingView;
  receipt: { units: number; cost: bigint; txHash: string | null } | null;
  wallet: string | null;
  amount: string;
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
  const valuationStart = valuationForUnitIndex(
    curve,
    0,
    TOTAL_LIQUID_SPLIT_UNITS,
  );
  const valuationEnd = valuationForUnitIndex(
    curve,
    offeringState.unitsSold + remainingUnits,
    TOTAL_LIQUID_SPLIT_UNITS,
  );
  const minUsd = usdcBaseUnitsToDollars(offeringState.raiseMin);

  const isPaid =
    !!receipt ||
    (debugActive(debugState) && (offeringState.deposit ?? 0n) > 0n);
  const paidUnits = receipt ? receipt.units : 0;
  const paidCostUsd = usdcBaseUnitsToDollars(
    receipt ? receipt.cost : (offeringState.deposit ?? 0n),
  );
  const pricePer = paidUnits > 0 ? paidCostUsd / paidUnits : 0;

  // Quote for what the buyer is about to purchase. Both paths treat dollars
  // as a budget: whole units within it, at their actual curve cost. A public
  // budget that could afford a unit beyond the tranche is rejected, not
  // clamped — the typed amount must be the amount charged (minus only the
  // sub-unit remainder), so the form never shows a deal the input disagrees
  // with.
  const budgetUsdc = voucherPayload
    ? BigInt(voucherPayload.voucher.amountCapUsdc)
    : toUsdcBaseUnits(parseMoney(amount));
  const overCapacity =
    !voucherPayload &&
    budgetUsdc >=
      costForUnits(curve, offeringState.unitsSold, publicRemaining + 1);
  const quoteUnits =
    budgetUsdc > 0n && !overCapacity
      ? unitsForBudget(
          curve,
          offeringState.unitsSold,
          voucherPayload ? remainingUnits : publicRemaining,
          budgetUsdc,
        )
      : 0;
  const quoteCostUsdc = costForUnits(
    curve,
    offeringState.unitsSold,
    quoteUnits,
  );
  const quoteCost = usdcBaseUnitsToDollars(quoteCostUsdc);
  const quotePricePer = quoteUnits > 0 ? quoteCost / quoteUnits : 0;
  // Capacity ceiled to the cent in bigint, so typing the displayed maximum
  // always affords every available unit.
  const publicCapacityUsd =
    Number(
      (costForUnits(curve, offeringState.unitsSold, publicRemaining) + 9999n) /
        10000n,
    ) / 100;
  const firstUnitCostUsd = usdcBaseUnitsToDollars(
    costForUnits(curve, offeringState.unitsSold, 1),
  );

  const claimedByOther = !!voucherPayload && !!consumed && !isPaid;
  const refundableDeposit =
    offeringFailed && wallet && (offeringState.deposit ?? 0n) > 0n
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
    overCapacity,
    quoteUnits,
    quoteCost,
    quoteCostUsdc,
    quotePricePer,
    publicCapacityUsd,
    firstUnitCostUsd,
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

export function BuyApp() {
  const [receipt, setReceipt] = useState<{
    units: number;
    cost: bigint;
    txHash: string | null;
  } | null>(null); // for the connected wallet
  const [amount, setAmount] = useState("");
  const [staleQuote, setStaleQuote] = useState<{
    prevUnits: number;
    prevCost: number;
    units: number;
    cost: number;
  } | null>(null);
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

  const wallet = useAccount().address ?? null;
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
  }, [unitsSoldTick, queryClient]);

  useErrorTip(signerNameError);

  // Self-heal: the receipt lives onchain, not in a local database. A wallet
  // with a deposit recovers its purchases from Bought events.
  const deposit =
    offering && offering.status === "loaded" ? (offering.deposit ?? 0n) : 0n;
  useEffect(() => {
    if (
      !wallet ||
      !offeringAddress ||
      deposit <= 0n ||
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
            cost: mine.reduce((s, p) => s + BigInt(p.cost), 0n),
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
    setStaleQuote(null);
    // The quote the buyer confirmed on screen; submit aborts if fresh chain
    // state no longer matches it.
    const expected = { units: quoteUnits, cost: quoteCostUsdc };
    try {
      let purchase;
      if (voucherPayload) {
        purchase = await buyPrivateOffering({
          buyer: wallet,
          offeringAddress: offeringAddress!,
          voucher: voucherPayload.voucher,
          ownerSig: voucherPayload.ownerSig,
          linkPrivateKey: voucherPayload.linkPrivateKey,
          expected,
        });
      } else {
        purchase = await buyPublicOffering({
          buyer: wallet,
          offeringAddress: offeringAddress!,
          budgetUsdc,
          expected,
          buyerName: buyerName.trim(),
        });
      }
      setReceipt((prev) => ({
        units: (prev ? prev.units : 0) + (purchase.units || 0),
        cost: (prev ? prev.cost : 0n) + BigInt(purchase.cost || 0),
        txHash: purchase.buyTxHash,
      }));
      refreshOffering();
    } catch (err) {
      if (err instanceof QuoteChangedError) {
        setStaleQuote({
          prevUnits: quoteUnits,
          prevCost: quoteCost,
          units: err.units,
          cost: usdcBaseUnitsToDollars(err.cost),
        });
        showToast("Prices moved — review the updated quote.");
        refreshOffering();
      } else {
        showToast(errMsg(err, "Could not complete purchase."));
      }
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
    overCapacity,
    quoteUnits,
    quoteCost,
    quoteCostUsdc,
    quotePricePer,
    publicCapacityUsd,
    firstUnitCostUsd,
    claimedByOther,
    refundableDeposit,
    canStillPurchase,
  } = deriveBuyView({
    offeringState,
    receipt,
    wallet,
    amount,
    consumed,
    debugState,
  });
  const txLabel =
    receipt && receipt.txHash ? (
      <>
        <a
          className="linkbtn"
          href={receiptPath(offeringAddress!, receipt.txHash)}
          target="_blank"
          rel="noreferrer"
        >
          View receipt
        </a>
        <a
          className="linkbtn t-muted text-sm"
          href={basescanTx(receipt.txHash)}
          target="_blank"
          rel="noreferrer"
        >
          Basescan
        </a>
      </>
    ) : null;

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
      <>
        {staleQuote ? (
          <Notice className="mt-8">
            Prices moved since your quote:{" "}
            {voucherPayload ? "your allocation now buys" : "now"}{" "}
            {fmtTokens(staleQuote.units)} units for{" "}
            {fmtUsd(staleQuote.cost, "cents")} (was{" "}
            {fmtTokens(staleQuote.prevUnits)} units for{" "}
            {fmtUsd(staleQuote.prevCost, "cents")}). Review and confirm again.
          </Notice>
        ) : null}
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
      </>
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
                <span>
                  {fmtPct((quoteUnits / TOTAL_LIQUID_SPLIT_UNITS) * 100)}
                </span>
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
              <Field label="Amount" align="none">
                <span>
                  $
                  <input
                    className="blank w-28 text-left"
                    type="text"
                    inputMode="decimal"
                    placeholder="0"
                    autoComplete="off"
                    value={amount}
                    onChange={(e) => {
                      setAmount(formatAmountInput(e.target.value));
                      setStaleQuote(null);
                    }}
                  />
                  <TextButton
                    tone={overCapacity ? "danger" : "muted"}
                    className="ml-2"
                    onClick={() => {
                      setAmount(
                        formatAmountInput(publicCapacityUsd.toFixed(2)),
                      );
                      setStaleQuote(null);
                    }}
                  >
                    {overCapacity
                      ? `Max ${fmtUsd(publicCapacityUsd, "cents")} available`
                      : `(up to ${fmtUsd(publicCapacityUsd, "cents")} available)`}
                  </TextButton>
                  {!overCapacity &&
                  parseMoney(amount) > 0 &&
                  quoteUnits <= 0 ? (
                    <span className="t-danger ml-2">
                      Minimum {fmtUsd(firstUnitCostUsd, "cents")} for 1 unit
                    </span>
                  ) : null}
                </span>
              </Field>
              <Field label="You receive">
                <span>
                  {quoteUnits > 0
                    ? `${fmtTokens(quoteUnits)} units · ${fmtPct((quoteUnits / TOTAL_LIQUID_SPLIT_UNITS) * 100)} of the project`
                    : "—"}
                </span>
                <Sub>
                  {quoteUnits > 0
                    ? `${fmtUsd(quoteCost, "cents")} charged · ${fmtUsd(quotePricePer, "cents")} / unit`
                    : "— charged"}
                </Sub>
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
              <span>
                {fmtPct((paidUnits / TOTAL_LIQUID_SPLIT_UNITS) * 100)}
              </span>
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
              Tokens (a{" "}
              <a
                className="linkbtn"
                href={termsPath(offeringAddress!)}
                target="_blank"
                rel="noreferrer"
              >
                &ldquo;PACT&rdquo;
              </a>
              ), and that the Units confer no legal rights but may participate
              in the Project&rsquo;s future value as its creator expressly
              provides. The Units exist solely to align their holders with the
              Project, and it is for the creator to determine what, if anything,
              they are used for. My purchase is refundable in full if the
              offering does not reach its minimum of {fmtUsd(minUsd, "cents")}{" "}
              by {fmtDate(closeDate)}.
            </span>
          </label>
          <SignatureBlock
            id="buyerSignatureName"
            className="terms-signature"
            value={signerName}
            error={signerNameError || undefined}
            onChange={(value) => {
              setSignerName(value);
              if (value.trim()) setSignerNameError("");
            }}
            onBlur={() =>
              setSignerNameError(signerName.trim() ? "" : "Enter your name.")
            }
          />
        </section>
      ) : null}

      {renderAction()}
    </>
  );
}
