import assert from "node:assert/strict";

import { getAddress, parseEventLogs } from "viem";
import type { Address, Hex, Log } from "viem";
import { test } from "vitest";

import { encodeLog, fakeChainClient } from "#core/chain/fake-client.ts";
import type { RawLog } from "#core/chain/fake-client.ts";
import {
  availablePrivateUnits,
  availablePublicUnits,
  capTable,
  findFactoryChild,
  lifecycleEventFromLog,
  OFFERING_CREATED_EVENT as OFFERING_CREATED,
  offeringRecordFromLog,
  offeringStateCurve,
  purchaseFromLog,
  readOffering,
  scan,
  SCAN_CHUNK_BLOCKS,
  scanLifecycle,
  scanOfferings,
  scanPurchases,
  TRANSFER_EVENTS,
} from "#core/chain/reads.ts";
import type { DecodedLog } from "#core/chain/reads.ts";
import {
  OFFERING_ABI,
  OFFERING_FACTORY_ABI,
  PACT_TOKEN_ABI,
} from "#core/generated/offering-contracts.ts";

const addr = (byte: string) => getAddress("0x" + byte.repeat(20));
const FACTORY = addr("fa");
const OFFERING = addr("aa");
const PACT_TOKEN = addr("bb");
const OWNER = addr("cc");
const BUYER = addr("dd");
const TX = ("0x" + "11".repeat(32)) as Hex;

const created = (offering: Address, blockNumber = 5) =>
  encodeLog(
    OFFERING_FACTORY_ABI,
    "OfferingCreated",
    {
      issuer: OWNER,
      treasury: OWNER,
      offering,
      pactToken: PACT_TOKEN,
      projectName: "Acme",
      raiseMin: 5_000_000_000n,
      closeDate: 2_000_000_000n,
      priceStart: 10_000_000n,
      priceSlope: 1_000_000n,
      publicUnits: 50n,
    },
    { address: FACTORY, blockNumber, transactionHash: TX },
  );

const bought = (address: Address, logIndex = 0) =>
  encodeLog(
    OFFERING_ABI,
    "Bought",
    {
      buyer: BUYER,
      allocationId: ("0x" + "22".repeat(32)) as Hex,
      units: 7n,
      cost: 123n,
      buyerName: "Ada",
    },
    { address, blockNumber: 9, transactionHash: TX, logIndex },
  );

const OFFERING_VIEWS = {
  pactToken: PACT_TOKEN,
  owner: OWNER,
  treasury: OWNER,
  factory: FACTORY,
  state: 0,
  minMet: false,
  raiseMin: 5_000_000_000n,
  raised: 0n,
  withdrawn: 0n,
  closeDate: 2_000_000_000n,
  priceStart: 10_000_000n,
  priceSlope: 1_000_000n,
  unitsSold: 3n,
  remainingUnits: 100n,
  publicUnits: 50n,
  publicUnitsSold: 1n,
  deposits: (buyer: Address) => (buyer === BUYER ? 42n : 0n),
};

test("readOffering maps every field, derives the phase, and adds deposit for a buyer", async () => {
  const client = fakeChainClient({ reads: OFFERING_VIEWS });
  const state = await readOffering(client, OFFERING.toLowerCase() as Address);
  assert.equal(state.offering, OFFERING, "checksummed");
  assert.equal(state.factory, FACTORY);
  assert.equal(state.phase, "live");
  assert.equal(state.unitsSold, 3);
  assert.equal(state.raiseMin, 5_000_000_000n);
  assert.equal("deposit" in state, false);
  const withBuyer = await readOffering(client, OFFERING, BUYER);
  assert.equal(withBuyer.deposit, 42n);
});

test("offeringRecordFromLog checksums addresses and keeps bigint amounts", () => {
  const [log] = parse(created(OFFERING.toLowerCase() as Address));
  const record = offeringRecordFromLog(log!);
  assert.equal(record.offering, OFFERING);
  assert.equal(record.projectName, "Acme");
  assert.equal(record.raiseMin, 5_000_000_000n);
  assert.equal(record.closeDate, 2_000_000_000);
  assert.equal(record.publicUnits, 50);
  assert.deepEqual(
    [record.blockNumber, record.transactionHash, record.logIndex],
    [5, TX, 0],
  );
});

