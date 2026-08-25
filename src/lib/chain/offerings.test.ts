import assert from "node:assert/strict";

import {
  encodeLog,
  fakeChainClient,
} from "@splits/pact-core/chain/fake-client.ts";
import { BOUGHT_EVENT as BOUGHT } from "@splits/pact-core/chain/reads.ts";
import type { OfferingRecord } from "@splits/pact-core/chain/reads.ts";
import {
  OFFERING_ABI,
  OFFERING_FACTORY_ABI,
} from "@splits/pact-core/generated/offering-contracts.ts";
import { getAddress } from "viem";
import type { Address, Hex } from "viem";
import { test } from "vitest";

import {
  cachedScan,
  findOffering,
  listBought,
  listLifecycle,
  listOfferings,
  listPurchases,
  seedOffering,
} from "#lib/chain/offerings.ts";

const addr = (byte: string) => getAddress("0x" + byte.repeat(20));
const FACTORY = addr("fa");
const OFFERING = addr("aa");
const BUYER = addr("dd");
const TX = ("0x" + "cc".repeat(32)) as Hex;

const fakeStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
};

const bought = (address: Address, logIndex = 0, blockNumber = 101) =>
  encodeLog(
    OFFERING_ABI,
    "Bought",
    {
      buyer: BUYER,
      allocationId: ("0x" + "11".repeat(32)) as Hex,
      units: 5n,
      cost: 123n,
      buyerName: "Ada",
    },
    { address, blockNumber, transactionHash: TX, logIndex },
  );

const created = (offering: Address, blockNumber = 5) =>
  encodeLog(
    OFFERING_FACTORY_ABI,
    "OfferingCreated",
    {
      issuer: BUYER,
      treasury: BUYER,
      offering,
      pactToken: addr("01"),
      projectName: "Acme",
      raiseMin: 5_000_000n,
      closeDate: 2_000_000_000n,
      priceStart: 40_000_000n,
      priceSlope: 100_000n,
      publicUnits: 50n,
    },
    { address: FACTORY, blockNumber, transactionHash: TX },
  );

const scanArgs = (
  overrides: Partial<Parameters<typeof cachedScan<any>>[0]>,
) => ({
  key: "test:scan",
  filter: { address: OFFERING, event: BOUGHT },
  fromBlock: 100,
  map: (log: any) => ({ id: Number(log.logIndex), transactionHash: TX }),
  dedupeKey: (item: any) => String(item.id),
  revive: (item: any) => item,
  storage: fakeStorage(),
  ...overrides,
});

test("cachedScan cold-scans from the deploy block to the tip", async () => {
  const client = fakeChainClient({
    logs: [bought(OFFERING, 1), bought(OFFERING, 2, 140)],
  });
  const storage = fakeStorage();
  const items = await cachedScan(
    scanArgs({ client, storage, latestBlock: 150 }),
  );
  assert.deepEqual(client.ranges, [[100, 150]]);
  assert.deepEqual(
    items.map((i: any) => i.id),
    [1, 2],
  );
  assert.equal(JSON.parse(storage.getItem("test:scan")!).lastScannedBlock, 150);
});

test("cachedScan resumes from the high-water mark and dedupes", async () => {
  const storage = fakeStorage();
  storage.setItem(
    "test:scan",
    JSON.stringify({
      lastScannedBlock: 199,
      items: [{ id: 1, transactionHash: TX }],
    }),
  );
  const client = fakeChainClient({
    logs: [bought(OFFERING, 1, 210), bought(OFFERING, 2, 210)],
  });
  const items = await cachedScan(
    scanArgs({ client, storage, latestBlock: 250 }),
  );
  assert.deepEqual(client.ranges, [[200, 250]]);
  assert.deepEqual(
    items.map((i: any) => i.id),
    [1, 2],
  );
  assert.equal(JSON.parse(storage.getItem("test:scan")!).lastScannedBlock, 250);
});

test("cachedScan does not touch the cache when already at the tip", async () => {
  const storage = fakeStorage();
  const cached = JSON.stringify({
    lastScannedBlock: 250,
    items: [{ id: 1, transactionHash: TX }],
  });
  storage.setItem("test:scan", cached);
  const client = fakeChainClient();
  await cachedScan(scanArgs({ client, storage, latestBlock: 250 }));
  assert.deepEqual(client.ranges, []);
  assert.equal(storage.getItem("test:scan"), cached);
});

for (const [name, corrupt] of [
  ["not json", "{not json"],
  ["non-integer mark", JSON.stringify({ lastScannedBlock: 199.5, items: [] })],
  ["items not an array", JSON.stringify({ lastScannedBlock: 199, items: {} })],
  [
    "item revive fails",
    JSON.stringify({ lastScannedBlock: 199, items: [{ bogus: 1 }] }),
  ],
] as const) {
  test(`cachedScan falls back to a full rescan on a corrupt cache (${name})`, async () => {
    const storage = fakeStorage();
    storage.setItem("test:scan", corrupt);
    const client = fakeChainClient({ logs: [bought(OFFERING, 1)] });
    const items = await cachedScan(
      scanArgs({
        client,
        storage,
        latestBlock: 150,
        revive: (item: any) => {
          if (typeof item.id !== "number") throw new Error("bogus");
          return item;
        },
      }),
    );
    assert.deepEqual(client.ranges, [[100, 150]], "full rescan, never a guess");
    assert.deepEqual(
      items.map((i: any) => i.id),
      [1],
    );
  });
}

