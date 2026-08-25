import assert from "node:assert/strict";

import { test } from "vitest";

import {
  offeredUnitsTotal,
  offeringPhase,
  offeringStatus,
  refundStatuses,
} from "#core/chain/offering-status.ts";
import type { LifecycleEvent } from "#core/chain/reads.ts";

const now = 1_700_000_000_000;
const future = Math.floor(now / 1000) + 3600;
const past = Math.floor(now / 1000) - 3600;

test("failed state wins regardless of dates", () => {
  const status = offeringStatus(
    { state: 1, minMet: false, closeDate: future },
    now,
  );
  assert.equal(status.label, "Failed");
  assert.equal(status.tone, "failed");
});

test("closed state reports completed/secured", () => {
  const status = offeringStatus(
    { state: 2, minMet: true, closeDate: past },
    now,
  );
  assert.equal(status.label, "Completed");
  assert.equal(status.tone, "secured");
});

test("active with minimum met is open/secured even past close", () => {
  const status = offeringStatus(
    { state: 0, minMet: true, closeDate: past },
    now,
  );
  assert.equal(status.label, "Open");
  assert.equal(status.tone, "secured");
});

test("active below minimum past close reads as failed awaiting finalization", () => {
  const status = offeringStatus(
    { state: 0, minMet: false, closeDate: past },
    now,
  );
  assert.equal(status.label, "Failed");
  assert.equal(status.tone, "failed");
  assert.equal(status.note, "Awaiting finalization");
});

test("active below minimum before close is open/funding", () => {
  const status = offeringStatus(
    { state: 0, minMet: false, closeDate: future },
    now,
  );
  assert.equal(status.label, "Open");
  assert.equal(status.tone, "funding");
});

test("offeringPhase maps the four render modes", () => {
  assert.equal(
    offeringPhase({ state: 0, minMet: false, closeDate: future }, now),
    "live",
  );
  assert.equal(
    offeringPhase({ state: 0, minMet: true, closeDate: past }, now),
    "live",
    "min met past close keeps selling until the owner closes",
  );
  assert.equal(
    offeringPhase({ state: 0, minMet: false, closeDate: past }, now),
    "limbo",
  );
  assert.equal(
    offeringPhase({ state: 1, minMet: false, closeDate: future }, now),
    "failed",
  );
  assert.equal(
    offeringPhase({ state: 2, minMet: true, closeDate: past }, now),
    "closed",
  );
});

const addr = (byte: string) => ("0x" + byte.repeat(20)) as `0x${string}`;
const event = (
  fields: Partial<LifecycleEvent> & { type: LifecycleEvent["type"] },
  logIndex = 0,
): LifecycleEvent =>
  ({
    transactionHash: "0xabc",
    blockNumber: 1,
    logIndex,
    ...fields,
  }) as LifecycleEvent;

test("offeredUnitsTotal while funding is escrow plus sold", () => {
  assert.equal(
    offeredUnitsTotal({ state: 0, unitsSold: 21, remainingUnits: 179 }, [], []),
    200,
  );
});

test("offeredUnitsTotal after close comes from the Closed event", () => {
  assert.equal(
    offeredUnitsTotal(
      { state: 2, unitsSold: 120, remainingUnits: 0 },
      [],
      [event({ type: "closed", usdcAmount: 0n, unsoldUnits: 80 })],
    ),
    200,
  );
  assert.equal(
    offeredUnitsTotal({ state: 2, unitsSold: 120, remainingUnits: 0 }, [], []),
    120,
    "missing event degrades to sold units",
  );
});

test("offeredUnitsTotal after failure backs out refunds and sweeps", () => {
  // Offered 200, sold 21 (buyer A 5 + buyer B 16). A was refunded (their 5
  // units returned to escrow), then a sweep drained the 184 escrowed units.
  const purchases = [
    { buyer: addr("aa"), units: 5 },
    { buyer: addr("bb"), units: 16 },
  ];
  const lifecycle = [
    event({ type: "refund-paid", buyer: addr("aa"), amount: 5010000n }, 0),
    event({ type: "swept", units: 184 }, 1),
  ];
  assert.equal(
    offeredUnitsTotal(
      { state: 1, unitsSold: 21, remainingUnits: 0 },
      purchases,
      lifecycle,
    ),
    200,
  );
});

test("refundStatuses: paid is terminal, skips stay retryable", () => {
  const purchases = [
    { buyer: addr("aa") },
    { buyer: addr("bb") },
    { buyer: addr("cc") },
  ];
  const lifecycle = [
    event({ type: "refund-skipped", buyer: addr("aa") }, 0),
    event({ type: "refund-paid", buyer: addr("aa"), amount: 1n }, 1),
    event({ type: "refund-skipped", buyer: addr("bb") }, 2),
  ];
  const statuses = refundStatuses(purchases, lifecycle);
  assert.equal(statuses.get(addr("aa")), "refunded");
  assert.equal(statuses.get(addr("bb")), "skipped");
  assert.equal(statuses.get(addr("cc")), "pending");
});