test("purchaseFromLog decodes a Bought log", () => {
  const [log] = parse(bought(OFFERING, 3));
  const purchase = purchaseFromLog(log!);
  assert.equal(purchase.offering, OFFERING);
  assert.equal(purchase.buyer, BUYER);
  assert.equal(purchase.units, 7);
  assert.equal(purchase.cost, 123n);
  assert.equal(purchase.buyerName, "Ada");
  assert.equal(purchase.logIndex, 3);
});

test("lifecycleEventFromLog covers the lifecycle set and rejects the rest", () => {
  const at = (logIndex: number) => ({
    address: OFFERING,
    blockNumber: 9,
    transactionHash: TX,
    logIndex,
  });
  const logs = parse(
    encodeLog(OFFERING_ABI, "Failed", {}, at(0)),
    encodeLog(OFFERING_ABI, "RefundPaid", { buyer: BUYER, amount: 5n }, at(1)),
    encodeLog(OFFERING_ABI, "RefundSkipped", { buyer: BUYER }, at(2)),
    encodeLog(
      OFFERING_ABI,
      "FailedUnitsSwept",
      { treasury: OWNER, units: 184n },
      at(3),
    ),
    encodeLog(
      OFFERING_ABI,
      "Closed",
      { treasury: OWNER, usdcAmount: 7n, unsoldUnits: 80n },
      at(4),
    ),
    encodeLog(
      OFFERING_ABI,
      "Withdrawn",
      { treasury: OWNER, amount: 9n },
      at(5),
    ),
    encodeLog(
      OFFERING_ABI,
      "AllocationCancelled",
      { allocationId: "0x" + "22".repeat(32) },
      at(6),
    ),
    encodeLog(OFFERING_ABI, "PublicUnitsUpdated", { publicUnits: 12n }, at(7)),
    bought(OFFERING, 8),
  );
  const events = logs.map(lifecycleEventFromLog);
  assert.deepEqual(
    events.map((e) => e?.type ?? null),
    [
      "failed",
      "refund-paid",
      "refund-skipped",
      "swept",
      "closed",
      "withdrawn",
      "allocation-cancelled",
      "public-units-updated",
      null,
    ],
  );
  assert.deepEqual(events[1], {
    type: "refund-paid",
    buyer: BUYER,
    amount: 5n,
    blockNumber: 9,
    transactionHash: TX,
    logIndex: 1,
  });
  assert.deepEqual(events[4], {
    type: "closed",
    usdcAmount: 7n,
    unsoldUnits: 80,
    blockNumber: 9,
    transactionHash: TX,
    logIndex: 4,
  });
});

test("scan asks for the whole range first and chunks only when refused", async () => {
  const logs = [created(OFFERING, 5), created(addr("ab"), 25_000)];
  const whole = fakeChainClient({ logs, latestBlock: 30_000 });
  const filter = { address: FACTORY, event: OFFERING_CREATED };
  assert.equal((await scan(whole, filter, { fromBlock: 0 })).length, 2);
  assert.deepEqual(whole.ranges, [[0, 30_000]]);

  const capped = fakeChainClient({
    logs,
    latestBlock: 30_000,
    maxRange: SCAN_CHUNK_BLOCKS,
  });
  const found = await scan(capped, filter, { fromBlock: 0 });
  assert.equal(found.length, 2);
  assert.deepEqual(capped.ranges, [
    [0, 30_000],
    [0, 9_999],
    [10_000, 19_999],
    [20_000, 29_999],
    [30_000, 30_000],
  ]);
  assert.deepEqual(
    await scan(capped, filter, { fromBlock: 40_000 }),
    [],
    "a range past the tip is empty without a request",
  );
});

test("scan honours an explicit toBlock", async () => {
  const client = fakeChainClient({
    logs: [created(OFFERING, 5)],
    latestBlock: 100,
  });
  const filter = { address: FACTORY, event: OFFERING_CREATED };
  assert.equal(
    (await scan(client, filter, { fromBlock: 0, toBlock: 4 })).length,
    0,
  );
  assert.deepEqual(client.ranges, [[0, 4]]);
});

test("findFactoryChild accepts only the pinned factory's OfferingCreated", async () => {
  const stranger = addr("ee");
  const client = fakeChainClient({
    logs: [
      created(OFFERING),
      // A different factory claiming the stranger.
      { ...created(stranger), address: addr("fb") },
    ],
  });
  const ctx = { client, factory: FACTORY, deployBlock: 0 };
  const record = await findFactoryChild(ctx, OFFERING);
  assert.equal(record?.offering, OFFERING);
  assert.equal(await findFactoryChild(ctx, stranger), null);
  assert.equal((await scanOfferings(ctx)).length, 1);
});

