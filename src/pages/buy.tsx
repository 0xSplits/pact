import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { injectChrome } from '../lib/ui/chrome.ts';
import { showToast } from '../lib/ui/toast.ts';
import { AppProviders } from '../components/wallet.tsx';
import { useWallet } from '../hooks/use-wallet.ts';
import { useOfferingState } from '../hooks/use-offering-state.ts';
import {
  fmtMoney, fmtDollars, fmtPct, fmtTokens, fmtPrice, fmtDate, usdcBaseUnitsToDollars,
  basescanTx, errMsg,
} from '../lib/format.ts';
import { costForUnits, unitsForBudget, valuationForUnitIndex } from '../lib/chain/curve.ts';
import { initDebugMenu, isLocalhost } from '../lib/ui/debug-menu.ts';
import { currentOfferingAddress, currentVoucherFragment } from '../lib/routes.ts';
import { getProjectName, isAllocationConsumed, buyPublicOffering, buyPrivateOffering, refundOffering } from '../lib/chain/onchain.ts';
import type { OfferingState } from '../lib/chain/onchain.ts';
import type { DecodedVoucherLink } from '../lib/chain/voucher.ts';
import { listBought } from '../lib/chain/offerings.ts';
import { decodeVoucherFragment } from '../lib/chain/voucher.ts';
import { AddressLink, Button, DefList, Field, Notice, SectionTitle, Sub } from '../components/ui.tsx';

const TOTAL_TOKENS = 1000;
const offeringAddress = currentOfferingAddress();
const fragment = currentVoucherFragment();

const relDays = (ts: number) => { const d = Math.ceil((ts - Date.now()) / 86400000); return d > 1 ? 'in ' + d + ' days' : d === 1 ? 'in 1 day' : d === 0 ? 'today' : d === -1 ? '1 day ago' : Math.abs(d) + ' days ago'; };

function parseFragment(): { voucher: DecodedVoucherLink | null; voucherError: string } {
  if (!fragment) return { voucher: null, voucherError: '' };
  try {
    return { voucher: decodeVoucherFragment(fragment), voucherError: '' };
  } catch (err) {
    return { voucher: null, voucherError: 'This allocation link is malformed or from an older version. Ask the issuer for a fresh link.' };
  }
}
const { voucher: voucherPayload, voucherError } = parseFragment();

function debugActive(debugState: string) {
  return isLocalhost() && debugState !== 'live';
}

// The offering fields the page renders. Debug snapshots synthesize them
// without an address/owner/treasury; live reads carry the full state.
type OfferingView = Omit<OfferingState, 'offeringAddress' | 'owner' | 'treasury' | 'pactToken'>
  & Partial<Pick<OfferingState, 'offeringAddress' | 'owner' | 'treasury' | 'pactToken'>>;

function debugOfferingSnapshot(live: OfferingView | null, debugState: string): OfferingView | null {
  if (!debugActive(debugState)) return live;
  const base = {
    remainingUnits: 150,
    unitsSold: 50,
    minMet: false,
    state: 0,
    raised: 55_000000,
    withdrawn: 0,
    raiseMin: 100_000000,
    closeDate: Math.floor((Date.now() + 7 * 86400000) / 1000),
    priceStart: 1_000000,
    priceSlope: 1000,
    publicUnits: 100,
    publicUnitsSold: 20,
    deposit: 0,
    ...(live || {}),
  };
  if (debugState === 'funding') return { ...base, state: 0, minMet: false };
  if (debugState === 'failed') return { ...base, state: 1, minMet: false, closeDate: Math.floor((Date.now() - 86400000) / 1000), deposit: 25_000000 };
  if (debugState === 'refunded') return { ...base, state: 1, minMet: false, closeDate: Math.floor((Date.now() - 86400000) / 1000), deposit: 0 };
  if (debugState === 'closed') return { ...base, state: 2, minMet: true };
  return live;
}

