// The browser's cache adapter over core's scans: an incremental localStorage
// cache per listing (cold scan on first visit per device, delta after), with
// bigint amounts stored as decimal strings. Takes `client` and `storage` as
// parameters so tests run against fakes and never hit real RPC.
import { globalOverride } from "@splits/pact-core/chain/chain.ts";
import type { ChainClient } from "@splits/pact-core/chain/client.ts";
import { costForUnits } from "@splits/pact-core/chain/curve.ts";
import {
  BOUGHT_EVENT,
  capTable,
  LIFECYCLE_EVENTS,
  lifecycleEventFromLog,
  OFFERING_CREATED_EVENT,
  offeringRecordFromLog,
  offeringStateCurve,
  purchaseFromLog,
  scan,
} from "@splits/pact-core/chain/reads.ts";
import type {
  DecodedLog,
  Holder,
  LifecycleEvent,
  OfferingRecord,
  Purchase,
  ScanFilter,
} from "@splits/pact-core/chain/reads.ts";
import type { KVStorage } from "@splits/pact-core/chain/voucher.ts";
import {
  OFFERING_ABI,
  OFFERING_FACTORY_ADDRESS,
  OFFERING_FACTORY_DEPLOY_BLOCK,
} from "@splits/pact-core/generated/offering-contracts.ts";
import { isSameAddress } from "@splits/pact-core/validate.ts";
import { getAddress } from "viem";
import type { Address } from "viem";

import {
  getLatestBlockNumber,
  client as rpcClient,
} from "#lib/chain/onchain.ts";

// JSON.stringify throws on bigint, so cached items carry decimal strings;
// `revive` turns them back into the core shape on read.
const toJson = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

// Restores the bigint fields of a cached item. Throws on anything that is
// not a decimal string, which readCache turns into a full rescan; older
// caches (pre-core shapes) fall out that way too.
function reviveBigints<T extends object>(item: T, keys: (keyof T)[]): T {
  const out = { ...item };
  for (const key of keys) {
    const value = out[key] as unknown;
    if (typeof value === "bigint") continue;
    if (typeof value !== "string" || !/^\d+$/.test(value))
      throw new Error(`cached ${String(key)} is not a decimal string`);
    out[key] = BigInt(value) as T[typeof key];
  }
  if (
    typeof (out as { transactionHash?: unknown }).transactionHash !== "string"
  )
    throw new Error("cached item has no transactionHash");
  return out;
}

function readCache<T>(
  storage: KVStorage,
  key: string,
  revive: (item: T) => T,
): { lastScannedBlock: number; items: T[] } | null {
  try {
    const parsed = JSON.parse(storage.getItem(key) || "null");
    if (
      parsed &&
      Number.isInteger(parsed.lastScannedBlock) &&
      Array.isArray(parsed.items)
    )
      return { ...parsed, items: parsed.items.map(revive) };
  } catch {}
  return null; // corrupt or missing cache falls back to a full rescan
}

export interface CachedScanOptions<T> {
  key: string;
  filter: ScanFilter;
  fromBlock: number;
  map: (log: DecodedLog) => T | null;
  dedupeKey: (item: T) => string;
  revive: (item: T) => T;
  client?: ChainClient | undefined;
  latestBlock?: number | undefined;
  storage?: KVStorage | undefined;
}

// Incremental scan: resumes from the cache's high-water mark, merges new logs
// (deduped by identity), and advances the mark only after the scan succeeds,
// so a failing scan never corrupts or rewinds what was already cached.
export async function cachedScan<T>({
  key,
  filter,
  fromBlock,
  map,
  dedupeKey,
  revive,
  client = rpcClient(),
  latestBlock,
  storage = localStorage,
}: CachedScanOptions<T>): Promise<T[]> {
  const cache = readCache<T>(storage, key, revive);
  const items = cache ? cache.items : [];
  const seen = new Set(items.map(dedupeKey));
  const from = cache ? cache.lastScannedBlock + 1 : fromBlock;
  const to = latestBlock ?? (await getLatestBlockNumber());
  if (from <= to) {
    for (const log of await scan(client, filter, {
      fromBlock: from,
      toBlock: to,
    })) {
      const item = map(log);
      if (!item || seen.has(dedupeKey(item))) continue;
      seen.add(dedupeKey(item));
      items.push(item);
    }
  }
  if (from <= to || !cache)
    storage.setItem(key, toJson({ lastScannedBlock: to, items }));
  return items;
}

const offeringsKey = (factory: string) =>
  "pact:offerings:" + String(factory).toLowerCase();

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
  client?: ChainClient | undefined;
  latestBlock?: number | undefined;
  storage?: KVStorage | undefined;
}

const reviveRecord = (record: OfferingRecord) =>
  reviveBigints(record, ["raiseMin", "priceStart", "priceSlope"]);
const revivePurchase = (purchase: Purchase) =>
  reviveBigints(purchase, ["cost"]);