test("scanPurchases and scanLifecycle scope to the offering", async () => {
  const client = fakeChainClient({
    logs: [
      bought(OFFERING, 0),
      bought(addr("ab"), 1),
      encodeLog(
        OFFERING_ABI,
        "Failed",
        {},
        { address: OFFERING, blockNumber: 10 },
      ),
    ],
  });
  const range = { fromBlock: 0 };
  const purchases = await scanPurchases(client, OFFERING, range);
  assert.deepEqual(
    purchases.map((p) => p.offering),
    [OFFERING],
  );
  const lifecycle = await scanLifecycle(client, OFFERING, range);
  assert.deepEqual(
    lifecycle.map((e) => e.type),
    ["failed"],
  );
});

test("capTable collects senders and recipients, reads balances, drops zeros", async () => {
  const zero = "0x0000000000000000000000000000000000000000";
  const transfer = (from: string, to: string, logIndex: number) =>
    encodeLog(
      PACT_TOKEN_ABI,
      "TransferSingle",
      { operator: OWNER, from, to, id: 0n, amount: 1n },
      { address: PACT_TOKEN, blockNumber: 3, logIndex },
    );
  const balances: Record<string, bigint> = {
    [OWNER]: 800n,
    [OFFERING]: 150n,
    [BUYER]: 50n,
    [addr("ee")]: 0n,
  };
  const client = fakeChainClient({
    logs: [
      transfer(zero, OWNER, 0),
      transfer(zero, OFFERING, 1),
      transfer(OFFERING, BUYER, 2),
      // Bought and fully refunded: only ever appears as a `from`.
      transfer(addr("ee"), OFFERING, 3),
    ],
    reads: { balanceOf: (holder: Address) => balances[holder] },
  });
  const holders = await capTable(client, PACT_TOKEN, OFFERING, {
    fromBlock: 0,
  });
  assert.deepEqual(holders, [
    { holder: OWNER, units: 800, percent: 80, role: "holder" },
    { holder: OFFERING, units: 150, percent: 15, role: "escrow" },
    { holder: BUYER, units: 50, percent: 5, role: "holder" },
  ]);
  assert.equal(TRANSFER_EVENTS.length, 2);
});

test("offeringStateCurve accepts bigint, string, and number params", () => {
  assert.deepEqual(offeringStateCurve({ priceStart: 5n, priceSlope: 2n }), {
    priceStart: 5n,
    priceSlope: 2n,
  });
  assert.deepEqual(
    offeringStateCurve({ priceStart: "40000000", priceSlope: "100000" }),
    { priceStart: 40000000n, priceSlope: 100000n },
  );
  assert.deepEqual(offeringStateCurve({ priceStart: 100, priceSlope: 0 }), {
    priceStart: 100n,
    priceSlope: 0n,
  });
});

test("availablePublicUnits caps by supply and public tranche headroom", () => {
  const at = (
    remainingUnits: number,
    publicUnits: number,
    publicUnitsSold: number,
  ) => availablePublicUnits({ remainingUnits, publicUnits, publicUnitsSold });
  assert.equal(at(100, 50, 10), 40);
  assert.equal(at(100, 5, 10), 0, "owner lowered publicUnits below sold");
  assert.equal(at(3, 50, 10), 3);
});

test("availablePrivateUnits reserves the unsold public tranche", () => {
  const at = (
    remainingUnits: number,
    publicUnits: number,
    publicUnitsSold: number,
  ) => availablePrivateUnits({ remainingUnits, publicUnits, publicUnitsSold });
  assert.equal(at(100, 50, 10), 60);
  assert.equal(at(30, 50, 10), 0, "public headroom exceeds supply");
  assert.equal(at(100, 5, 10), 100, "no negative headroom");
});

// Decoded logs the way `scan` hands them out.
function parse(...logs: RawLog[]) {
  return parseEventLogs({
    abi: [...OFFERING_ABI, ...OFFERING_FACTORY_ABI, ...PACT_TOKEN_ABI],
    logs: logs as unknown as Log[],
  }) as unknown as DecodedLog[];
}
