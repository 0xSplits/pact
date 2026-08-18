// Offering lifecycle status shared by the status page and the home dashboard,
// derived from the contract state enum (0 active, 1 failed, 2 closed), minMet,
// and the close date (unix seconds). Framework-free so node tests exercise it
// directly.
import type { LifecycleEvent, Purchase } from "#lib/chain/onchain.ts";

export interface StatusInfo {
  label: string;
  tone: string;
  note: string;
}

export function offeringStatus(
  offering: { state: number; minMet: boolean; closeDate: number },
  nowMs: number = Date.now(),
): StatusInfo {
  if (offering.state === 1)
    return {
      label: "Failed",
      tone: "failed",
      note: "Minimum amount not met by close date",
    };
  // closeAndWithdraw requires minMet, so closed always means a successful round.
  if (offering.state === 2)
    return { label: "Completed", tone: "secured", note: "Round closed" };
  if (offering.minMet)
    return { label: "Open", tone: "secured", note: "Minimum reached" };
  if (nowMs > offering.closeDate * 1000)
    return {
      label: "Failed",
      tone: "failed",
      note: "Awaiting finalization",
    };
  return { label: "Open", tone: "funding", note: "Minimum not yet reached" };
}

// The render mode the status page picks from the same inputs as
// offeringStatus. "limbo" is a raise past its close date below the minimum
// that nobody has marked failed yet — ended for users, still Funding onchain.
export type OfferingPhase = "live" | "limbo" | "failed" | "closed";

export function offeringPhase(
  offering: { state: number; minMet: boolean; closeDate: number },
  nowMs: number = Date.now(),
): OfferingPhase {
  if (offering.state === 1) return "failed";
  if (offering.state === 2) return "closed";
  if (!offering.minMet && nowMs > offering.closeDate * 1000) return "limbo";
  return "live";
}

// Total units ever put up for sale, reconstructed per state — the contract
// never stores it. While Funding, escrow balance + sold is exact (refunds
// can't have run). After failure, refunds return buyers' units to escrow and
// sweeps drain it, so both are backed out: a refunded buyer's units are their
// Bought total, since refund() requires the full purchased balance. After
// close, the Closed event records the unsold remainder.
export function offeredUnitsTotal(
  offering: { state: number; unitsSold: number; remainingUnits: number },
  purchases: Array<Pick<Purchase, "buyer" | "units">>,
  lifecycle: LifecycleEvent[],
): number {
  if (offering.state === 2) {
    const closed = lifecycle.find((event) => event.type === "closed");
    return offering.unitsSold + (closed ? closed.unsoldUnits : 0);
  }
  if (offering.state === 1) {
    const refundedBuyers = new Set(
      lifecycle
        .filter((event) => event.type === "refund-paid")
        .map((event) => event.buyer.toLowerCase()),
    );
    const refundedUnits = purchases
      .filter((purchase) => refundedBuyers.has(purchase.buyer.toLowerCase()))
      .reduce((sum, purchase) => sum + purchase.units, 0);
    const sweptUnits = lifecycle
      .filter((event) => event.type === "swept")
      .reduce((sum, event) => sum + event.units, 0);
    return (
      offering.remainingUnits + offering.unitsSold - refundedUnits + sweptUnits
    );
  }
  return offering.unitsSold + offering.remainingUnits;
}

// Per-buyer refund outcome after failure, keyed by lowercase address. One
// RefundPaid is terminal (it zeroes the deposit); a skip stays retryable, so
// it never overrides a payment.
export type RefundStatus = "refunded" | "skipped" | "pending";

export function refundStatuses(
  purchases: Array<Pick<Purchase, "buyer">>,
  lifecycle: LifecycleEvent[],
): Map<string, RefundStatus> {
  const statuses = new Map<string, RefundStatus>();
  for (const purchase of purchases)
    statuses.set(purchase.buyer.toLowerCase(), "pending");
  for (const event of lifecycle) {
    if (event.type === "refund-paid")
      statuses.set(event.buyer.toLowerCase(), "refunded");
    else if (
      event.type === "refund-skipped" &&
      statuses.get(event.buyer.toLowerCase()) !== "refunded"
    )
      statuses.set(event.buyer.toLowerCase(), "skipped");
  }
  return statuses;
}
