import assert from "node:assert/strict";

import { getAddress } from "viem";
import type { Address, Hex } from "viem";
import { test } from "vitest";

import {
  availablePublicUnits,
  offeringRecordFromLog,
  offeringStateCurve,
  purchaseFromLog,
  QuoteChangedError,
} from "#lib/chain/onchain.ts";

const addr = (byte: string) => ("0x" + byte.repeat(20)) as Address;

const createdLog = () => ({
  args: {
    issuer: addr("ab"),
    treasury: addr("cd"),
    offering: addr("ef"),
    pactToken: addr("12"),
    projectName: "Proto",
    raiseMin: 5000000n,
    closeDate: 1700000000n,
    priceStart: 40000000n,
    priceSlope: 100000n,
    publicUnits: 200n,
  },
  blockNumber: 123n,
  transactionHash: ("0x" + "aa".repeat(32)) as Hex,
});

test("offeringRecordFromLog checksums addresses and stringifies bigint amounts", () => {
  const record = offeringRecordFromLog(createdLog());
  assert.equal(record.offering, getAddress(addr("ef")));
  assert.equal(record.pactToken, getAddress(addr("12")));
  assert.equal(record.issuer, getAddress(addr("ab")));
  assert.equal(record.treasury, getAddress(addr("cd")));
  assert.equal(record.projectName, "Proto");
  assert.equal(record.raiseMin, "5000000", "JSON-safe decimal string");
  assert.equal(record.priceStart, "40000000");
  assert.equal(record.priceSlope, "100000");
  assert.equal(record.closeDate, 1700000000);
  assert.equal(record.publicUnits, 200);
  assert.equal(record.blockNumber, 123);
  assert.equal(record.txHash, "0x" + "aa".repeat(32));
  // The whole record must survive the localStorage cache.
  assert.equal(typeof JSON.stringify(record), "string");
});

test("offeringRecordFromLog nulls a missing block number and tx hash", () => {
  const record = offeringRecordFromLog({
    ...createdLog(),
    blockNumber: null,
    transactionHash: null,
  });
  assert.equal(record.blockNumber, null);
  assert.equal(record.txHash, null);
});

const boughtLog = () => ({
  address: addr("ef") as string,
  args: {
    buyer: addr("ab"),
    allocationId: ("0x" + "11".repeat(32)) as Hex,
    units: 7n,
    cost: 123n,
    buyerName: "Ada",
  },
  blockNumber: 456n,
  transactionHash: ("0x" + "bb".repeat(32)) as Hex,
  logIndex: 9n,
});

test("purchaseFromLog decodes a Bought log into the JSON-safe shape", () => {
  const purchase = purchaseFromLog(boughtLog());
  assert.equal(purchase.offering, getAddress(addr("ef")));
  assert.equal(purchase.buyer, getAddress(addr("ab")));
  assert.equal(purchase.units, 7);
  assert.equal(purchase.cost, "123", "JSON-safe decimal string");
  assert.equal(purchase.buyerName, "Ada");
  assert.equal(purchase.blockNumber, 456);
  assert.equal(purchase.logIndex, 9);
});

test("purchaseFromLog defaults empty name, missing log index and receipt fields", () => {
  const base = boughtLog();
  const purchase = purchaseFromLog({
    ...base,
    args: { ...base.args, buyerName: "" },
    blockNumber: null,
    transactionHash: null,
    logIndex: null,
  });
  assert.equal(purchase.buyerName, "");
  assert.equal(purchase.blockNumber, null);
  assert.equal(purchase.txHash, null);
  assert.equal(purchase.logIndex, 0, "dedupe key stays well-formed");
});

test("offeringStateCurve accepts bigint, string, and number params", () => {
  assert.deepEqual(offeringStateCurve({ priceStart: 5n, priceSlope: 2n }), {
    priceStart: 5n,
    priceSlope: 2n,
  });
  // The path cached records take: decimal strings out of localStorage.
  assert.deepEqual(
    offeringStateCurve({ priceStart: "40000000", priceSlope: "100000" }),
    { priceStart: 40000000n, priceSlope: 100000n },
  );
  // Legacy caches stored integer numbers.
  assert.deepEqual(offeringStateCurve({ priceStart: 100, priceSlope: 0 }), {
    priceStart: 100n,
    priceSlope: 0n,
  });
});

test("availablePublicUnits caps by supply and public tranche headroom", () => {
  assert.equal(
    availablePublicUnits({
      remainingUnits: 100,
      publicUnits: 50,
      publicUnitsSold: 10,
    }),
    40,
  );
  // Owner lowered publicUnits below what already sold: clamps to 0, never negative.
  assert.equal(
    availablePublicUnits({
      remainingUnits: 100,
      publicUnits: 5,
      publicUnitsSold: 10,
    }),
    0,
  );
  assert.equal(
    availablePublicUnits({
      remainingUnits: 3,
      publicUnits: 50,
      publicUnitsSold: 10,
    }),
    3,
  );
});

test("QuoteChangedError carries the fresh quote", () => {
  const error = new QuoteChangedError(7, 123n);
  assert.ok(error instanceof Error);
  assert.equal(error.units, 7);
  assert.equal(error.cost, 123n);
  assert.match(error.message, /Prices moved/);
});
