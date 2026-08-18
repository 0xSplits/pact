import "#pages/status.css";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Address, Hex } from "viem";
import { useAccount } from "wagmi";

import {
  AddressLink,
  Button,
  DefList,
  Field,
  Notice,
  SectionTitle,
  StatusBadge,
  Sub,
  TextButton,
} from "#components/ui.tsx";
import { useDebugMenu } from "#hooks/use-debug-menu.ts";
import { useOfferingState } from "#hooks/use-offering-state.ts";
import type { OfferingSnapshot } from "#hooks/use-offering-state.ts";
import { toUsdcBaseUnits } from "#lib/chain/chain.ts";
import { costForUnits, valuationForUnitIndex } from "#lib/chain/curve.ts";
import { TOTAL_LIQUID_SPLIT_UNITS } from "#lib/chain/liquid-split.ts";
import { offeringStatus } from "#lib/chain/offering-status.ts";
import type { StatusInfo } from "#lib/chain/offering-status.ts";
import {
  findOffering,
  getPactTokenHolders,
  listBought,
  listOfferings,
} from "#lib/chain/offerings.ts";
import {
  availablePublicUnits,
  cancelAllocation,
  closeAndWithdrawOffering,
  getOfferingState,
  markOfferingFailed,
  offeringStateCurve,
  refundAllOffering,
  setPublicUnits,
  signVoucher,
  sweepFailedUnits,
  withdrawOffering,
} from "#lib/chain/onchain.ts";
import type {
  OfferingRecord,
  OfferingState,
  Purchase,
} from "#lib/chain/onchain.ts";
import {
  encodeVoucherFragment,
  listAllocationLedger,
  markAllocationLedgerRowRevoked,
  newAllocationKey,
  saveAllocationLedgerRow,
} from "#lib/chain/voucher.ts";
import type { AllocationLedgerRow } from "#lib/chain/voucher.ts";
import {
  basescanTx,
  errMsg,
  fmtDate,
  fmtPct,
  fmtShortDate,
  fmtTokens,
  fmtUsd,
  formatAmountInput,
  MS_PER_DAY,
  parseMoney,
  relDays,
  shortAddr,
  usdcBaseUnitsToDollars,
} from "#lib/format.ts";
import {
  absoluteUrl,
  buyLinkPath,
  buyPath,
  CREATE_PATH,
  currentOfferingAddress,
} from "#lib/routes.ts";
import { debugActive } from "#lib/ui/debug-menu.ts";
import { copyText, showToast } from "#lib/ui/toast.ts";
import { isSameAddress } from "#lib/validate.ts";

const offeringAddress = currentOfferingAddress();

// The offering fields the page renders. Debug snapshots synthesize them from
// the listing record without an address; live reads carry the full state.
type OfferingView = Omit<OfferingState, "offeringAddress" | "pactToken"> &
  Partial<Pick<OfferingState, "offeringAddress" | "pactToken">>;

function debugOfferingSnapshot(
  record: OfferingRecord,
  live: OfferingView | null,
  debugState: string,
): OfferingView | null {
  if (!debugActive(debugState) || ["loading", "error"].includes(debugState))
    return live;
  const offerTokens = live ? live.unitsSold + live.remainingUnits : 200;
  const raiseMin = BigInt(record.raiseMin);
  const base = {
    remainingUnits: offerTokens,
    unitsSold: 0,
    raised: 0n,
    withdrawn: 0n,
    raiseMin,
    closeDate: Math.floor((Date.now() + 7 * MS_PER_DAY) / 1000),
    owner: record.treasury,
    treasury: record.treasury,
    pactToken: record.pactToken,
    priceStart: BigInt(record.priceStart),
    priceSlope: BigInt(record.priceSlope),
    publicUnits: record.publicUnits,
    publicUnitsSold: 0,
    minMet: false,
    state: 0,
    ...(live || {}),
  };
  const securedBase = (raiseMin * 12n) / 10n;
  const quarterUnits = Math.max(1, Math.floor(offerTokens / 4));
  const halfUnits = Math.max(1, Math.floor(offerTokens / 2));
  if (debugState === "funding") {
    return {
      ...base,
      unitsSold: quarterUnits,
      remainingUnits: offerTokens - quarterUnits,
      raised: raiseMin / 2n,
      withdrawn: 0n,
      minMet: false,
      state: 0,
    };
  }
  if (debugState === "secured") {
    return {
      ...base,
      unitsSold: halfUnits,
      remainingUnits: offerTokens - halfUnits,
      raised: securedBase,
      withdrawn: 0n,
      minMet: true,
      state: 0,
    };
  }
  if (debugState === "withdrawn") {
    return {
      ...base,
      unitsSold: halfUnits,
      remainingUnits: offerTokens - halfUnits,
      raised: securedBase,
      withdrawn: securedBase,
      minMet: true,
      state: 0,
    };
  }
  if (debugState === "failed") {
    return {
      ...base,
      unitsSold: quarterUnits,
      remainingUnits: offerTokens - quarterUnits,
      raised: raiseMin / 2n,
      withdrawn: 0n,
      closeDate: Math.floor((Date.now() - MS_PER_DAY) / 1000),
      minMet: false,
      state: 1,
    };
  }
  if (debugState === "closed") {
    return {
      ...base,
      unitsSold: halfUnits,
      remainingUnits: offerTokens - halfUnits,
      raised: securedBase,
      withdrawn: securedBase,
      minMet: true,
      state: 2,
    };
  }
  return live;
}

interface OfferingAction {
  action: string;
  label: string;
  cta: string;
  note: string;
  disabled?: boolean;
  tooltip?: string;
  secondary?: boolean;
  warning?: boolean;
  icon?: "copy";
}