test("a failing scan leaves the cache untouched, then resumes", async () => {
  const storage = fakeStorage();
  const before = JSON.stringify({
    lastScannedBlock: 199,
    items: [{ id: 1, transactionHash: TX }],
  });
  storage.setItem("test:scan", before);
  const failing = fakeChainClient({ maxRange: 0 });
  await assert.rejects(
    () => cachedScan(scanArgs({ client: failing, storage, latestBlock: 250 })),
    /max block range/,
  );
  assert.equal(storage.getItem("test:scan"), before);
  const client = fakeChainClient({ logs: [bought(OFFERING, 2, 210)] });
  const items = await cachedScan(
    scanArgs({ client, storage, latestBlock: 250 }),
  );
  assert.deepEqual(client.ranges, [[200, 250]]);
  assert.deepEqual(
    items.map((i: any) => i.id),
    [1, 2],
  );
});

test("listBought counts a log delivered twice only once and revives bigint cost", async () => {
  const log = bought(OFFERING);
  const storage = fakeStorage();
  const options = {
    offering: OFFERING,
    deployBlock: 100,
    storage,
    latestBlock: 150,
  };
  const purchases = await listBought({
    ...options,
    client: fakeChainClient({ logs: [log, log] }),
  });
  assert.equal(purchases.length, 1, "deduped by transactionHash:logIndex");
  assert.equal(purchases[0]?.cost, 123n);
  assert.equal(
    JSON.parse(storage.getItem("pact:bought:" + OFFERING.toLowerCase())!)
      .items[0].cost,
    "123",
    "decimal string in the cache",
  );
  const again = await listBought({ ...options, client: fakeChainClient() });
  assert.equal(again[0]?.cost, 123n, "revived on read");
});

test("listLifecycle round-trips bigint amounts through the cache", async () => {
  const at = (logIndex: number) => ({
    address: OFFERING,
    blockNumber: 102,
    transactionHash: TX,
    logIndex,
  });
  const storage = fakeStorage();
  const options = {
    offering: OFFERING,
    deployBlock: 100,
    storage,
    latestBlock: 150,
  };
  const events = await listLifecycle({
    ...options,
    client: fakeChainClient({
      logs: [
        encodeLog(OFFERING_ABI, "Failed", {}, at(0)),
        encodeLog(
          OFFERING_ABI,
          "RefundPaid",
          { buyer: BUYER, amount: 5_010_000n },
          at(1),
        ),
        encodeLog(
          OFFERING_ABI,
          "Closed",
          { treasury: BUYER, usdcAmount: 7n, unsoldUnits: 80n },
          at(2),
        ),
      ],
    }),
  });
  assert.deepEqual(
    events.map((e) => e.type),
    ["failed", "refund-paid", "closed"],
  );
  const again = await listLifecycle({ ...options, client: fakeChainClient() });
  assert.deepEqual(again, events);
  assert.equal(again[1]?.type === "refund-paid" && again[1].amount, 5_010_000n);
});

test("listPurchases drops foreign Bought logs and attaches the offering record", async () => {
  const foreign = addr("bb");
  const record = offeringRecord(OFFERING);
  const purchases = await listPurchases({
    wallet: BUYER,
    offerings: [record],
    deployBlock: 100,
    client: fakeChainClient({
      logs: [bought(OFFERING, 0), bought(foreign, 1)],
    }),
    storage: fakeStorage(),
    latestBlock: 150,
  });
  assert.equal(purchases.length, 1, "the known-offerings join drops foreigns");
  assert.equal(purchases[0]?.offering, OFFERING);
  assert.deepEqual(purchases[0]?.record, record);
});

test("seedOffering writes decimal strings and never rewinds the scan", () => {
  const storage = fakeStorage();
  const key = "pact:offerings:" + FACTORY.toLowerCase();
  storage.setItem(key, JSON.stringify({ lastScannedBlock: 555, items: [] }));
  seedOffering(offeringRecord(OFFERING), {
    factory: FACTORY,
    deployBlock: 100,
    storage,
  });
  const cached = JSON.parse(storage.getItem(key)!);
  assert.equal(cached.lastScannedBlock, 555);
  assert.equal(cached.items[0].priceStart, "40000000");
});

test("create-flow seed survives the next scan and dedupes against it", async () => {
  const storage = fakeStorage();
  const record = offeringRecord(OFFERING);
  seedOffering(record, { factory: FACTORY, deployBlock: 100, storage });

  const client = fakeChainClient({ logs: [created(OFFERING, 120)] });
  const offerings = await listOfferings({
    factory: FACTORY,
    deployBlock: 100,
    storage,
    client,
    latestBlock: 150,
  });
  assert.deepEqual(offerings, [record], "the scan's copy dedupes by address");
  assert.equal(
    client.ranges[0]?.[0],
    100,
    "seeding does not skip unscanned history",
  );

  seedOffering(record, { factory: FACTORY, deployBlock: 100, storage });
  assert.equal(
    JSON.parse(storage.getItem("pact:offerings:" + FACTORY.toLowerCase())!)
      .items.length,
    1,
    "seed is idempotent",
  );

  assert.deepEqual(findOffering(offerings, OFFERING.toLowerCase()), record);
  assert.equal(findOffering(offerings, addr("bb")), null);
});

const offeringRecord = (offering: Address): OfferingRecord => ({
  offering,
  pactToken: addr("01"),
  issuer: BUYER,
  treasury: BUYER,
  projectName: "Acme",
  raiseMin: 5_000_000n,
  closeDate: 2_000_000_000,
  priceStart: 40_000_000n,
  priceSlope: 100_000n,
  publicUnits: 50,
  blockNumber: 5,
  transactionHash: TX,
  logIndex: 0,
});
