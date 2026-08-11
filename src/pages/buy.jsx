import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { injectChrome } from '../lib/chrome.js';
import { showToast } from '../lib/toast.js';
import { PactAPI } from '../lib/api.js';
import { PactWallet } from '../lib/wallet.js';
import { PactSettings } from '../lib/settings.js';
import { useWallet } from '../lib/use-wallet.js';
import { useOfferingState } from '../lib/use-offering-state.js';
import { isTxHash } from '../lib/validate.js';
import {
  fmtMoney, fmtDollars, fmtPct, fmtTokens, fmtPrice, fmtDate, usdcBaseUnitsToDollars,
  basescanTx,
} from '../lib/format.js';
import { tokensBetween, offeringCurveParams, costForUnits, unitsForBudget, valuationForUnitIndex } from '../lib/curve.js';
import { initDebugMenu, isLocalhost } from '../lib/debug-menu.js';
import { currentAllocationRoute } from '../lib/routes.js';
import { getOfferingPurchaseFromTx, getOfferingPurchaseForBuyer, buyOffering, refundOffering } from '../lib/onchain.js';
import { AddressLink, Button, DefList, Field, Notice, SectionTitle, Sub } from '../components/ui.jsx';

const { pactId, allocationId } = currentAllocationRoute();

const relDays = ts => { const d = Math.ceil((ts - Date.now()) / 86400000); return d > 1 ? 'in ' + d + ' days' : d === 1 ? 'in 1 day' : d === 0 ? 'today' : d === -1 ? '1 day ago' : Math.abs(d) + ' days ago'; };

const fundedTotal = pact => pact.allocations.filter(a => a.status === 'funded').reduce((s, a) => s + a.amountUsd, 0);

function debugActive(debugState) {
  return isLocalhost() && debugState !== 'live';
}

function debugOfferingSnapshot(pact, allocation, live, debugState) {
  if (!debugActive(debugState)) return live;
  const curveUnits = Number(pact && pact.newMoney && pact.newMoney.tokens || 0);
  const base = {
    remainingUnits: curveUnits,
    unitsSold: 0,
    minMet: false,
    state: 0,
    raised: 0,
    withdrawn: 0,
    raiseMin: Math.round(Number(pact && pact.raise && pact.raise.min || 0) * 1000000),
    closeDate: Math.floor((Date.now() + 7 * 86400000) / 1000),
    deposit: allocation && allocation.status === 'funded'
      ? Number(allocation.purchaseCostUsdcBaseUnits || Math.round(Number(allocation.amountUsd || 0) * 1000000))
      : 0,
    ...(live || {}),
  };
  if (debugState === 'funding') return { ...base, state: 0, minMet: false };
  if (debugState === 'failed') return { ...base, state: 1, minMet: false, closeDate: Math.floor((Date.now() - 86400000) / 1000) };
  if (debugState === 'refunded') return { ...base, state: 1, minMet: false, closeDate: Math.floor((Date.now() - 86400000) / 1000), deposit: 0 };
  if (debugState === 'closed') return { ...base, state: 2, minMet: true };
  return live;
}

function tokensForFunded(pact, allocation) {
  const funded = pact.allocations.filter(x => x.status === 'funded').sort((a, b) => (a.fundedAt || 0) - (b.fundedAt || 0));
  let cum = 0;
  for (const x of funded) {
    if (x.id === allocation.id) return tokensBetween(pact, cum, cum + x.amountUsd);
    cum += x.amountUsd;
  }
  return 0;
}

function receiptKey(pact, allocation) {
  return [
    pact && pact.id,
    allocation && allocation.id,
    pact && pact.liquidSplitAddress,
    allocation && allocation.buyerWallet,
  ].join(':');
}

