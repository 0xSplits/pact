import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './home.css';
import { injectChrome } from '../lib/chrome.js';
import { PactAPI } from '../lib/api.js';
import { fmtDollars, fmtTokens, usdcBaseUnitsToDollars } from '../lib/format.js';
import { PactSettings } from '../lib/settings.js';
import { useWallet } from '../lib/use-wallet.js';
import { allocationPath, createPath, pactPath } from '../lib/routes.js';

const PAPER = 'paper px-10 py-12 sm:px-14 sm:py-16';

function Explainer() {
  return (
    <>
      <div className={PAPER}>
        <div className="mb-9">
          <h1 className="text-2xl font-bold">PACT</h1>
          <p className="mt-1 text-sm t-muted">Purchase Agreement for Community Tokens</p>
        </div>

        <div className="mb-10">
          <section className="overview-section">
            <h2>Why</h2>
            <p>
              Every project starts before incorporation. Capital can be raised at this stage, but it&rsquo;s clunky: receipts are email threads, working capital sits in personal accounts, and the cap table is undefined. Deals at this stage don&rsquo;t need legal paperwork, since it&rsquo;s trust, reputation, and the repeat game that holds participants accountable.
            </p>
          </section>
          <section className="overview-section">
            <h2>What</h2>
            <p>
              PACT is a lightweight tool for raising capital without a legal framework. It&rsquo;s a placeholder for future value: equity, tokens, revenue share, or whatever the project turns into. Creators get a funded treasury and a programmable cap table; backers get public receipts and a claim on the project&rsquo;s future value.
            </p>
          </section>
          <section className="overview-section">
            <h2>How</h2>
            <ol className="list-decimal">
              <li>Create a private issuance with a cap table, target amount, valuation, and close date. Holders receive their tokens; the rest go on a bonding curve to be purchased by backers.</li>
              <li>Send each backer a private allocation link. Backers purchase their allocations and receive tokens in return.</li>
              <li>If the round hits its minimum, the treasury withdraws and the round closes. If it doesn&rsquo;t, backers are refunded.</li>
            </ol>
          </section>
        </div>

        <div className="flex justify-end">
          <a className="cta inline-flex items-center justify-center px-6 py-3 text-base font-semibold" href={createPath()}>Create PACT</a>
        </div>
      </div>

      <p className="mt-6 text-sm t-muted text-center">Experimental and unaudited — use with caution.</p>
    </>
  );
}

function DashboardTable({ title, empty, children }) {
  return (
    <section className="mb-8">
      <div className="font-bold mb-2">{title}</div>
      {children || <p className="t-muted text-sm">{empty}</p>}
    </section>
  );
}

function Dashboard({ records }) {
  const pacts = records.pacts || [];
  const purchases = records.purchases || [];
  return (
    <div className={PAPER}>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Your PACTs</h1>
          <p className="mt-1 text-sm t-muted">Issuances and purchase receipts connected to this wallet.</p>
        </div>
        <a className="cta inline-flex items-center justify-center px-4 py-2 text-sm font-semibold whitespace-nowrap" href={createPath()}>Create PACT</a>
      </div>

      <DashboardTable title="Issuances" empty="No issuances yet.">
        {pacts.length ? (
          <table className="exhibit">
            <thead><tr><th>Project</th><th className="num">Raised</th><th className="num">Target</th></tr></thead>
            <tbody>
              {pacts.map(pact => (
                <tr key={pact.id}>
                  <td><a className="linkbtn" href={pactPath(pact.id)}>{pact.projectName || 'Untitled issuance'}</a></td>
                  <td className="num">{fmtDollars(pact.fundedTotal || 0)}</td>
                  <td className="num">{fmtDollars(pact.raise && pact.raise.max || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </DashboardTable>

      <DashboardTable title="Purchases" empty="No purchases yet.">
        {purchases.length ? (
          <table className="exhibit">
            <thead><tr><th>Project</th><th className="num">Amount</th><th className="num">Tokens</th></tr></thead>
            <tbody>
              {purchases.map(purchase => (
                <tr key={purchase.pactId + ':' + purchase.allocationId}>
                  <td><a className="linkbtn" href={allocationPath(purchase.pactId, purchase.allocationId)}>{purchase.projectName || 'Untitled purchase'}</a></td>
                  <td className="num">{fmtDollars(usdcBaseUnitsToDollars(purchase.purchaseCostUsdcBaseUnits) || purchase.amountUsd || 0)}</td>
                  <td className="num">{fmtTokens(purchase.tokensPurchased || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </DashboardTable>
    </div>
  );
}

function HomeApp() {
  const wallet = useWallet();
  const [records, setRecords] = useState(null);

  useEffect(() => {
    if (!wallet) {
      setRecords(null);
      return;
    }
    let cancelled = false;
    setRecords({ status: 'loading' });
    Promise.all([
      PactAPI.listPacts(wallet).then(result => result.pacts || []).catch(() => []),
      PactAPI.listPurchases(wallet).then(result => result.purchases || []).catch(() => []),
    ]).then(([pacts, purchases]) => {
      if (!cancelled) setRecords({ status: 'loaded', pacts, purchases });
    });
    return () => { cancelled = true; };
  }, [wallet]);

  if (records && records.status === 'loading') {
    return (
      <div className={PAPER}>
        <h1 className="text-2xl font-bold">Your PACTs</h1>
        <p className="mt-3 t-muted">Loading…</p>
      </div>
    );
  }

  if (records && records.status === 'loaded' && ((records.pacts || []).length || (records.purchases || []).length)) {
    return <Dashboard records={records} />;
  }

  return <Explainer />;
}

injectChrome();
PactSettings.init({ buttonId: 'settingsToggle' });
createRoot(document.getElementById('app')).render(<HomeApp />);
