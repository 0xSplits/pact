import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import "./home.css";
import { fmtUsd, fmtTokens, usdcBaseUnitsToDollars } from "../lib/format.ts";
import { mountPage } from "../components/wallet.tsx";
import { useWallet } from "../hooks/use-wallet.ts";
import { buyPath, createPath, statusPath } from "../lib/routes.ts";
import { loadWalletRecords } from "../lib/chain/offerings.ts";
import type { WalletRecords } from "../lib/chain/offerings.ts";

const PAPER = "paper px-10 py-12 sm:px-14 sm:py-16";

function Explainer() {
  return (
    <>
      <div className={PAPER}>
        <div className="mb-9">
          <h1 className="text-2xl font-bold">PACT</h1>
          <p className="mt-1 text-sm t-muted">
            Purchase Agreement for Community Tokens
          </p>
        </div>

        <div className="mb-10">
          <section className="overview-section">
            <h2>Why</h2>
            <p>
              Every project starts before incorporation. Capital can be raised
              at this stage, but it&rsquo;s clunky: receipts are email threads,
              working capital sits in personal accounts, and the cap table is
              undefined. Deals at this stage don&rsquo;t need legal paperwork,
              since it&rsquo;s trust, reputation, and the repeat game that holds
              participants accountable.
            </p>
          </section>
          <section className="overview-section">
            <h2>What</h2>
            <p>
              PACT is a lightweight tool for raising capital without a legal
              framework. It&rsquo;s a placeholder for future value: equity,
              tokens, revenue share, or whatever the project turns into.
              Creators get a funded treasury and a programmable cap table;
              backers get public receipts and a claim on the project&rsquo;s
              future value.
            </p>
          </section>
          <section className="overview-section">
            <h2>How</h2>
            <ol className="list-decimal">
              <li>
                Create a private issuance with a cap table, target amount,
                valuation, and close date. Holders receive their units; the rest
                go on a bonding curve to be purchased by backers.
              </li>
              <li>
                Send each backer a private allocation link, or share the public
                buy link. Backers purchase their allocations and receive units
                in return.
              </li>
              <li>
                If the round hits its minimum, the treasury withdraws and the
                round closes. If it doesn&rsquo;t, backers are refunded.
              </li>
            </ol>
          </section>
        </div>

        <div className="flex justify-end">
          <a
            className="cta inline-flex items-center justify-center px-6 py-3 text-base font-semibold"
            href={createPath()}
          >
            Create PACT
          </a>
        </div>
      </div>

      <p className="mt-6 text-sm t-muted text-center">
        Experimental and unaudited — use with caution.
      </p>
    </>
  );
}

function DashboardTable({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children?: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="font-bold mb-2">{title}</div>
      {children || <p className="t-muted text-sm">{empty}</p>}
    </section>
  );
}

function Dashboard({ records }: { records: WalletRecords }) {
  const { pacts, purchases } = records;
  return (
    <div className={PAPER}>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Your PACTs</h1>
          <p className="mt-1 text-sm t-muted">
            Issuances and purchase receipts connected to this wallet.
          </p>
        </div>
        <a
          className="cta inline-flex items-center justify-center px-4 py-2 text-sm font-semibold whitespace-nowrap"
          href={createPath()}
        >
          Create PACT
        </a>
      </div>

      <DashboardTable title="Issuances" empty="No issuances yet.">
        {pacts.length ? (
          <table className="exhibit">
            <thead>
              <tr>
                <th>Project</th>
                <th className="num">Raised</th>
                <th className="num">Target</th>
              </tr>
            </thead>
            <tbody>
              {pacts.map((pact) => (
                <tr key={pact.offering}>
                  <td>
                    <a className="linkbtn" href={statusPath(pact.offering)}>
                      {pact.projectName || "Untitled issuance"}
                    </a>
                  </td>
                  <td className="num">
                    {fmtUsd(usdcBaseUnitsToDollars(pact.raised || 0), "cents")}
                  </td>
                  <td className="num">
                    {fmtUsd(usdcBaseUnitsToDollars(pact.target || 0), "cents")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </DashboardTable>

      <DashboardTable title="Purchases" empty="No purchases yet.">
        {purchases.length ? (
          <table className="exhibit">
            <thead>
              <tr>
                <th>Project</th>
                <th className="num">Amount</th>
                <th className="num">Units</th>
              </tr>
            </thead>
            <tbody>
              {purchases.map((purchase) => (
                <tr key={purchase.txHash + ":" + purchase.logIndex}>
                  <td>
                    <a className="linkbtn" href={buyPath(purchase.offering)}>
                      {(purchase.record && purchase.record.projectName) ||
                        "Untitled purchase"}
                    </a>
                  </td>
                  <td className="num">
                    {fmtUsd(usdcBaseUnitsToDollars(purchase.cost), "cents")}
                  </td>
                  <td className="num">{fmtTokens(purchase.units)}</td>
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
  const { data: records, isPending } = useQuery({
    queryKey: ["home-records", wallet ? wallet.toLowerCase() : null],
    enabled: !!wallet,
    queryFn: () => loadWalletRecords(wallet!),
  });

  if (wallet && isPending) {
    return (
      <div className={PAPER}>
        <h1 className="text-2xl font-bold">Your PACTs</h1>
        <p className="mt-3 t-muted">Loading onchain records…</p>
      </div>
    );
  }

  if (wallet && records && (records.pacts.length || records.purchases.length)) {
    return <Dashboard records={records} />;
  }

  return <Explainer />;
}

mountPage(<HomeApp />);
