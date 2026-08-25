import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  listAllocationLedger,
  markAllocationLedgerRowRevoked,
  saveAllocationLedgerRow,
} from "@splits/pact-core/chain/voucher.ts";
import type { AllocationLedgerRow } from "@splits/pact-core/chain/voucher.ts";
import { test } from "vitest";

import { fileLedgerStorage, mergeLedgerRows } from "#pact/ledger.ts";

const OFFERING = "0x00000000000000000000000000000000000000Aa";
const row = (
  id: string,
  extra: Partial<AllocationLedgerRow> = {},
): AllocationLedgerRow => ({
  allocationId: `0x${id.padStart(64, "0")}`,
  name: "n" + id,
  amountCapUsd: 10,
  link: "l",
  createdAt: Number(id),
  ...extra,
});

test("merge is a union by allocationId where revokedAt wins, order-independent", () => {
  const a = [row("1"), row("2", { revokedAt: 5 })];
  const b = [row("2"), row("3")];
  const ab = mergeLedgerRows(a, b);
  const ba = mergeLedgerRows(b, a);
  assert.deepEqual(ab, ba);
  assert.equal(ab.length, 3);
  assert.equal(
    ab.find((r) => r.allocationId === row("2").allocationId)?.revokedAt,
    5,
  );
  assert.deepEqual(mergeLedgerRows(ab, ab), ab);
});

test("file storage keeps one bare row array per chain and offering", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pact-ledger-"));
  const storage = fileLedgerStorage(dir, 8453);
  saveAllocationLedgerRow(OFFERING, row("1"), storage);
  saveAllocationLedgerRow(OFFERING, row("2"), storage);
  markAllocationLedgerRowRevoked(OFFERING, row("1").allocationId, 9, storage);
  const file = path.join(dir, "8453", OFFERING.toLowerCase() + ".json");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.length, 2);
  assert.equal(onDisk[0].revokedAt, 9);
  assert.equal(listAllocationLedger(OFFERING, storage).length, 2);
  saveAllocationLedgerRow(OFFERING, row("1"), storage);
  assert.equal(listAllocationLedger(OFFERING, storage)[0]?.revokedAt, 9);
  assert.equal(storage.getItem("unrelated"), null);
});