function PageNotice({ title, children }: { title: string; children: ReactNode }) {
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
    <span className={`status-dot${refundable ? ' refundable' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        {refundable ? <><path d="M12 7v6" /><path d="M12 17h.01" /></> : <path d="m5 12 4 4L19 6" />}
      </svg>
    </span>
  );
}

function formatAmountInput(value: string) {
  const raw = value.replace(/,/g, '').replace(/[^0-9.]/g, '');
  const parts = raw.split('.');
  const intPart = parts[0].replace(/^0+(?=\d)/, '');
  const decPart = parts.length > 1 ? parts.slice(1).join('').slice(0, 2) : null;
  const intDisplay = intPart ? Number(intPart).toLocaleString('en-US') : '';
  return decPart == null ? intDisplay : (intDisplay || '0') + '.' + decPart;
}

function BuyApp() {
  const [receipt, setReceipt] = useState<{ units: number; cost: number; txHash: string | null } | null>(null); // for the connected wallet
  const [amount, setAmount] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [debugState, setDebugState] = useState('live');
  const [busy, setBusy] = useState<'refund' | 'pay' | null>(null);
  const [debugPreview, setDebugPreview] = useState(false);
  const debugRef = useRef('live');
  const recoveringRef = useRef(false);

  const wallet = useWallet();
  const queryClient = useQueryClient();
  const { offering, refresh: refreshOffering } = useOfferingState({
    offeringAddress,
    buyer: wallet,
  });

  useEffect(() => {
    initDebugMenu({
      states: [
        { value: 'live', label: 'Live' },
        { value: 'funding', label: 'Funding' },
        { value: 'failed', label: 'Failed' },
        { value: 'refunded', label: 'Refunded' },
        { value: 'closed', label: 'Closed' },
      ],
      getState: () => debugRef.current,
      setState: state => {
        debugRef.current = state;
        setDebugState(state);
      },
    });
  }, []);

  const pactToken = offering && offering.status === 'loaded' ? offering.pactToken : null;
  const projectName = useQuery({
    queryKey: ['project-name', pactToken],
    enabled: !!pactToken,
    // A failed read degrades to the generic heading, matching the old catch.
    queryFn: () => getProjectName({ pactToken: pactToken! }).catch(() => ''),
  }).data ?? null;

  useEffect(() => {
    if (projectName) document.title = `${projectName} | PACT`;
  }, [projectName]);

  // Voucher mode: check whether the allocation was already claimed,
  // rechecking whenever units sell.
  const unitsSoldTick = offering && offering.status === 'loaded' ? offering.unitsSold : null;
  const consumed = useQuery({
    queryKey: ['allocation-consumed', offeringAddress, voucherPayload?.voucher.allocationId ?? null],
    enabled: !!voucherPayload && !!offeringAddress,
    queryFn: () => isAllocationConsumed({ offeringAddress: offeringAddress!, allocationId: voucherPayload!.voucher.allocationId }),
  }).data ?? null;
  useEffect(() => {
    if (unitsSoldTick == null) return;
    queryClient.invalidateQueries({ queryKey: ['allocation-consumed', offeringAddress] });
  }, [unitsSoldTick]);

  // Self-heal: the receipt lives onchain, not in a local database. A wallet
  // with a deposit recovers its purchases from Bought events.
  const deposit = offering && offering.status === 'loaded' ? Number(offering.deposit || 0) : 0;
  useEffect(() => {
    if (!wallet || !offeringAddress || deposit <= 0 || receipt || recoveringRef.current) return;
    if (debugActive(debugState)) return;
    recoveringRef.current = true;
    (async () => {
      try {
        const bought = await listBought({ offering: offeringAddress });
        // Voucher mode is allocation-scoped: only this link's purchase counts,
        // so a wallet's earlier claim doesn't shadow a fresh allocation.
        const mine = bought.filter(p => p.buyer.toLowerCase() === String(wallet).toLowerCase()
          && (!voucherPayload || String(p.allocationId).toLowerCase() === String(voucherPayload.voucher.allocationId).toLowerCase()));
        if (mine.length) {
          setReceipt({
            units: mine.reduce((s, p) => s + p.units, 0),
            cost: mine.reduce((s, p) => s + p.cost, 0),
            txHash: mine[mine.length - 1].txHash,
          });
        }
      } catch (err) {
        console.warn('Could not recover onchain purchase', err);
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
      showToast('Connect the purchasing wallet before refunding.');
      return;
    }
    setBusy('refund');
    try {
      await refundOffering({ offeringAddress: offeringAddress!, from: wallet });
      await refreshOffering();
    } catch (err) {
      showToast(errMsg(err, 'Could not complete refund.'));
    }
    setBusy(null);
  }

  async function handlePay() {
    if (!wallet) {
      showToast('Connect a wallet before purchasing this offering.');
      return;
    }
    setBusy('pay');
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
          amountUsd: +String(amount).replace(/[^0-9.]/g, '') || 0,
          buyerName: buyerName.trim(),
        });
      }
      setReceipt(prev => ({
        units: (prev ? prev.units : 0) + (purchase.units || 0),
        cost: (prev ? prev.cost : 0) + (purchase.cost || 0),
        txHash: purchase.buyTxHash,
      }));
      refreshOffering();
    } catch (err) {
      showToast(errMsg(err, 'Could not complete purchase.'));
    }
    setBusy(null);
  }

  if (!offeringAddress) return <PageNotice title="Link not found">This buy link doesn’t name an offering contract.</PageNotice>;
  if (voucherError) return <PageNotice title="Link not valid">{voucherError}</PageNotice>;

  const liveOfferingState = offering && offering.status === 'loaded' ? offering : null;
  const offeringState = debugOfferingSnapshot(liveOfferingState, debugState);
  if (!offeringState) {
    return offering && offering.status === 'error'
      ? <PageNotice title="Contract read failed">Could not read this offering from Base. Refresh to retry.</PageNotice>
      : <p className="t-muted">Loading offering…</p>;
  }

  const curve = { priceStart: offeringState.priceStart, priceSlope: offeringState.priceSlope };
  const closeDate = offeringState.closeDate * 1000;
  const offeringFailed = offeringState.state === 1;
  const offeringClosed = offeringState.state === 2;
  const raiseClosed = offeringFailed || offeringClosed || (offeringState.state === 0 && Date.now() > closeDate && !offeringState.minMet);
  const debugRefunded = debugState === 'refunded';
  const raisedTotal = usdcBaseUnitsToDollars(offeringState.raised);
  const remainingUnits = Number(offeringState.remainingUnits || 0);
  const publicRemaining = Math.min(remainingUnits, Math.max(0, offeringState.publicUnits - offeringState.publicUnitsSold));
  const remainingCapacity = usdcBaseUnitsToDollars(costForUnits(curve, offeringState.unitsSold, remainingUnits));
  const raiseCapacity = Math.max(raisedTotal + remainingCapacity, usdcBaseUnitsToDollars(offeringState.raiseMin), raisedTotal);
  const valuationStart = valuationForUnitIndex(curve, 0, TOTAL_TOKENS);
  const valuationEnd = valuationForUnitIndex(curve, offeringState.unitsSold + remainingUnits, TOTAL_TOKENS);
  const minUsd = usdcBaseUnitsToDollars(offeringState.raiseMin);

  const isPaid = !!receipt || (debugActive(debugState) && Number(offeringState.deposit || 0) > 0);
  const paidUnits = receipt ? receipt.units : 0;
  const paidCostUsd = receipt ? usdcBaseUnitsToDollars(receipt.cost) : usdcBaseUnitsToDollars(Number(offeringState.deposit || 0));
  const pricePer = paidUnits > 0 ? paidCostUsd / paidUnits : 0;
  const txLabel = receipt && receipt.txHash
    ? <a className="linkbtn" href={basescanTx(receipt.txHash)} target="_blank" rel="noreferrer">View transaction</a>
    : null;

  // Quote for what the buyer is about to purchase.
  const budgetUsdc = voucherPayload
    ? Number(voucherPayload.voucher.amountCapUsdc)
    : Math.floor((+String(amount).replace(/[^0-9.]/g, '') || 0) * 1000000);
  const quoteAvailable = voucherPayload ? remainingUnits : publicRemaining;
  const quoteUnits = budgetUsdc > 0 ? unitsForBudget(curve, offeringState.unitsSold, quoteAvailable, budgetUsdc) : 0;
  const quoteCost = usdcBaseUnitsToDollars(costForUnits(curve, offeringState.unitsSold, quoteUnits));
  const quotePricePer = quoteUnits > 0 ? quoteCost / quoteUnits : 0;

  const claimedByOther = voucherPayload && consumed && !isPaid;
  const refundableDeposit = offeringFailed && wallet && Number(offeringState.deposit || 0) > 0 ? usdcBaseUnitsToDollars(offeringState.deposit) : 0;

  const failedRefundCopy = debugRefunded
    ? 'This project failed to meet the minimum before the close date.'
    : wallet
      ? 'This project failed to meet the minimum before the close date. You can claim your full refund; your tokens return to the project.'
      : 'This project failed to meet the minimum before the close date. Connect the purchasing wallet to claim your full refund.';

  let action;
  if (isPaid && offeringFailed && debugRefunded) {
    action = null;
  } else if (offeringFailed && refundableDeposit > 0) {
    action = (
      <div className="flex justify-end mt-10">
        <Button className="px-6 py-3 text-base font-semibold" data-act="refund" disabled={busy === 'refund'} onClick={handleRefund}>
          {debugPreview ? 'Debug preview only' : busy === 'refund' ? 'Refunding…' : `Claim ${fmtDollars(refundableDeposit)} refund`}
        </Button>
      </div>
    );
  } else if (isPaid) {
    action = null;
  } else if (claimedByOther) {
    action = <Notice className="mt-10">This allocation link has already been claimed or revoked. Ask the issuer for a fresh link.</Notice>;
  } else if (raiseClosed) {
    action = <Notice className="mt-10">{offeringFailed ? 'This project failed to meet the minimum before the close date.' : 'This offering has closed.'} No further buy-ins can be made.</Notice>;
  } else if (!voucherPayload && publicRemaining <= 0) {
    action = <Notice className="mt-10">{offeringState.publicUnits === 0
      ? 'This offering is private.'
      : 'The public allocation of this offering is fully subscribed.'} Ask the issuer for a private allocation link.</Notice>;
  } else if (!wallet) {
    action = (
      <>
        <p className="text-sm t-muted mt-10 mb-3">Your purchase is refundable in full if the round does not reach its minimum of {fmtDollars(minUsd)} by {fmtDate(closeDate)}.</p>
        <Notice>Connect a wallet before purchasing this offering.</Notice>
      </>
    );
  } else {
    action = (
      <>
        <p className="text-sm t-muted mt-10 mb-3">Your purchase is refundable in full if the round does not reach its minimum of {fmtDollars(minUsd)} by {fmtDate(closeDate)}.</p>
        <div className="flex justify-end">
          <Button className="px-6 py-3 text-base font-semibold" data-act="pay" disabled={busy === 'pay' || quoteUnits <= 0} onClick={handlePay}>
            {busy === 'pay' ? 'Purchasing…' : `Purchase ${projectName || 'this offering'}`}
          </Button>
        </div>
      </>
    );
  }

  const heading = voucherPayload
    ? `${projectName || 'PACT offering'} | ${voucherPayload.voucher.buyerName}`
    : projectName || 'PACT offering';

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">{heading}</h1>
        <p className="text-sm t-muted mt-1">This is a Purchase Agreement for Community Tokens (a &ldquo;PACT&rdquo;). You&rsquo;re buying community tokens that align holders with the project and carry no inherent value of their own.</p>
      </div>

      <SectionTitle>Offering details</SectionTitle>
      <DefList className="mb-8">
        <Field label="Raising">
          <span>Up to {fmtDollars(raiseCapacity)}</span><Sub>{fmtDollars(minUsd)} minimum</Sub>
        </Field>
        <Field label="Valuation range" align="none">{fmtMoney(valuationStart)}–{fmtMoney(valuationEnd)} post-money</Field>
        <Field label="Close date">
          <span>{fmtDate(closeDate)}</span><Sub>{relDays(closeDate)}</Sub>
        </Field>
        <Field label="Treasury" align="none">
          {offeringState.treasury ? <AddressLink address={offeringState.treasury} /> : <span className="t-muted">Not set</span>}
        </Field>
        <Field label="Contract" align="none">
          <AddressLink address={offeringAddress} />
        </Field>
      </DefList>

      {isPaid && offeringFailed ? <Notice className="mb-5 text-sm">{failedRefundCopy}</Notice> : null}

      {!isPaid && !raiseClosed && !claimedByOther ? (
        voucherPayload ? (
          <>
            <SectionTitle>Allocation details</SectionTitle>
            <DefList className="mb-5">
              <Field label="Buyer" align="none">{voucherPayload.voucher.buyerName}</Field>
              <Field label="Amount" align="none">{fmtDollars(usdcBaseUnitsToDollars(budgetUsdc))}</Field>
              <Field label="Implied ownership">
                <span>{fmtPct(quoteUnits / TOTAL_TOKENS * 100)}</span><Sub>{fmtTokens(quoteUnits)} tokens</Sub>
              </Field>
              <Field label="Price per token" align="none">{fmtPrice(quotePricePer)}</Field>
            </DefList>
          </>
        ) : publicRemaining > 0 ? (
          <>
            <SectionTitle>Your purchase</SectionTitle>
            <DefList className="mb-5">
              <Field label="Amount" align="none">
                <span className="whitespace-nowrap"><span className="t-muted">$</span>{' '}
                  <input className="blank w-28 text-left" inputMode="decimal" placeholder="0.00" autoComplete="off" value={amount} onChange={e => setAmount(formatAmountInput(e.target.value))} />
                </span>
              </Field>
              <Field label="Display name" align="none">
                <input className="blank w-44 text-left" placeholder="Optional, public" autoComplete="off" value={buyerName} onChange={e => setBuyerName(e.target.value)} />
              </Field>
              <Field label="Implied ownership">
                <span>{fmtPct(quoteUnits / TOTAL_TOKENS * 100)}</span><Sub>{fmtTokens(quoteUnits)} tokens</Sub>
              </Field>
              <Field label="Price per token" align="none">{quoteUnits > 0 ? fmtPrice(quotePricePer) : '—'}</Field>
              <Field label="Publicly available">
                <span>{fmtTokens(publicRemaining)} tokens</span>
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
                <span>{debugRefunded ? 'Refunded' : 'Refundable'}</span>
              </span>
              {debugRefunded ? txLabel : null}
            </dd>
            <Field label="Refund amount" align="none">{fmtDollars(refundableDeposit || paidCostUsd)}</Field>
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
            <Field label="Amount" align="none">{fmtDollars(paidCostUsd)}</Field>
            <Field label="Ownership" align="none">
              <span>{fmtPct(paidUnits / TOTAL_TOKENS * 100)}</span><span className="t-muted ml-2">{fmtTokens(paidUnits)} tokens</span>
            </Field>
            <Field label="Price per token" align="none">{fmtPrice(pricePer)}</Field>
          </DefList>
        </>
      ) : null}

      {action}
    </>
  );
}

injectChrome();
createRoot(document.getElementById('app')!).render(<AppProviders><BuyApp /></AppProviders>);