function offeringActionsFor({
  onchainOffering,
  connectedWallet,
  closeDate,
  canManage,
  refundBuyers,
  refundTotal,
  remainingUnits,
  projectName,
}: {
  onchainOffering: OfferingView | null;
  connectedWallet: string | null;
  closeDate: number;
  canManage: boolean;
  refundBuyers: string[];
  refundTotal: number;
  remainingUnits: number;
  projectName: string;
}): OfferingAction[] {
  if (!onchainOffering || !connectedWallet) return [];
  if (onchainOffering.state === 2) return [];
  const ownerAddress = onchainOffering.owner || null;
  const isOwner = ownerAddress
    ? isSameAddress(connectedWallet, ownerAddress)
    : false;
  const claimable = usdcBaseUnitsToDollars(
    onchainOffering.raised > onchainOffering.withdrawn
      ? onchainOffering.raised - onchainOffering.withdrawn
      : 0n,
  );
  const pastClose = Date.now() > closeDate;
  const canTopUp =
    canManage &&
    onchainOffering.state === 0 &&
    (!pastClose || onchainOffering.minMet);
  const actions: OfferingAction[] = [];
  if (onchainOffering.state === 0 || onchainOffering.minMet) {
    const withdrawDisabled = !onchainOffering.minMet || claimable <= 0;
    const withdrawTooltip = !onchainOffering.minMet
      ? "Minimum not yet reached"
      : claimable <= 0
        ? "No funds available to withdraw"
        : "";
    actions.push({
      action: "withdraw",
      label: "Withdraw proceeds",
      cta: `Withdraw ${fmtUsd(claimable)}`,
      note: "Transfer raised funds to your treasury",
      disabled: withdrawDisabled,
      tooltip: withdrawTooltip,
    });
  }
  if (canTopUp) {
    actions.push({
      action: "top-up",
      label: "Increase offering",
      cta: shortAddr(onchainOffering.offeringAddress || offeringAddress),
      note: `Send additional ${projectName || "offering"} units to the offering contract`,
      secondary: true,
      icon: "copy",
    });
  }
  if (onchainOffering.state === 0 && !onchainOffering.minMet && pastClose) {
    actions.push({
      action: "mark-failed",
      label: "Mark failed",
      cta: "Mark failed",
      note: "Enable refunds",
    });
  }
  if (onchainOffering.state === 1) {
    const refundDisabled = !isOwner || refundBuyers.length === 0;
    const refundTooltip = !isOwner
      ? "Connect owner wallet to refund all"
      : refundBuyers.length === 0
        ? "No buyer wallets available to refund"
        : "";
    const buyerLabel =
      refundBuyers.length === 1 ? "1 buyer" : `${refundBuyers.length} buyers`;
    actions.push({
      action: "refund-all",
      label: "Refund buyers",
      cta: `Refund ${fmtUsd(refundTotal)}`,
      note: `Return deposits to all ${buyerLabel}`,
      disabled: refundDisabled,
      tooltip: refundTooltip,
    });
    if (remainingUnits > 0) {
      actions.push({
        action: "sweep-failed",
        label: "Reclaim tokens",
        cta: `Sweep ${fmtTokens(remainingUnits)} tokens`,
        note: "Return unsold and refunded tokens to treasury",
        secondary: true,
      });
    }
  }
  if (onchainOffering.state === 0) {
    const closeDisabled = !isOwner || !onchainOffering.minMet;
    const closeTooltip = !isOwner
      ? `Connect owner wallet${ownerAddress ? ` ${shortAddr(ownerAddress)}` : ""} to close round`
      : !onchainOffering.minMet
        ? "Minimum not yet reached"
        : "";
    actions.push({
      action: "close",
      label: "Close round",
      cta: "Close round",
      note: "Withdraw funds and return unsold tokens to treasury",
      warning: true,
      disabled: closeDisabled,
      tooltip: closeTooltip,
    });
  }
  return actions;
}

function disabledContractReadActions(
  actions: OfferingAction[],
  tooltip: string,
  projectName: string,
): OfferingAction[] {
  const disabled: OfferingAction[] = actions.length
    ? actions
    : [
        {
          action: "withdraw",
          label: "Withdraw proceeds",
          cta: "Withdraw",
          note: "Transfer raised funds to your treasury",
        },
        {
          action: "top-up",
          label: "Increase offering",
          cta: shortAddr(offeringAddress),
          note: `Send additional ${projectName || "offering"} units to the offering contract`,
          secondary: true,
          icon: "copy",
        },
        {
          action: "close",
          label: "Close round",
          cta: "Close round",
          note: "Withdraw funds and return unsold tokens to treasury",
          warning: true,
        },
      ];
  return disabled.map((action) => ({ ...action, disabled: true, tooltip }));
}

const CopyIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

