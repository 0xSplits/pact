// Chain-only listings: chunked event scans over public Base RPC with an
// incremental localStorage cache, replacing the server's PACT store. Cold scan
// on first visit per device, delta chunks after. Takes `getLogs` and `storage`
// as parameters so tests run against fakes and never hit real RPC.
import { getAbiItem, getAddress, zeroAddress } from "viem";
import type { Address } from "viem";

import {
  OFFERING_ABI,
  OFFERING_FACTORY_ABI,
  OFFERING_FACTORY_ADDRESS,
  OFFERING_FACTORY_DEPLOY_BLOCK,
  PACT_TOKEN_ABI,
} from "#generated/offering-contracts.ts";
import { globalOverride } from "#lib/chain/chain.ts";
import { costForUnits } from "#lib/chain/curve.ts";
import {
  getLatestBlockNumber,
  offeringRecordFromLog,
  offeringStateCurve,
  purchaseFromLog,
  readMany,
  getLogs as rpcGetLogs,
} from "#lib/chain/onchain.ts";
import type { OfferingRecord, Purchase } from "#lib/chain/onchain.ts";
import type { KVStorage } from "#lib/chain/voucher.ts";
import { isSameAddress } from "#lib/validate.ts";

// Public Base RPC caps eth_getLogs at 10k-block ranges.
export const SCAN_CHUNK_BLOCKS = 10000;

export function chunkRanges(
  fromBlock: number,
  toBlock: number,
  chunk: number = SCAN_CHUNK_BLOCKS,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    ranges.push([start, Math.min(start + chunk - 1, toBlock)]);
  }
  return ranges;
}

const memoryStorage = (): KVStorage => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
  };
};
const defaultStorage = (): KVStorage =>
  typeof localStorage !== "undefined" ? localStorage : memoryStorage();

function readCache<T>(
  storage: KVStorage,
  key: string,
): { lastScannedBlock: number; items: T[] } | null {
  try {
    const parsed = JSON.parse(storage.getItem(key) || "null");
    if (
      parsed &&
      Number.isInteger(parsed.lastScannedBlock) &&
      Array.isArray(parsed.items)
    )
      return parsed;
  } catch {}
  return null; // corrupt or missing cache falls back to a full rescan
}

// The scan is transport-agnostic: logs flow straight from getLogs into `map`,
// so their shape is the fake's business in tests and viem's in production.
export interface CachedScanOptions<T> {
  key: string;
  filter: Record<string, unknown>;
  fromBlock: number;
  map: (log: any) => T | null;
  dedupeKey: (item: T) => string;
  getLogs?:
    | ((
        args: Record<string, unknown> & { fromBlock: number; toBlock: number },
      ) => Promise<any[]>)
    | undefined;
  latestBlock?: number | undefined;
  storage?: KVStorage | undefined;
}

// Incremental log scan: resumes from the cache's high-water mark, decodes and
// merges new logs, and advances the cache after every chunk so a failing chunk
// never corrupts or rewinds what was already scanned.
export async function cachedScan<T>({
  key,
  filter,
  fromBlock,
  map,
  dedupeKey,
  getLogs = rpcGetLogs,
  latestBlock,
  storage = defaultStorage(),
}: CachedScanOptions<T>): Promise<T[]> {
  const cache = readCache<T>(storage, key);
  const items = cache ? cache.items : [];
  const seen = new Set(items.map(dedupeKey));
  const from = cache ? cache.lastScannedBlock + 1 : fromBlock;
  const to = latestBlock != null ? latestBlock : await getLatestBlockNumber();

  for (const [start, end] of chunkRanges(from, to)) {
    const logs = await getLogs({ ...filter, fromBlock: start, toBlock: end });
    for (const log of logs || []) {
      let item: T | null = null;
      try {
        item = map(log);
      } catch {} // foreign log matching the topic — not ours to decode
      if (!item || seen.has(dedupeKey(item))) continue;
      seen.add(dedupeKey(item));
      items.push(item);
    }
    storage.setItem(key, JSON.stringify({ lastScannedBlock: end, items }));
  }
  if (from > to && !cache)
    storage.setItem(key, JSON.stringify({ lastScannedBlock: to, items }));
  return items;
}

const offeringsKey = (factory: string) =>
  "pact:offerings:" + String(factory).toLowerCase();

const offeringCreatedEvent = getAbiItem({
  abi: OFFERING_FACTORY_ABI,
  name: "OfferingCreated",
});
const boughtEvent = getAbiItem({ abi: OFFERING_ABI, name: "Bought" });

// E2E/manual override hooks, same convention as PACT_RPC_URL (chain.ts) and
// the PACT_OFFERING_FACTORY_ADDRESS global createOffering honors: set on
// globalThis before modules load to scan a locally deployed factory.
const factoryDefault = (): Address =>
  (globalOverride("PACT_OFFERING_FACTORY_ADDRESS") as Address | undefined) ||
  OFFERING_FACTORY_ADDRESS;
