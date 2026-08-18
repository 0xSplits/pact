import assert from "node:assert/strict";

import { test } from "vitest";

import { offeringStatus } from "#lib/chain/offering-status.ts";

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

test("active below minimum past close reports below minimum", () => {
  const status = offeringStatus(
    { state: 0, minMet: false, closeDate: past },
    now,
  );
  assert.equal(status.label, "Below minimum");
  assert.equal(status.tone, "failed");
});

test("active below minimum before close is open/funding", () => {
  const status = offeringStatus(
    { state: 0, minMet: false, closeDate: future },
    now,
  );
  assert.equal(status.label, "Open");
  assert.equal(status.tone, "funding");
});