function OfferingActions({
  actions,
  busyAction,
  onAction,
}: {
  actions: OfferingAction[];
  busyAction: string | null;
  onAction: (action: string) => void;
}) {
  if (!actions.length) return null;
  return (
    <div className="offering-actions no-print">
      <SectionTitle className="mt-10">Offering actions</SectionTitle>
      <div className="offering-action-group">
        {actions.map((action) => {
          const busy = busyAction === action.action;
          return (
            <div className="offering-action-row" key={action.action}>
              <div className="offering-action-copy">
                <div className="offering-action-label">{action.label}</div>
                <div className="t-muted text-sm">{action.note}</div>
              </div>
              <div className="offering-action-controls">
                <span className="action-tip-wrap">
                  <Button
                    variant={
                      action.warning
                        ? "warning"
                        : action.secondary
                          ? "secondary"
                          : "primary"
                    }
                    className="px-4 text-sm font-semibold"
                    data-offering-action={action.action}
                    disabled={action.disabled || busy}
                    onClick={() => onAction(action.action)}
                  >
                    {busy ? (
                      "Confirming…"
                    ) : (
                      <>
                        {action.cta}
                        {action.icon === "copy" ? <CopyIcon /> : null}
                      </>
                    )}
                  </Button>
                  {action.tooltip ? (
                    <span className="action-tip">{action.tooltip}</span>
                  ) : null}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ProgressSeg {
  label: string;
  amountUsd: number;
  left: number;
  width: number;
  funded: boolean;
}

function ProgressTrack({
  segs,
  minPct,
  minTip,
  raisedNode,
  secondaryNodes,
  maxLabel,
}: {
  segs: ProgressSeg[];
  minPct: number;
  minTip: string;
  raisedNode: ReactNode;
  secondaryNodes: ReactNode;
  maxLabel: string;
}) {
  return (
    <div className="mt-4">
      <div className="track-wrap">
        {segs.map((s, i) => (
          <div
            className={`seg ${s.funded ? "funded" : "allocated"}`}
            style={{ left: s.left + "%", width: s.width + "%" }}
            key={i}
          >
            <span className="tip">
              {s.label}: {fmtUsd(s.amountUsd, "cents")}
            </span>
          </div>
        ))}
        <div className="minmark" style={{ left: minPct + "%" }}>
          <div className="tip">{minTip}</div>
        </div>
      </div>
      <div className="flex justify-between items-baseline mt-2 text-sm tabular-nums">
        <div className="flex items-baseline gap-3">
          <span>{raisedNode}</span>
          {secondaryNodes}
        </div>
        <span className="t-muted">{maxLabel}</span>
      </div>
    </div>
  );
}

function AllocationEntryRow({
  onCancel,
  onAdd,
}: {
  onCancel: () => void;
  onAdd: (name: string, amountUsd: number) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const trimmed = name.trim();
    const parsed = parseMoney(amount);
    if (!trimmed || !(parsed > 0)) {
      setError(
        !trimmed ? "Enter a buyer name." : "Enter an amount greater than 0.",
      );
      return;
    }
    setBusy(true);
    try {
      await onAdd(trimmed, parsed);
    } catch (err) {
      setError(errMsg(err, "Could not create allocation."));
      setBusy(false);
    }
  }

  return (
    <tr className="alloc-entry no-print">
      <td>
        <input
          id="allocName"
          className="blank"
          placeholder="Buyer name"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck="false"
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </td>
      <td className="num">
        <div className="flex items-center gap-1">
          <span className="t-muted">$</span>
          <input
            id="allocAmount"
            className="blank text-right"
            inputMode="decimal"
            placeholder="0.00"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(formatAmountInput(e.target.value))}
          />
        </div>
      </td>
      <td>
        <p
          id="allocError"
          className={`${error ? "" : "hidden "}text-sm t-danger`}
        >
          {error}
        </p>
      </td>
      <td className="num whitespace-nowrap">
        <span className="alloc-actions">
          <TextButton tone="danger" data-act="cancel-add" onClick={onCancel}>
            Cancel
          </TextButton>
          <TextButton data-act="add" disabled={busy} onClick={add}>
            {busy ? "Waiting for signature…" : "Generate link"}
          </TextButton>
        </span>
      </td>
    </tr>
  );
}

// Purchases straight from Bought events, plus the ledger's still-unclaimed
// links. The ledger is display convenience; the events are the truth.
interface FundedRow {
  key: string;
  status: "funded";
  name: string;
  isPublic: boolean;
  buyer: Address;
  units: number;
  cost: string;
  txHash: string | null;
  blockNumber: number | null;
  link: string | null;
}

interface OpenRow {
  key: string;
  status: "allocated" | "revoked";
  name: string;
  allocationId: Hex;
  amountUsd: number;
  createdAt: number;
  link: string;
}

function allocationRows(
  bought: Purchase[],
  ledger: AllocationLedgerRow[],
): { funded: FundedRow[]; open: OpenRow[] } {
  const claimedIds = new Set(
    bought.map((p) => String(p.allocationId).toLowerCase()),
  );
  const ledgerById = new Map(
    ledger.map((row) => [String(row.allocationId).toLowerCase(), row]),
  );
  const funded = bought.map((p): FundedRow => {
    const ledgerRow = ledgerById.get(String(p.allocationId).toLowerCase());
    const isPublic = /^0x0+$/.test(String(p.allocationId));
    return {
      key: p.txHash + ":" + p.logIndex,
      status: "funded",
      name: p.buyerName || (ledgerRow && ledgerRow.name) || shortAddr(p.buyer),
      isPublic,
      buyer: p.buyer,
      units: p.units,
      cost: p.cost,
      txHash: p.txHash,
      blockNumber: p.blockNumber,
      link: ledgerRow ? ledgerRow.link : null,
    };
  });
  const open = ledger
    .filter((row) => !claimedIds.has(String(row.allocationId).toLowerCase()))
    .map((row): OpenRow => ({
      key: row.allocationId,
      status: row.revokedAt ? "revoked" : "allocated",
      name: row.name,
      allocationId: row.allocationId,
      amountUsd: row.amountCapUsd,
      createdAt: row.createdAt,
      link: row.link,
    }));
  return { funded, open };
}

function AllocationsTable({
  rows,
  publicUnitsAvailable,
  publicOpenUsd,
  publicBuyUrl,
  publicQuantityDisabledReason,
  offeringOpen,
  entryOpen,
  onOpenEntry,
  onCancelEntry,
  onAdd,
  onRevoke,
  onChangePublicQuantity,
}: {
  rows: { funded: FundedRow[]; open: OpenRow[] };
  publicUnitsAvailable: number;
  publicOpenUsd: number;
  publicBuyUrl: string;
  publicQuantityDisabledReason: string;
  offeringOpen: boolean;
  entryOpen: boolean;
  onOpenEntry: () => void;
  onCancelEntry: () => void;
  onAdd: (name: string, amountUsd: number) => Promise<void>;
  onRevoke: (row: OpenRow) => void;
  onChangePublicQuantity: () => void;
}) {
  const { funded, open } = rows;
  return (
    <>
      <SectionTitle className="mt-10">Purchases &amp; allocations</SectionTitle>
      <table className="exhibit alloc-table">
        <thead>
          <tr>
            <th>Buyer</th>
            <th className="num">Amount</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {funded.map((row) => {
            const cost = usdcBaseUnitsToDollars(row.cost);
            return (
              <tr key={row.key}>
                <td>
                  {row.name}
                  {row.isPublic ? (
                    <span className="t-muted"> · public</span>
                  ) : null}
                </td>
                <td className="num">{fmtUsd(cost)}</td>
                <td>
                  Purchased{" "}
                  <span className="tokencell">
                    {fmtTokens(row.units)} tokens
                    <span className="tip2">
                      {row.units > 0 ? fmtUsd(cost / row.units, "cents") : "—"}{" "}
                      / token
                    </span>
                  </span>
                </td>
                <td className="num whitespace-nowrap">
                  <span className="alloc-actions">
                    {row.txHash ? (
                      <AddressLink
                        className="act muted"
                        href={basescanTx(row.txHash)}
                      >
                        View txn
                      </AddressLink>
                    ) : null}
                    {row.link ? (
                      <TextButton
                        tone="muted"
                        data-act="copy"
                        onClick={() => copyText(row.link!)}
                      >
                        Copy link
                      </TextButton>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
          <tr>
            <td>Public allocation</td>
            <td className="num">
              {offeringOpen && publicUnitsAvailable > 0
                ? `~${fmtUsd(publicOpenUsd)}`
                : "—"}
            </td>
            <td>
              {offeringOpen ? (
                <span className="badge allocated">
                  {fmtTokens(publicUnitsAvailable)} units open
                </span>
              ) : (
                <span className="badge revoked">Expired</span>
              )}
            </td>
            <td className="num whitespace-nowrap">
              <span className="alloc-actions">
                <span className="action-tip-wrap">
                  <TextButton
                    tone="muted"
                    data-act="change-public"
                    disabled={!!publicQuantityDisabledReason}
                    onClick={onChangePublicQuantity}
                  >
                    Change quantity
                  </TextButton>
                  {publicQuantityDisabledReason ? (
                    <span className="action-tip">
                      {publicQuantityDisabledReason}
                    </span>
                  ) : null}
                </span>
                <span className="action-tip-wrap">
                  <TextButton
                    tone="muted"
                    data-act="copy-public"
                    disabled={!offeringOpen || publicUnitsAvailable === 0}
                    onClick={() => copyText(publicBuyUrl, "Public link copied")}
                  >
                    Copy link
                  </TextButton>
                  {!offeringOpen ? (
                    <span className="action-tip">Offering is not open</span>
                  ) : publicUnitsAvailable === 0 ? (
                    <span className="action-tip">
                      No public units available
                    </span>
                  ) : null}
                </span>
              </span>
            </td>
          </tr>
          {open.map((row) => (
            <tr key={row.key}>
              <td>{row.name}</td>
              <td className="num">{fmtUsd(row.amountUsd)}</td>
              <td>
                {row.status === "revoked" ? (
                  <span className="badge revoked">Revoked</span>
                ) : !offeringOpen ? (
                  <span className="badge revoked">Expired</span>
                ) : (
                  <>
                    <span className="badge allocated">Allocated</span>{" "}
                    {row.createdAt ? (
                      <span>{fmtShortDate(row.createdAt)}</span>
                    ) : null}
                  </>
                )}
              </td>
              <td className="num whitespace-nowrap">
                {row.status === "revoked" ? null : (
                  <span className="alloc-actions">
                    <TextButton
                      tone="danger"
                      data-act="revoke"
                      onClick={() => onRevoke(row)}
                    >
                      Revoke
                    </TextButton>
                    <TextButton
                      tone="muted"
                      data-act="copy"
                      onClick={() => copyText(row.link)}
                    >
                      Copy link
                    </TextButton>
                  </span>
                )}
              </td>
            </tr>
          ))}
          {!offeringOpen ? null : entryOpen ? (
            <AllocationEntryRow onCancel={onCancelEntry} onAdd={onAdd} />
          ) : (
            <tr className="addrow no-print">
              <td colSpan={4}>
                <button data-act="open-add" type="button" onClick={onOpenEntry}>
                  + New allocation
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

interface CapTableState {
  status: "loading" | "loaded" | "error";
  holders?: Array<{ address: Address; balance: number }> | undefined;
  error?: string | undefined;
}

function CapTable({
  record,
  capTable,
  buyerNames,
  canManage,
}: {
  record: OfferingRecord;
  capTable: CapTableState | null;
  buyerNames: Map<string, string>;
  canManage: boolean;
}) {
  const holders = (
    capTable && capTable.holders && capTable.holders.length
      ? capTable.holders
      : []
  )
    .slice()
    .sort((a, b) => {
      const ac = isSameAddress(a.address, offeringAddress) ? 1 : 0;
      const bc = isSameAddress(b.address, offeringAddress) ? 1 : 0;
      if (ac !== bc) return ac - bc;
      return String(a.address || "").toLowerCase() >
        String(b.address || "").toLowerCase()
        ? 1
        : -1;
    });
  const totalTokens = holders.reduce(
    (sum, holder) => sum + Number(holder.balance || 0),
    0,
  );

  return (
    <>
      <SectionTitle className="mt-10">Cap table</SectionTitle>
      {capTable && capTable.status === "error" ? (
        <p className="text-sm t-muted mb-2">{capTable.error}</p>
      ) : null}
      <table className="exhibit mb-10">
        <thead>
          <tr>
            <th>Holder</th>
            <th className="num">Tokens</th>
            <th className="num">Ownership</th>
          </tr>
        </thead>
        <tbody>
          {!holders.length ? (
            <tr>
              <td colSpan={3} className="px-2 py-5 text-center t-muted">
                {capTable && capTable.status === "loading"
                  ? "Reading onchain cap table…"
                  : "No cap table entries yet."}
              </td>
            </tr>
          ) : (
            holders.map((holder) => {
              const address = holder.address;
              const isCurve = isSameAddress(address, offeringAddress);
              const buyerName = canManage
                ? buyerNames.get(String(address || "").toLowerCase())
                : null;
              return (
                <tr className={isCurve ? "highlight" : undefined} key={address}>
                  <td>
                    {isCurve
                      ? "PACT offering: "
                      : buyerName
                        ? buyerName + ": "
                        : ""}
                    <AddressLink className="value-link" address={address} />
                  </td>
                  <td className="num">{fmtTokens(holder.balance)}</td>
                  <td className="num">
                    {fmtPct((holder.balance / TOTAL_LIQUID_SPLIT_UNITS) * 100)}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td className="num">{fmtTokens(totalTokens)}</td>
            <td className="num">
              {fmtPct((totalTokens / TOTAL_LIQUID_SPLIT_UNITS) * 100)}
            </td>
          </tr>
          <tr className="footnote">
            <td colSpan={3}>
              Verify this cap table by viewing the token contract at{" "}
              {record.pactToken ? (
                <AddressLink
                  className="value-link"
                  address={record.pactToken}
                />
              ) : (
                <span className="t-muted">Not deployed</span>
              )}
              .
            </td>
          </tr>
        </tfoot>
      </table>
    </>
  );
}

// Progress-bar segments: funded raise first, then the still-open allocations
// stacked after it until the track runs out.
function buildProgressSegs(
  raisedTotal: number,
  openRows: OpenRow[],
  progressMax: number,
): ProgressSeg[] {
  const segs: ProgressSeg[] = [];
  if (raisedTotal > 0)
    segs.push({
      label: "Onchain purchases",
      amountUsd: raisedTotal,
      left: 0,
      width: Math.min((raisedTotal / progressMax) * 100, 100),
      funded: true,
    });
  let cum = raisedTotal;
  openRows.forEach((row) => {
    const left = (cum / progressMax) * 100;
    if (left < 100)
      segs.push({
        label: row.name,
        amountUsd: row.amountUsd,
        left,
        width: Math.min((row.amountUsd / progressMax) * 100, 100 - left),
        funded: false,
      });
    cum += row.amountUsd;
  });
  return segs;
}

// Everything StatusApp renders, derived from the listing record, the live
// snapshot, and the allocation ledger. Pure so the JSX below stays scannable.
function deriveStatusView({
  record,
  offering,
  debugState,
  wallet,
  bought,
  ledger,
}: {
  record: OfferingRecord;
  offering: OfferingSnapshot;
  debugState: string;
  wallet: string | null;
  bought: Purchase[];
  ledger: AllocationLedgerRow[];
}) {
  const loadedOffering =
    offering && offering.status === "loaded" ? offering : null;
  const onchainOffering = debugOfferingSnapshot(
    record,
    loadedOffering,
    debugState,
  );
  const offeringReadFailed =
    !debugActive(debugState) && offering && offering.status === "error";
  const debugReadFailed = debugState === "error";
  const offeringLoading =
    debugState === "loading" || !offering || offering.status === "loading";
  const canManage =
    !!wallet &&
    (onchainOffering
      ? isSameAddress(wallet, onchainOffering.owner) ||
        isSameAddress(wallet, onchainOffering.treasury)
      : isSameAddress(wallet, record.issuer) ||
        isSameAddress(wallet, record.treasury));

  const curve =
    onchainOffering && onchainOffering.priceStart > 0
      ? offeringStateCurve(onchainOffering)
      : offeringStateCurve(record);
  const raisedTotal = onchainOffering
    ? usdcBaseUnitsToDollars(onchainOffering.raised)
    : 0;
  const purchased = onchainOffering ? onchainOffering.unitsSold : 0;
  const closeDate =
    (onchainOffering && onchainOffering.closeDate
      ? onchainOffering.closeDate
      : record.closeDate) * 1000;
  const pastClose = Date.now() > closeDate;
  const open = onchainOffering
    ? onchainOffering.state === 0 && (!pastClose || onchainOffering.minMet)
    : !pastClose;
  const minUsd = usdcBaseUnitsToDollars(
    onchainOffering ? onchainOffering.raiseMin : record.raiseMin,
  );
  const localStatus = onchainOffering
    ? offeringStatus({
        state: onchainOffering.state,
        minMet: onchainOffering.minMet,
        closeDate: onchainOffering.closeDate || record.closeDate,
      })
    : null;
  const statusInfo: StatusInfo = (() => {
    if (debugState === "loading")
      return { label: "Loading…", tone: "loading", note: "" };
    if (debugState === "error")
      return {
        label: "Contract read failed",
        tone: "failed",
        note: "Refresh to retry",
      };
    if (localStatus) return localStatus;
    if (offering && offering.status === "error")
      return {
        label: "Contract read failed",
        tone: "failed",
        note: "Refresh to retry",
      };
    return { label: "Loading…", tone: "loading", note: "" };
  })();
  const claimable = onchainOffering
    ? usdcBaseUnitsToDollars(
        onchainOffering.raised > onchainOffering.withdrawn
          ? onchainOffering.raised - onchainOffering.withdrawn
          : 0n,
      )
    : 0;
  const remainingUnits = onchainOffering ? onchainOffering.remainingUnits : 0;
  const remainingCapacity = usdcBaseUnitsToDollars(
    costForUnits(curve, purchased, remainingUnits),
  );
  const progressMax = Math.max(
    raisedTotal + remainingCapacity,
    minUsd,
    raisedTotal,
    0.000001,
  );
  const valStart = valuationForUnitIndex(curve, 0, TOTAL_LIQUID_SPLIT_UNITS);
  const valNow = valuationForUnitIndex(
    curve,
    purchased,
    TOTAL_LIQUID_SPLIT_UNITS,
  );
  const valEnd = valuationForUnitIndex(
    curve,
    purchased + remainingUnits,
    TOTAL_LIQUID_SPLIT_UNITS,
  );

  const rows = allocationRows(bought, ledger);
  const refundBuyers = Array.from(
    new Set(bought.map((p) => p.buyer.toLowerCase())),
  );
  const refundTotal = usdcBaseUnitsToDollars(
    bought.reduce((sum, p) => sum + BigInt(p.cost), 0n),
  );
  // The ledger rows come from localStorage, so coerce before summing.
  const allocatedTotal = rows.open.reduce(
    (sum, row) => sum + Number(row.amountUsd || 0),
    0,
  );
  const buyerNames = new Map(
    bought
      .filter((p) => p.buyerName)
      .map((p) => [p.buyer.toLowerCase(), p.buyerName]),
  );

  const liveActionItems = onchainOffering
    ? offeringActionsFor({
        onchainOffering,
        connectedWallet: wallet,
        closeDate,
        canManage,
        refundBuyers,
        refundTotal,
        remainingUnits,
        projectName: record.projectName,
      })
    : [];
  const actionItems = offeringLoading
    ? disabledContractReadActions(
        liveActionItems,
        "Reading contract state",
        record.projectName,
      )
    : offeringReadFailed || debugReadFailed
      ? disabledContractReadActions(
          liveActionItems,
          "Cannot read contract state",
          record.projectName,
        )
      : liveActionItems;

  const segs =
    !offeringLoading && onchainOffering
      ? buildProgressSegs(raisedTotal, rows.open, progressMax)
      : [];
  const minPct = Math.min(100, (minUsd / progressMax) * 100);
  const over = raisedTotal + allocatedTotal - progressMax; // committed beyond live capacity

  const publicTreasury = onchainOffering
    ? onchainOffering.treasury
    : record.treasury;
  const publicUnitsAvailable = onchainOffering
    ? availablePublicUnits(onchainOffering)
    : 0;
  const publicOpenUsd = onchainOffering
    ? usdcBaseUnitsToDollars(
        costForUnits(
          offeringStateCurve(onchainOffering),
          onchainOffering.unitsSold,
          publicUnitsAvailable,
        ),
      )
    : 0;
  const publicQuantityDisabledReason = !onchainOffering
    ? "Reading contract state"
    : onchainOffering.state !== 0
      ? "Offering is not open"
      : !wallet || !isSameAddress(wallet, onchainOffering.owner)
        ? "Connect owner wallet to adjust"
        : "";
  const publicOwner = onchainOffering && onchainOffering.owner;
  const showOwner = publicOwner && !isSameAddress(publicOwner, publicTreasury);

  return {
    onchainOffering,
    offeringLoading,
    canManage,
    statusInfo,
    closeDate,
    open,
    minUsd,
    raisedTotal,
    claimable,
    remainingUnits,
    progressMax,
    valStart,
    valNow,
    valEnd,
    rows,
    allocatedTotal,
    buyerNames,
    actionItems,
    segs,
    minPct,
    over,
    publicTreasury,
    publicUnitsAvailable,
    publicOpenUsd,
    publicQuantityDisabledReason,
    publicOwner,
    showOwner,
  };
}

export function StatusApp() {
  const [ledger, setLedger] = useState<AllocationLedgerRow[]>([]);
  const [entryOpen, setEntryOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const debugState = useDebugMenu([
    { value: "live", label: "Live" },
    { value: "loading", label: "Loading" },
    { value: "error", label: "Read failed" },
    { value: "funding", label: "Open — below minimum" },
    { value: "secured", label: "Open — minimum reached" },
    { value: "withdrawn", label: "Withdrawn" },
    { value: "failed", label: "Failed" },
    { value: "closed", label: "Closed" },
  ]);

  const wallet = useAccount().address ?? null;
  const queryClient = useQueryClient();
  const { offering, refresh: refreshOffering } = useOfferingState({
    offeringAddress,
  });

  const recordQuery = useQuery({
    queryKey: ["offering-record", offeringAddress],
    enabled: !!offeringAddress,
    queryFn: async () => {
      try {
        return findOffering(await listOfferings(), offeringAddress);
      } catch (err) {
        console.warn("Could not scan offerings", err);
        return null;
      }
    },
    staleTime: Infinity,
  });
  // `undefined` = still scanning (render nothing), `null` = not found.
  const record: OfferingRecord | null | undefined = !offeringAddress
    ? null
    : recordQuery.data;

  const boughtQuery = useQuery({
    queryKey: ["bought", record?.offering ?? null],
    enabled: !!record,
    queryFn: () =>
      listBought({
        offering: record!.offering,
        deployBlock: record!.blockNumber || undefined,
      }),
  });
  const bought = boughtQuery.data ?? [];

  const capTableQuery = useQuery({
    queryKey: ["cap-table", record?.offering ?? null],
    enabled: !!record,
    queryFn: () =>
      getPactTokenHolders({
        pactToken: record!.pactToken,
        deployBlock: record!.blockNumber || undefined,
      }),
  });
  const capTable: CapTableState | null = !record
    ? null
    : {
        status: capTableQuery.isError
          ? "error"
          : capTableQuery.data
            ? "loaded"
            : "loading",
        holders: capTableQuery.data,
        error: capTableQuery.isError
          ? errMsg(capTableQuery.error, "Could not read onchain cap table.")
          : undefined,
      };

  const refreshRecordDetails = useCallback(
    (current: OfferingRecord) => {
      queryClient.invalidateQueries({ queryKey: ["bought", current.offering] });
      queryClient.invalidateQueries({
        queryKey: ["cap-table", current.offering],
      });
    },
    [queryClient],
  );

  useEffect(() => {
    if (record) setLedger(listAllocationLedger(record.offering));
  }, [record]);

  // The cap table and purchase list shift whenever units sell.
  const soldUnits =
    offering && offering.status === "loaded" ? offering.unitsSold : null;
  const firstCapRefreshRef = useRef(true);
  useEffect(() => {
    if (soldUnits == null || !record) return;
    if (firstCapRefreshRef.current) {
      firstCapRefreshRef.current = false;
      return;
    }
    refreshRecordDetails(record);
  }, [soldUnits, record, refreshRecordDetails]);

  async function handleOfferingAction(action: string) {
    if (debugActive(debugState)) {
      showToast("Debug preview only");
      return;
    }
    if (!record || !wallet) return;
    if (action === "top-up") {
      copyText(record.offering, "Offering address copied");
      return;
    }
    if (
      action === "close" &&
      !confirm(
        "Close this round? This withdraws funds, returns unsold tokens to treasury, and cannot be undone.",
      )
    )
      return;
    let openUnitsInput: number | null = null;
    if (action === "set-public-units") {
      if (!offering || offering.status !== "loaded") return;
      const current = availablePublicUnits(offering);
      const answer = prompt(
        `Publicly available units (currently ${current}, maximum ${offering.remainingUnits}):`,
        String(current),
      );
      if (answer == null) return;
      const openUnits = Math.floor(
        Number(String(answer).replace(/[^0-9]/g, "")),
      );
      if (!(openUnits >= 0)) return;
      openUnitsInput = openUnits;
    }
    setBusyAction(action);
    try {
      const base = { offeringAddress: record.offering, from: wallet };
      if (action === "withdraw") {
        await withdrawOffering(base);
        showToast("Proceeds withdrawn to treasury");
      } else if (action === "close") {
        await closeAndWithdrawOffering(base);
        showToast("Round closed");
      } else if (action === "mark-failed") {
        await markOfferingFailed(base);
        showToast("Offering marked failed");
      } else if (action === "refund-all") {
        const buyers = Array.from(new Set(bought.map((p) => p.buyer)));
        await refundAllOffering({ ...base, buyers });
        showToast("Refunds sent");
      } else if (action === "sweep-failed") {
        await sweepFailedUnits(base);
        showToast("Tokens returned to treasury");
      } else if (action === "set-public-units") {
        const fresh = await getOfferingState({
          offeringAddress: record.offering,
        });
        if (openUnitsInput! > fresh.remainingUnits) {
          throw new Error(
            `Only ${fmtTokens(fresh.remainingUnits)} units remain in the offering.`,
          );
        }
        await setPublicUnits({
          ...base,
          publicUnits: fresh.publicUnitsSold + openUnitsInput!,
        });
        showToast("Public allocation updated");
      }
      await refreshOffering();
      refreshRecordDetails(record);
    } catch (err) {
      showToast(errMsg(err, "Transaction failed"));
    }
    setBusyAction(null);
  }

  // Allocation creation is free: a link key is generated, the owner wallet
  // signs the voucher, and the link itself is the only capability.
  async function handleAddAllocation(name: string, amountUsd: number) {
    if (!wallet || !record) throw new Error("Connect the owner wallet first.");
    const { linkPrivateKey, linkKey, allocationId } = newAllocationKey();
    const voucher = {
      allocationId,
      buyerName: name,
      amountCapUsdc: String(toUsdcBaseUnits(amountUsd)),
      linkKey,
    };
    const ownerSig = await signVoucher({
      owner: wallet,
      offeringAddress: record.offering,
      voucher,
    });
    const fragmentPayload = encodeVoucherFragment({
      voucher,
      ownerSig,
      linkPrivateKey,
    });
    const link = absoluteUrl(buyLinkPath(record.offering, fragmentPayload));
    const row = {
      allocationId,
      name,
      amountCapUsd: amountUsd,
      link,
      createdAt: Date.now(),
    };
    saveAllocationLedgerRow(record.offering, row);
    setLedger(listAllocationLedger(record.offering));
    setEntryOpen(false);
    copyText(link, "Link copied — send it to " + name);
  }

  async function handleRevokeAllocation(row: OpenRow) {
    if (!record || !wallet) return;
    if (
      !confirm(
        "Revoke the allocation link for " +
          row.name +
          "? This sends a transaction.",
      )
    )
      return;
    try {
      await cancelAllocation({
        offeringAddress: record.offering,
        from: wallet,
        allocationId: row.allocationId,
      });
      markAllocationLedgerRowRevoked(
        record.offering,
        row.allocationId,
        Date.now(),
      );
      setLedger(listAllocationLedger(record.offering));
      showToast("Allocation revoked");
    } catch (err) {
      showToast(errMsg(err, "Could not revoke allocation"));
    }
  }

  if (record === undefined) {
    return offeringAddress ? (
      <p className="t-muted">Loading onchain records…</p>
    ) : null;
  }
  if (!record) {
    return (
      <>
        <h1 className="text-2xl font-bold">PACT not found</h1>
        <p className="t-muted mt-3">
          No issuance matches this link.{" "}
          <a href={CREATE_PATH} className="linkbtn">
            Create one
          </a>
          .
        </p>
      </>
    );
  }

  const {
    onchainOffering,
    offeringLoading,
    canManage,
    statusInfo,
    closeDate,
    open,
    minUsd,
    raisedTotal,
    claimable,
    remainingUnits,
    progressMax,
    valStart,
    valNow,
    valEnd,
    rows,
    allocatedTotal,
    buyerNames,
    actionItems,
    segs,
    minPct,
    over,
    publicTreasury,
    publicUnitsAvailable,
    publicOpenUsd,
    publicQuantityDisabledReason,
    publicOwner,
    showOwner,
  } = deriveStatusView({
    record,
    offering,
    debugState,
    wallet,
    bought,
    ledger,
  });

  return (
    <>
      <div className="mb-2 flex items-start justify-between gap-4">
        <div className="w-full">
          <h1 className="text-2xl font-bold">
            {record.projectName || "PACT offering"}
          </h1>
          <p className="text-sm t-muted mt-1">
            <AddressLink address={record.offering} />
          </p>
          {!canManage ? (
            <Notice className="no-print mt-4 text-sm t-muted">
              Connect with the treasury or creator wallet to manage the
              offering.
            </Notice>
          ) : null}
        </div>
      </div>

      <SectionTitle className="mt-8">Offering details</SectionTitle>
      <DefList>
        <Field label="Target amount" loading={offeringLoading}>
          <span>Up to {fmtUsd(progressMax)}</span>
          <Sub>{fmtUsd(minUsd, "cents")} minimum</Sub>
        </Field>
        <Field label="Valuation range" loading={offeringLoading}>
          <span>
            {fmtUsd(valStart)}–{fmtUsd(valEnd)} post-money
          </span>
        </Field>
        <Field label="Close date">
          <span>{fmtDate(closeDate)}</span>
          {relDays(closeDate, { pastDates: false }) ? (
            <Sub>{relDays(closeDate, { pastDates: false })}</Sub>
          ) : null}
        </Field>
        <Field label="Treasury" align="none">
          {publicTreasury ? (
            <AddressLink address={publicTreasury} />
          ) : (
            <span className="t-muted">Not set</span>
          )}
        </Field>
        {publicOwner && showOwner ? (
          <Field label="Owner" align="none">
            <AddressLink address={publicOwner} />
          </Field>
        ) : null}
      </DefList>

      <SectionTitle className="mt-10">Offering state</SectionTitle>
      <DefList>
        <Field label="Status" align="center">
          <StatusBadge status={statusInfo} />
        </Field>
        <Field label="Raised" loading={offeringLoading}>
          <span>{fmtUsd(raisedTotal)}</span>
          <Sub>{fmtUsd(claimable)} claimable</Sub>
        </Field>
        <Field label="Available" loading={offeringLoading}>
          <span>
            {fmtPct((remainingUnits / TOTAL_LIQUID_SPLIT_UNITS) * 100)}
          </span>
          <Sub>{fmtTokens(remainingUnits)} tokens</Sub>
        </Field>
        <Field label="Valuation" loading={offeringLoading}>
          <span>{fmtUsd(valNow)} post-money</span>
          <Sub>
            {fmtUsd(valNow / TOTAL_LIQUID_SPLIT_UNITS, "price")} / token
          </Sub>
        </Field>
      </DefList>

      {canManage ? (
        <>
          <ProgressTrack
            segs={segs}
            minPct={minPct}
            minTip={`Minimum: ${fmtUsd(minUsd, "cents")}`}
            raisedNode={
              offeringLoading ? (
                <span className="font-bold t-muted">Loading…</span>
              ) : (
                <>
                  <span className="font-bold">{fmtUsd(raisedTotal)}</span>{" "}
                  raised
                </>
              )
            }
            secondaryNodes={
              offeringLoading ? null : (
                <>
                  {onchainOffering ? (
                    <>
                      <Sub>{fmtUsd(claimable)} claimable</Sub>
                      <Sub>
                        {fmtUsd(
                          usdcBaseUnitsToDollars(onchainOffering.withdrawn),
                        )}{" "}
                        withdrawn
                      </Sub>
                    </>
                  ) : null}
                  {allocatedTotal > 0 ? (
                    <Sub>{fmtUsd(allocatedTotal)} allocated</Sub>
                  ) : null}
                  {over > 0 ? (
                    <span className="text-pending">
                      {fmtUsd(over)} oversubscribed
                    </span>
                  ) : null}
                </>
              )
            }
            maxLabel={offeringLoading ? "" : fmtUsd(progressMax)}
          />
          <OfferingActions
            actions={actionItems}
            busyAction={busyAction}
            onAction={handleOfferingAction}
          />
          <AllocationsTable
            rows={rows}
            publicUnitsAvailable={publicUnitsAvailable}
            publicOpenUsd={publicOpenUsd}
            publicBuyUrl={absoluteUrl(buyPath(record.offering))}
            publicQuantityDisabledReason={publicQuantityDisabledReason}
            offeringOpen={open}
            entryOpen={entryOpen}
            onOpenEntry={() => setEntryOpen(true)}
            onCancelEntry={() => setEntryOpen(false)}
            onAdd={handleAddAllocation}
            onRevoke={handleRevokeAllocation}
            onChangePublicQuantity={() =>
              handleOfferingAction("set-public-units")
            }
          />
        </>
      ) : null}

      <CapTable
        record={record}
        capTable={capTable}
        buyerNames={buyerNames}
        canManage={canManage}
      />
    </>
  );
}
