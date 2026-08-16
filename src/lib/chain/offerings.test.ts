import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkRanges,
  cachedScan,
  seedOffering,
  listOfferings,
  findOffering,
  SCAN_CHUNK_BLOCKS,
} from "./offerings.ts";

const fakeStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
};

// getLogs stub that records requested ranges and serves canned logs per range.
function fakeGetLogs(logsByFromBlock: Record<number, any[]> = {}) {
  const ranges: Array<[number, number]> = [];
  const fn = async ({
    fromBlock,
    toBlock,
  }: {
    fromBlock: number;
    toBlock: number;
  }) => {
    ranges.push([fromBlock, toBlock]);
    return logsByFromBlock[fromBlock] || [];
  };
  return Object.assign(fn, { ranges });
}

const scanArgs = (overrides: Record<string, unknown> = {}) => ({
  key: "test:scan",
  filter: { address: "0xabc", topics: ["0xdead"] },
  fromBlock: 100,
  map: (log: any) => log,
  dedupeKey: (item: any) => String(item.id),
  storage: fakeStorage(),
  ...overrides,
});

test("chunkRanges splits into 10k chunks with exact edges", () => {
  assert.deepEqual(chunkRanges(0, 25000), [
    [0, 9999],
    [10000, 19999],
    [20000, 25000],
  ]);
  assert.deepEqual(chunkRanges(5, 5), [[5, 5]]);
  assert.deepEqual(chunkRanges(10, 9), []);
  assert.equal(SCAN_CHUNK_BLOCKS, 10000);
  // A range ending exactly on a chunk boundary doesn't produce an empty chunk.
  assert.deepEqual(chunkRanges(0, 9999), [[0, 9999]]);
});

test("cachedScan cold-scans from the deploy block in chunks", async () => {
  const getLogs = fakeGetLogs({ 100: [{ id: 1 }], 20100: [{ id: 2 }] });
  const items = await cachedScan(scanArgs({ getLogs, latestBlock: 25099 }));
  assert.deepEqual(getLogs.ranges, [
    [100, 10099],
    [10100, 20099],
    [20100, 25099],
  ]);
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
});

test("cachedScan resumes from the high-water mark", async () => {
  const storage = fakeStorage();
  storage.setItem(
    "test:scan",
    JSON.stringify({ lastScannedBlock: 199, items: [{ id: 1 }] }),
  );
  const getLogs = fakeGetLogs({ 200: [{ id: 2 }] });
  const items = await cachedScan(
    scanArgs({ getLogs, storage, latestBlock: 250 }),
  );
  assert.deepEqual(getLogs.ranges, [[200, 250]]);
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
  assert.equal(JSON.parse(storage.getItem("test:scan")!).lastScannedBlock, 250);
});

test("cachedScan dedupes scan results against cached items", async () => {
  const storage = fakeStorage();
  storage.setItem(
    "test:scan",
    JSON.stringify({ lastScannedBlock: 199, items: [{ id: 1 }] }),
  );
  const getLogs = fakeGetLogs({ 200: [{ id: 1 }, { id: 2 }] });
  const items = await cachedScan(
    scanArgs({ getLogs, storage, latestBlock: 250 }),
  );
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
});

test("cachedScan falls back to a full rescan on a corrupt cache", async () => {
  const storage = fakeStorage();
  storage.setItem("test:scan", "{not json");
  const getLogs = fakeGetLogs({ 100: [{ id: 1 }] });
  const items = await cachedScan(
    scanArgs({ getLogs, storage, latestBlock: 150 }),
  );
  assert.deepEqual(getLogs.ranges, [[100, 150]]);
  assert.deepEqual(items, [{ id: 1 }]);
});

test("a chunk that throws leaves prior progress cached, then resumes", async () => {
  const storage = fakeStorage();
  let calls = 0;
  const getLogs = async ({ fromBlock }: { fromBlock: number }) => {
    calls++;
    if (calls === 2) throw new Error("rpc hiccup");
    return fromBlock === 100 ? [{ id: 1 }] : [{ id: 2 }];
  };
  await assert.rejects(
    () => cachedScan(scanArgs({ getLogs, storage, latestBlock: 25099 })),
    /rpc hiccup/,
  );
  const cache = JSON.parse(storage.getItem("test:scan")!);
  assert.equal(cache.lastScannedBlock, 10099, "first chunk committed");
  assert.deepEqual(cache.items, [{ id: 1 }]);

  // The retry resumes after the committed chunk instead of rescanning.
  const retryLogs = fakeGetLogs({ 20100: [{ id: 2 }] });
  const items = await cachedScan(
    scanArgs({ getLogs: retryLogs, storage, latestBlock: 25099 }),
  );
  assert.deepEqual(retryLogs.ranges, [
    [10100, 20099],
    [20100, 25099],
  ]);
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
});

test("cachedScan skips logs the map function rejects", async () => {
  const getLogs = fakeGetLogs({ 100: [{ id: 1, bad: true }, { id: 2 }] });
  const map = (log: any) => {
    if (log.bad) throw new Error("foreign log");
    return log;
  };
  const items = await cachedScan(scanArgs({ getLogs, map, latestBlock: 150 }));
  assert.deepEqual(items, [{ id: 2 }]);
});

test("create-flow seed survives the next scan and dedupes against it", async () => {
  const storage = fakeStorage();
  const factory = "0x" + "fa".repeat(20);
  const record = {
    offering: ("0x" + "aa".repeat(20)) as `0x${string}`,
    projectName: "Seeded",
    blockNumber: 123,
  };
  seedOffering(record, { factory, deployBlock: 100, storage });

  const getLogs = fakeGetLogs({}); // scan finds nothing new
  const offerings = await listOfferings({
    factory,
    deployBlock: 100,
    storage,
    getLogs,
    latestBlock: 150,
  });
  assert.deepEqual(offerings, [record]);
  assert.equal(
    getLogs.ranges[0]?.[0],
    100,
    "seeding does not skip unscanned history",
  );

  seedOffering(record, { factory, deployBlock: 100, storage });
  assert.equal(
    JSON.parse(storage.getItem("pact:offerings:" + factory)!).items.length,
    1,
    "seed is idempotent",
  );

  assert.deepEqual(
    findOffering(offerings, record.offering.toUpperCase().replace("0X", "0x")),
    record,
  );
  assert.equal(findOffering(offerings, "0x" + "bb".repeat(20)), null);
});