const deployBlockDefault = (): number => {
  const override = globalOverride("PACT_FACTORY_DEPLOY_BLOCK");
  return Number.isInteger(override)
    ? (override as number)
    : OFFERING_FACTORY_DEPLOY_BLOCK;
};

// Options shared by the listing scans; tests inject fakes through these.
export interface ScanOptions {
  getLogs?: CachedScanOptions<unknown>["getLogs"];
  latestBlock?: number | undefined;
  storage?: KVStorage | undefined;
}

// Every offering ever created by the factory (the listing cache is global;
// filter by issuer/treasury for "my pacts").
export async function listOfferings({
  factory = factoryDefault(),
  deployBlock = deployBlockDefault(),
  ...options
}: ScanOptions & { factory?: Address; deployBlock?: number } = {}): Promise<
  OfferingRecord[]
> {
  return cachedScan<OfferingRecord>({
    key: offeringsKey(factory),
    filter: { address: getAddress(factory), event: offeringCreatedEvent },
    fromBlock: deployBlock,
    map: offeringRecordFromLog,
    dedupeKey: (record) => record.offering.toLowerCase(),
    ...options,
  });
}

// Create-flow cache seed: the creator sees their offering in listings
// instantly instead of waiting for the next scan, and the entry is never wrong
// because the scan would find it anyway (dedupe by address).
export function seedOffering(
  record: Pick<OfferingRecord, "offering"> & Partial<OfferingRecord>,
  {
    factory = factoryDefault(),
    deployBlock = deployBlockDefault(),
    storage = defaultStorage(),
  }: { factory?: Address; deployBlock?: number; storage?: KVStorage } = {},
): void {
  const key = offeringsKey(factory);
  const cache = readCache<
    Partial<OfferingRecord> & Pick<OfferingRecord, "offering">
  >(storage, key) || {
    lastScannedBlock: Math.max(0, deployBlock - 1),
    items: [],
  };
  if (
    !cache.items.some((item) => isSameAddress(item.offering, record.offering))
  ) {
    cache.items.push(record);
  }
  // Callers pass richer deployment objects (bigint curve params included);
  // JSON.stringify throws on bigint, so store them as decimal strings.
  storage.setItem(
    key,
    JSON.stringify(cache, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
}

// The lookup is deliberately loose: it matches case-insensitively, so any
// address-shaped string (route input, checksummed or not) is a valid key.
export function findOffering(
  offerings: OfferingRecord[] | null | undefined,
  offeringAddress: string | null | undefined,
): OfferingRecord | null {
  return (
    (offerings || []).find((record) =>
      isSameAddress(record.offering, offeringAddress),
    ) || null
  );
}

const boughtDedupeKey = (purchase: Purchase) =>
  purchase.txHash + ":" + purchase.logIndex;

// All purchases on one offering, public and private alike.
export async function listBought({
  offering,
  deployBlock = deployBlockDefault(),
  ...options
}: ScanOptions & {
  offering: Address;
  deployBlock?: number | undefined;
}): Promise<Purchase[]> {
  return cachedScan<Purchase>({
    key: "pact:bought:" + String(offering).toLowerCase(),
    filter: { address: getAddress(offering), event: boughtEvent },
    fromBlock: deployBlock,
    map: purchaseFromLog,
    dedupeKey: boughtDedupeKey,
    ...options,
  });
}

// A wallet's purchases across all offerings: one buyer-indexed scan with no
// address filter, joined against the known-offerings list to drop foreign
// events that happen to share the topic.
export async function listPurchases({
  wallet,
  offerings,
  deployBlock = deployBlockDefault(),
  ...options
}: ScanOptions & {
  wallet: Address;
  offerings?: OfferingRecord[];
  deployBlock?: number;
}): Promise<Array<Purchase & { record: OfferingRecord }>> {
  const known = new Map(
    (offerings || []).map((record) => [record.offering.toLowerCase(), record]),
  );
  const items = await cachedScan<Purchase>({
    key: "pact:purchases:" + String(wallet).toLowerCase(),
    filter: { event: boughtEvent, args: { buyer: getAddress(wallet) } },
    fromBlock: deployBlock,
    map: purchaseFromLog,
    dedupeKey: boughtDedupeKey,
    ...options,
  });
  return items
    .filter((purchase) => known.has(purchase.offering.toLowerCase()))
    .map((purchase) => ({
      ...purchase,
      record: known.get(purchase.offering.toLowerCase())!,
    }));
}

export interface OfferingLifecycle {
  state: number;
  minMet: boolean;
}

export interface WalletRecords {
  pacts: Array<
    OfferingRecord & {
      raised?: bigint;
      target?: bigint;
      lifecycle?: OfferingLifecycle | undefined;
    }
  >;
  purchases: Array<
    Purchase & {
      record: OfferingRecord;
      lifecycle?: OfferingLifecycle | undefined;
    }
  >;
}

// Everything the wallet menu and home dashboard show for a connected wallet:
// this wallet's issuances with live totals (target is what the curve yields
// if every remaining unit sells from the current position), its purchase
// receipts, and lifecycle state for every offering either group touches —
// one multicall over the deduped set. Scan failures degrade to empty groups
// and read failures to records without live fields, never a stuck loader.
export async function loadWalletRecords(
  wallet: Address,
): Promise<WalletRecords> {
  try {
    const offerings = await listOfferings();
    const mine = offerings.filter(
      (record) =>
        isSameAddress(record.issuer, wallet) ||
        isSameAddress(record.treasury, wallet),
    );
    const purchases: Array<Purchase & { record: OfferingRecord }> =
      await listPurchases({ wallet, offerings }).catch(() => []);

    const seen = new Set<string>();
    const lifecycleRecords = [
      ...mine,
      ...purchases.map((purchase) => purchase.record),
    ].filter((record) => {
      const key = record.offering.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const call = (record: OfferingRecord, functionName: string) => ({
      address: record.offering,
      abi: OFFERING_ABI,
      functionName,
    });
    const calls = [
      ...mine.flatMap((record) =>
        ["raised", "unitsSold", "remainingUnits"].map((fn) => call(record, fn)),
      ),
      ...lifecycleRecords.flatMap((record) =>
        ["state", "minMet"].map((fn) => call(record, fn)),
      ),
    ];
    const values = calls.length ? await readMany(calls).catch(() => null) : [];

    const lifecycleByOffering = new Map<string, OfferingLifecycle>();
    if (values) {
      const base = mine.length * 3;
      lifecycleRecords.forEach((record, i) => {
        lifecycleByOffering.set(record.offering.toLowerCase(), {
          state: Number(values[base + i * 2] ?? 0),
          minMet: Boolean(values[base + i * 2 + 1]),
        });
      });
    }
    const lifecycleOf = (record: OfferingRecord) =>
      lifecycleByOffering.get(record.offering.toLowerCase());

    const pacts = mine.map((record, i) => {
      if (!values) return record;
      const raised = BigInt((values[i * 3] as bigint) ?? 0n);
      const unitsSold = Number(values[i * 3 + 1] ?? 0);
      const remainingUnits = Number(values[i * 3 + 2] ?? 0);
      const curve = offeringStateCurve(record);
      return {
        ...record,
        raised,
        target: raised + costForUnits(curve, unitsSold, remainingUnits),
        lifecycle: lifecycleOf(record),
      };
    });
    return {
      pacts,
      purchases: purchases.map((purchase) => ({
        ...purchase,
        lifecycle: lifecycleOf(purchase.record),
      })),
    };
  } catch {
    return { pacts: [], purchases: [] };
  }
}

const transferEvents = [
  getAbiItem({ abi: PACT_TOKEN_ABI, name: "TransferSingle" }),
  getAbiItem({ abi: PACT_TOKEN_ABI, name: "TransferBatch" }),
];

// Every address currently holding PactToken units, discovered from transfer
// logs (bounded from the token's deploy block) and confirmed with batched
// balance reads.
export async function getPactTokenHolders({
  pactToken,
  deployBlock = deployBlockDefault(),
  tokenId = 0,
  getLogs = rpcGetLogs,
  latestBlock,
}: {
  pactToken: Address;
  deployBlock?: number | undefined;
  tokenId?: number | undefined;
  getLogs?: typeof rpcGetLogs | undefined;
  latestBlock?: number | undefined;
}): Promise<Array<{ address: Address; balance: number }>> {
  const address = getAddress(pactToken);
  const to = latestBlock != null ? latestBlock : await getLatestBlockNumber();

  const addresses = new Set<Address>();
  for (const [start, end] of chunkRanges(deployBlock, to)) {
    const logs = await getLogs({
      address,
      events: transferEvents,
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs || []) {
      for (const account of [log.args.from, log.args.to]) {
        if (account && account !== zeroAddress)
          addresses.add(getAddress(account));
      }
    }
  }

  const sorted = Array.from(addresses).sort((a, b) =>
    a.toLowerCase() > b.toLowerCase() ? 1 : -1,
  );
  if (!sorted.length) return [];
  const balances = await readMany(
    sorted.map((account) => ({
      address,
      abi: PACT_TOKEN_ABI,
      functionName: "balanceOf",
      args: [account, BigInt(tokenId)],
    })),
  );
  return sorted
    .map((account, index) => ({
      address: account,
      balance: Number(balances[index]),
    }))
    .filter((holder) => holder.balance > 0);
}