const reviveLifecycle = (event: LifecycleEvent): LifecycleEvent =>
  event.type === "closed"
    ? reviveBigints(event, ["usdcAmount"])
    : event.type === "refund-paid" || event.type === "withdrawn"
      ? reviveBigints(event, ["amount"])
      : reviveBigints(event, []);

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
    filter: { address: getAddress(factory), event: OFFERING_CREATED_EVENT },
    fromBlock: deployBlock,
    map: offeringRecordFromLog,
    dedupeKey: (record) => record.offering.toLowerCase(),
    revive: reviveRecord,
    ...options,
  });
}

// Create-flow cache seed: the creator sees their offering in listings
// instantly instead of waiting for the next scan, and the entry is never wrong
// because the scan would find it anyway (dedupe by address).
export function seedOffering(
  record: OfferingRecord,
  {
    factory = factoryDefault(),
    deployBlock = deployBlockDefault(),
    storage = localStorage,
  }: { factory?: Address; deployBlock?: number; storage?: KVStorage } = {},
): void {
  const key = offeringsKey(factory);
  const cache = readCache<OfferingRecord>(storage, key, reviveRecord) || {
    lastScannedBlock: Math.max(0, deployBlock - 1),
    items: [],
  };
  if (
    !cache.items.some((item) => isSameAddress(item.offering, record.offering))
  )
    cache.items.push(record);
  storage.setItem(key, toJson(cache));
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

const logKey = (item: { transactionHash: string; logIndex: number }) =>
  item.transactionHash + ":" + item.logIndex;

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
    filter: { address: getAddress(offering), event: BOUGHT_EVENT },
    fromBlock: deployBlock,
    map: purchaseFromLog,
    dedupeKey: logKey,
    revive: revivePurchase,
    ...options,
  });
}

// The lifecycle events on one offering: how it ended, refund progress, and
// escrow sweeps. Scanned only once an offering leaves the live phase.
export async function listLifecycle({
  offering,
  deployBlock = deployBlockDefault(),
  ...options
}: ScanOptions & {
  offering: Address;
  deployBlock?: number | undefined;
}): Promise<LifecycleEvent[]> {
  return cachedScan<LifecycleEvent>({
    key: "pact:lifecycle:" + String(offering).toLowerCase(),
    filter: { address: getAddress(offering), events: LIFECYCLE_EVENTS },
    fromBlock: deployBlock,
    map: lifecycleEventFromLog,
    dedupeKey: logKey,
    revive: reviveLifecycle,
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
    filter: { event: BOUGHT_EVENT, args: { buyer: getAddress(wallet) } },
    fromBlock: deployBlock,
    map: purchaseFromLog,
    dedupeKey: logKey,
    revive: revivePurchase,
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
// receipts, and lifecycle state for every offering either group touches.
// Scan failures degrade to empty groups and a failing read to that record's
// live fields only, never a stuck loader.
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

    const read = <
      name extends
        "state" | "minMet" | "raised" | "unitsSold" | "remainingUnits",
    >(
      record: OfferingRecord,
      functionName: name,
    ) =>
      rpcClient().readContract({
        address: record.offering,
        abi: OFFERING_ABI,
        functionName,
      });
    const lifecycleByOffering = new Map<string, OfferingLifecycle>();
    const totalsByOffering = new Map<
      string,
      { raised: bigint; target: bigint }
    >();
    await Promise.all([
      ...lifecycleRecords.map(async (record) => {
        try {
          const [state, minMet] = await Promise.all([
            read(record, "state"),
            read(record, "minMet"),
          ]);
          lifecycleByOffering.set(record.offering.toLowerCase(), {
            state: Number(state),
            minMet,
          });
        } catch {} // row renders without live fields
      }),
      ...mine.map(async (record) => {
        try {
          const [raised, unitsSold, remainingUnits] = await Promise.all([
            read(record, "raised"),
            read(record, "unitsSold"),
            read(record, "remainingUnits"),
          ]);
          const curve = offeringStateCurve(record);
          totalsByOffering.set(record.offering.toLowerCase(), {
            raised,
            target:
              raised +
              costForUnits(curve, Number(unitsSold), Number(remainingUnits)),
          });
        } catch {} // row renders without live totals
      }),
    ]);
    const lifecycleOf = (record: OfferingRecord) =>
      lifecycleByOffering.get(record.offering.toLowerCase());

    const pacts = mine.map((record) => ({
      ...record,
      ...(totalsByOffering.get(record.offering.toLowerCase()) ?? {}),
      lifecycle: lifecycleOf(record),
    }));
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

// Every address currently holding PactToken units, from the token's deploy
// block to the latest.
export function getPactTokenHolders({
  record,
  client = rpcClient(),
  latestBlock,
}: ScanOptions & { record: OfferingRecord }): Promise<Holder[]> {
  return capTable(client, record.pactToken, record.offering, {
    fromBlock: record.blockNumber,
    ...(latestBlock != null ? { toBlock: latestBlock } : {}),
  });
}
