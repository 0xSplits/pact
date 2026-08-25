import "#pages/home.css";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useAccount } from "wagmi";

import { StatusBadge } from "#components/ui.tsx";
import { valuationForUnitIndex } from "#lib/chain/curve.ts";
import { TOTAL_LIQUID_SPLIT_UNITS } from "#lib/chain/liquid-split.ts";
import { loadWalletRecords } from "#lib/chain/offerings.ts";
import type { OfferingLifecycle, WalletRecords } from "#lib/chain/offerings.ts";
import { offeringStateCurve } from "#lib/chain/onchain.ts";
import type { OfferingRecord } from "#lib/chain/onchain.ts";
import {
  fmtPct,
  fmtTokens,
  fmtUsd,
  usdcBaseUnitsToDollars,
} from "#lib/format.ts";
import { buyPath, CREATE_PATH, statusPath, termsPath } from "#lib/routes.ts";

const PAPER = "paper px-10 py-12 sm:px-16 sm:py-16";

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
            href={CREATE_PATH}
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
      <h2 className="text-lg font-semibold mb-2">{title}</h2>
      {children || <p className="t-muted text-sm">{empty}</p>}
    </section>
  );
}

// Live reads degrade to no lifecycle; show absence rather than a stale guess.
// Dashboard-flavoured states derived from the contract state enum (0 active,
// 1 failed, 2 closed), minMet, and the close date.
type OfferingState = "loading" | "open" | "funded" | "failed" | "expired";

function offeringDashState(
  lifecycle: OfferingLifecycle | undefined,
  closeDate: number,
): OfferingState {
  if (!lifecycle) return "loading";
  if (lifecycle.state === 1) return "failed";
  if (lifecycle.state === 2) return "funded";
  // Still active onchain: open until the close date passes without the
  // minimum — then it can no longer succeed, but nobody has finalized it yet.
  if (!lifecycle.minMet && Date.now() > closeDate * 1000) return "expired";
  return "open";
}

function OfferingStatusCell({
  state,
  raised,
}: {
  state: OfferingState;
  raised: bigint;
}) {
  if (state === "loading") return <span className="t-muted">—</span>;
  const raisedText = fmtUsd(usdcBaseUnitsToDollars(raised), "cents");
  const { tone, label } =
    state === "open"
      ? { tone: "funding", label: `Open: ${raisedText} raised` }
      : state === "funded"
        ? { tone: "secured", label: `Closed: ${raisedText} raised` }
        : state === "failed"
          ? { tone: "failed", label: "Closed: failed minimum" }
          : { tone: "failed", label: "Expired: close date passed" };
  return <StatusBadge status={{ tone, label, note: "" }} />;
}

function finalValuation(
  record: OfferingRecord,
  unitsSold: number,
  remainingUnits: number,
) {
  const curve = offeringStateCurve(record);
  return valuationForUnitIndex(
    curve,
    unitsSold + remainingUnits,
    TOTAL_LIQUID_SPLIT_UNITS,
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
            Offerings and purchase receipts connected to this wallet.
          </p>
        </div>
        <a
          className="cta inline-flex items-center justify-center px-4 py-2 text-sm font-semibold whitespace-nowrap"
          href={CREATE_PATH}
        >
          Create PACT
        </a>
      </div>

      <DashboardTable title="Offerings" empty="No offerings yet.">
        {pacts.length ? (
          <table className="exhibit">
            <thead>
              <tr>
                <th>Project</th>
                <th>Round</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pacts.map((pact) => {
                const target = pact.target ?? 0n;
                const unitsSold = pact.unitsSold ?? 0;
                const remainingUnits = pact.remainingUnits ?? 0;
                const valuation = finalValuation(
                  pact,
                  unitsSold,
                  remainingUnits,
                );
                const state = offeringDashState(pact.lifecycle, pact.closeDate);
                return (
                  <tr key={pact.offering}>
                    <td>
                      <a className="linkbtn" href={statusPath(pact.offering)}>
                        {pact.projectName || "Untitled offering"}
                      </a>
                    </td>
                    <td>
                      {fmtUsd(usdcBaseUnitsToDollars(target), "cents")} on{" "}
                      {fmtUsd(valuation, "whole")}
                    </td>
                    <td>
                      <OfferingStatusCell
                        state={state}
                        raised={pact.raised ?? 0n}
                      />
                    </td>
                  </tr>
                );
              })}
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
                <th className="num">Purchased</th>
                <th>Ownership</th>
                <th className="num">Receipt</th>
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
                  <td>
                    {fmtPct((purchase.units / TOTAL_LIQUID_SPLIT_UNITS) * 100)}
                    <span className="t-muted">
                      {" "}
                      ({fmtTokens(purchase.units)} units)
                    </span>
                  </td>
                  <td className="num">
                    {purchase.txHash ? (
                      <a
                        className="linkbtn"
                        href={termsPath(purchase.offering, purchase.txHash)}
                      >
                        View
                      </a>
                    ) : (
                      <span className="t-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </DashboardTable>
    </div>
  );
}

export function HomeApp() {
  const wallet = useAccount().address ?? null;
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