function PageNotice({ title, children }) {
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

function BuyApp() {
  // `undefined` = still fetching (render nothing), `null` = not found.
  const [pact, setPact] = useState(undefined);
  const [receipt, setReceipt] = useState(null);
  const [debugState, setDebugState] = useState('live');
  const [busy, setBusy] = useState(null);
  const [debugPreview, setDebugPreview] = useState(false);
  const debugRef = useRef('live');
  const recoveringRef = useRef(false);

  const wallet = useWallet({
    onError: err => showToast(err.message || 'Could not connect wallet.'),
  });
  const { offering, refresh: refreshOffering } = useOfferingState({
    offeringAddress: pact && pact.offeringAddress,
    buyer: wallet,
  });

  const allocation = pact ? (pact.allocations || []).find(x => x.id === allocationId) : null;

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
    (async () => {
      if (!pactId) {
        setPact(null);
        return;
      }
      let loaded = null;
      try {
        loaded = await PactAPI.getPact(pactId);
      } catch (err) {}
      setPact(loaded);
    })();
  }, []);

  useEffect(() => {
    if (pact && allocation) document.title = `${pact.projectName} | ${allocation.name}`;
  }, [pact, allocation]);

  // Confirm the recorded purchase against the chain.
  useEffect(() => {
    if (!pact || !allocation || allocation.status !== 'funded') return;
    if (!pact.offeringAddress || !allocation.buyerWallet || !allocation.txHash) return;
    const key = receiptKey(pact, allocation);
    setReceipt({ key, status: 'loading' });
    (async () => {
      try {
        const purchase = await getOfferingPurchaseFromTx({
          offeringAddress: pact.offeringAddress,
          txHash: allocation.txHash,
          buyer: allocation.buyerWallet,
        });
        setReceipt({ key, status: 'loaded', tokens: Number(purchase.units), cost: Number(purchase.cost) });
      } catch (err) {
        setReceipt({ key, status: 'error', error: err.message || 'Could not read onchain ownership.' });
      }
    })();
  }, [pact && pact.id, allocation && allocation.id, allocation && allocation.status, allocation && allocation.txHash]);

  // Self-heal: a purchase can settle onchain and still miss the local
  // database (browser closed between transaction and record). If this wallet
  // has a deposit but no funded allocation anywhere in the PACT, recover the
  // purchase from the Bought event and record it.
  const deposit = offering && offering.status === 'loaded' ? Number(offering.deposit || 0) : 0;
  useEffect(() => {
    if (!wallet || !pact || !allocation || allocation.status === 'funded' || deposit <= 0) return;
    if (debugActive(debugState) || recoveringRef.current) return;
    const alreadyRecorded = (pact.allocations || []).some(a =>
      a.status === 'funded' && String(a.buyerWallet || '').toLowerCase() === String(wallet).toLowerCase());
    if (alreadyRecorded) return;
    recoveringRef.current = true;
    (async () => {
      try {
        const purchase = await getOfferingPurchaseForBuyer({
          offeringAddress: pact.offeringAddress,
          buyer: wallet,
          deploymentTxHash: pact.offeringTxHash,
        });
        if (!purchase) return;
        const result = await PactAPI.fundAllocation(pact.id, allocation.id, wallet, {
          txHash: purchase.txHash,
          tokensPurchased: purchase.units,
          purchaseCostUsdcBaseUnits: purchase.cost,
        });
        setPact(result.pact);
      } catch (err) {
        console.warn('Could not recover onchain purchase', err);
      } finally {
        recoveringRef.current = false;
      }
    })();
  }, [wallet, deposit, pact && pact.id, allocation && allocation.id, allocation && allocation.status, debugState]);

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
    if (!pact || !pact.offeringAddress) return;
    setBusy('refund');
    try {
      await refundOffering({ provider: PactWallet.provider, offeringAddress: pact.offeringAddress, from: wallet });
      await refreshOffering();
    } catch (err) {
      showToast(err.message || 'Could not complete refund.');
    }
    setBusy(null);
  }

  async function handlePay() {
    if (!wallet) {
      showToast('Connect a wallet before purchasing this offering.');
      return;
    }
    if (!allocation) return;
    setBusy('pay');
    try {
      const purchase = await buyOffering({
        provider: PactWallet.provider,
        pact,
        buyer: wallet,
        amountUsd: allocation.amountUsd,
      });
      const result = await PactAPI.fundAllocation(pact.id, allocation.id, wallet, {
        txHash: purchase.buyTxHash,
        tokensPurchased: purchase.units,
        purchaseCostUsdcBaseUnits: purchase.cost,
      });
      setPact(result.pact);
      setReceipt(null);
      refreshOffering();
    } catch (err) {
      showToast(err.message || 'Could not complete purchase.');
    }
    setBusy(null);
  }

  if (pact === undefined) return null;
  if (!pact) return <PageNotice title="Link not found">This buy-in link doesn’t match any known offering.</PageNotice>;
  if (!allocation) return <PageNotice title="Link not found">This allocation no longer exists — the project may have removed it.</PageNotice>;

  const a = allocation;
  const funded = fundedTotal(pact);
  const liveOfferingState = offering && offering.status === 'loaded' ? offering : null;
  const offeringState = debugOfferingSnapshot(pact, a, liveOfferingState, debugState);
  const closeDate = offeringState && offeringState.closeDate ? offeringState.closeDate * 1000 : pact.createdAt + pact.minimum.deadlineDays * 86400000;
  const offeringFailed = offeringState && offeringState.state === 1;
  const debugRefunded = debugState === 'refunded';
  const offeringClosed = offeringState && offeringState.state === 2;
  const raiseClosed = offeringState ? offeringFailed || offeringClosed || (offeringState.state === 0 && Date.now() > closeDate && !offeringState.minMet) : funded >= pact.raise.max || Date.now() > closeDate;
  const curve = offeringCurveParams(pact);
  const remainingUnits = offeringState ? Number(offeringState.remainingUnits || 0) : Math.max(0, Number(pact.newMoney && pact.newMoney.tokens || 0) - tokensBetween(pact, 0, funded));
  const remainingCapacity = offeringState && curve ? usdcBaseUnitsToDollars(costForUnits(curve, Number(offeringState.unitsSold || 0), remainingUnits)) : Math.max(0, pact.raise.max - funded);
  const raisedTotal = offeringState ? usdcBaseUnitsToDollars(offeringState.raised) : funded;
  const raiseCapacity = offeringState && curve ? Math.max(raisedTotal + remainingCapacity, pact.raise.min, raisedTotal) : pact.raise.max;
  const valuationStart = curve ? valuationForUnitIndex(curve, 0, pact.totalTokens) : pact.valuation.floor;
  const valuationEnd = curve ? valuationForUnitIndex(curve, Number(offeringState && offeringState.unitsSold || 0) + remainingUnits, pact.totalTokens) : pact.valuation.ceiling;
  const isPaid = a.status === 'funded';
  const localTokens = isPaid ? tokensForFunded(pact, a) : tokensBetween(pact, funded, funded + a.amountUsd);
  const receiptState = receipt && receipt.key === receiptKey(pact, a) ? receipt : null;
  const dbTokens = Number(a.tokensPurchased || 0);
  const dbCostBaseUnits = Number(a.purchaseCostUsdcBaseUnits || 0);
  const hasPurchaseData = isPaid && dbTokens > 0 && dbCostBaseUnits > 0;
  const hasOnchainReceipt = isPaid && receiptState && receiptState.status === 'loaded';
  const purchasedTokens = hasPurchaseData ? dbTokens : (hasOnchainReceipt ? receiptState.tokens : localTokens);
  const purchaseCost = hasPurchaseData ? usdcBaseUnitsToDollars(dbCostBaseUnits) : (hasOnchainReceipt ? usdcBaseUnitsToDollars(receiptState.cost) : a.amountUsd);
  const allocationQuote = !isPaid && offeringState && curve
    ? (() => {
        const sold = Number(offeringState.unitsSold || 0);
        const units = unitsForBudget(curve, sold, Number(offeringState.remainingUnits || 0), Math.floor(Number(a.amountUsd || 0) * 1000000));
        return { units, cost: costForUnits(curve, sold, units) };
      })()
    : null;
  const allocationQuoteLoading = !isPaid && !offeringState;
  const allocationTokens = isPaid ? (localTokens || purchasedTokens) : (allocationQuote ? allocationQuote.units : tokensBetween(pact, funded, funded + a.amountUsd));
  const allocationCost = allocationQuote ? usdcBaseUnitsToDollars(allocationQuote.cost) : a.amountUsd;
  const allocationPricePer = allocationTokens > 0 ? allocationCost / allocationTokens : 0;
  const pricePer = purchasedTokens > 0 ? purchaseCost / purchasedTokens : 0;
  const refundAmount = usdcBaseUnitsToDollars(Number(a.purchaseCostUsdcBaseUnits || 0) || Math.round(Number(a.amountUsd || 0) * 1000000));
  const refundableDeposit = offeringFailed && wallet && offeringState && Number(offeringState.deposit || 0) > 0 ? usdcBaseUnitsToDollars(offeringState.deposit) : 0;
  const refundAccount = a.buyerWallet || '';
  const needsRefundAccount = refundAccount && (!wallet || String(wallet).toLowerCase() !== String(refundAccount).toLowerCase());
  const txHash = isTxHash(a.txHash) ? a.txHash : '';
  const txLabel = txHash
    ? <a className="linkbtn" href={basescanTx(txHash)} target="_blank" rel="noreferrer">View transaction</a>
    : <span className="t-muted">Recorded locally</span>;

  const failedRefundCopy = debugRefunded
    ? 'This project failed to meet the minimum before the close date.'
    : (needsRefundAccount
      ? 'This project failed to meet the minimum before the close date. You can claim your full refund by connecting with the wallet used to purchase tokens.'
      : wallet
      ? 'This project failed to meet the minimum before the close date. You can claim your full refund.'
      : 'This project failed to meet the minimum before the close date. Connect the refund account to claim your full refund.');

  let action;
  if (isPaid && offeringFailed && debugRefunded) {
    action = null;
  } else if (isPaid && offeringFailed && refundableDeposit > 0) {
    action = (
      <div className="flex justify-end mt-10">
        <Button className="px-6 py-3 text-base font-semibold" data-act="refund" disabled={busy === 'refund'} onClick={handleRefund}>
          {debugPreview ? 'Debug preview only' : busy === 'refund' ? 'Refunding…' : `Claim ${fmtDollars(refundableDeposit)} refund`}
        </Button>
      </div>
    );
  } else if (isPaid) {
    action = null;
  } else if (raiseClosed) {
    action = <Notice className="mt-10">{offeringFailed ? 'This project failed to meet the minimum before the close date.' : 'This offering has closed.'} No further buy-ins can be made.</Notice>;
  } else if (!wallet) {
    action = (
      <>
        <p className="text-sm t-muted mt-10 mb-3">Your purchase is refundable in full if the round does not reach its minimum of {fmtDollars(pact.raise.min)} by {fmtDate(closeDate)}.</p>
        <Notice>Connect a wallet before purchasing this offering.</Notice>
      </>
    );
  } else {
    action = (
      <>
        <p className="text-sm t-muted mt-10 mb-3">Your purchase is refundable in full if the round does not reach its minimum of {fmtDollars(pact.raise.min)} by {fmtDate(closeDate)}.</p>
        <div className="flex justify-end">
          <Button className="px-6 py-3 text-base font-semibold" data-act="pay" disabled={busy === 'pay'} onClick={handlePay}>
            {busy === 'pay' ? 'Purchasing…' : `Purchase ${pact.projectName}`}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">{pact.projectName} | {a.name}</h1>
        <p className="text-sm t-muted mt-1">This is a Purchase Agreement for Community Tokens (a &ldquo;PACT&rdquo;). You&rsquo;re buying community tokens that align holders with the project and carry no inherent value of their own.</p>
      </div>

      <SectionTitle>Offering details</SectionTitle>
      <DefList className="mb-8">
        <Field label="Raising">
          <span>Up to {fmtDollars(raiseCapacity)}</span><Sub>{fmtDollars(pact.raise.min)} minimum</Sub>
        </Field>
        <Field label="Valuation range" align="none">{fmtMoney(valuationStart)}–{fmtMoney(valuationEnd)} post-money</Field>
        <Field label="Close date">
          <span>{fmtDate(closeDate)}</span><Sub>{relDays(closeDate)}</Sub>
        </Field>
        <Field label="Treasury" align="none">
          {pact.proceedsAddress ? <AddressLink address={pact.proceedsAddress} /> : <span className="t-muted">Not set</span>}
        </Field>
      </DefList>

      {isPaid && offeringFailed ? <Notice className="mb-5 text-sm">{failedRefundCopy}</Notice> : null}

      {!isPaid && !offeringFailed && !offeringClosed ? (
        <>
          <SectionTitle>Allocation details</SectionTitle>
          <DefList className="mb-5">
            <Field label="Amount" align="none">{fmtDollars(a.amountUsd)}</Field>
            <Field label="Implied ownership" loading={allocationQuoteLoading}>
              <span>{fmtPct(allocationTokens / pact.totalTokens * 100)}</span><Sub>{fmtTokens(allocationTokens)} tokens</Sub>
            </Field>
            <Field label="Price per token" align="none" loading={allocationQuoteLoading}>{fmtPrice(allocationPricePer)}</Field>
          </DefList>
        </>
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
            {needsRefundAccount ? (
              <Field label="Refund account" align="none"><AddressLink address={refundAccount} /></Field>
            ) : null}
            <Field label="Refund amount" align="none">{fmtDollars(refundAmount)}</Field>
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
            <Field label="Amount" align="none">{fmtDollars(purchaseCost)}</Field>
            <Field label="Ownership" align="none">
              {receiptState && receiptState.status === 'loading'
                ? <span className="t-muted">Loading onchain ownership…</span>
                : <><span>{fmtPct(purchasedTokens / pact.totalTokens * 100)}</span><span className="t-muted ml-2">{fmtTokens(purchasedTokens)} tokens</span></>}
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
PactSettings.init({ buttonId: 'settingsToggle' });
createRoot(document.getElementById('app')).render(<BuyApp />);
