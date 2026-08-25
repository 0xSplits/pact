// Every read the app and the CLI share, over a ChainClient: the offering
// snapshot, event decoders, and the log scans that stand in for a registry.
// Amounts stay bigint here; each adapter converts at its own edge (decimal
// strings in the app's JSON cache and the CLI's output).
import { getAbiItem, getAddress, isAddressEqual, parseEventLogs } from "viem";
import type { AbiEvent, Address, ContractFunctionName, Hex } from "viem";

import type { ChainClient } from "#core/chain/client.ts";
import type { CurveParams } from "#core/chain/curve.ts";
import { TOTAL_LIQUID_SPLIT_UNITS } from "#core/chain/liquid-split.ts";
import { offeringPhase } from "#core/chain/offering-status.ts";
import type { OfferingPhase } from "#core/chain/offering-status.ts";
import {
  OFFERING_ABI,
  OFFERING_FACTORY_ABI,
  PACT_TOKEN_ABI,
} from "#core/generated/offering-contracts.ts";

// Full offering snapshot from one batched read; the contract is always
// authoritative. `deposit` is present only when a buyer was passed.
export interface OfferingState {
  offering: Address;
  pactToken: Address;
  owner: Address;
  treasury: Address;
  factory: Address;
  state: number;
  phase: OfferingPhase;
  minMet: boolean;
  raiseMin: bigint;
  raised: bigint;
  withdrawn: bigint;
  closeDate: number;
  priceStart: bigint;
  priceSlope: bigint;
  unitsSold: number;
  remainingUnits: number;
  publicUnits: number;
  publicUnitsSold: number;
  deposit?: bigint;
}

// Individual typed reads so each field keeps its return type; batching is
// the client's job (see the app's `client` in onchain.ts).
export async function readOffering(
  client: ChainClient,
  offeringAddress: Address,
  buyer?: Address | null,
): Promise<OfferingState> {
  const offering = getAddress(offeringAddress);
  const read = <name extends ContractFunctionName<typeof OFFERING_ABI, "view">>(
    functionName: name,
  ) =>
    client.readContract({ address: offering, abi: OFFERING_ABI, functionName });
  const [
    pactToken,
    owner,
    treasury,
    factory,
    state,
    minMet,
    raiseMin,
    raised,
    withdrawn,
    closeDate,
    priceStart,
    priceSlope,
    unitsSold,
    remainingUnits,
    publicUnits,
    publicUnitsSold,
    deposit,
  ] = await Promise.all([
    read("pactToken"),
    read("owner"),
    read("treasury"),
    read("factory"),
    read("state"),
    read("minMet"),
    read("raiseMin"),
    read("raised"),
    read("withdrawn"),
    read("closeDate"),
    read("priceStart"),
    read("priceSlope"),
    read("unitsSold"),
    read("remainingUnits"),
    read("publicUnits"),
    read("publicUnitsSold"),
    buyer
      ? client.readContract({
          address: offering,
          abi: OFFERING_ABI,
          functionName: "deposits",
          args: [getAddress(buyer)],
        })
      : null,
  ]);
  const result = {
    offering,
    pactToken: getAddress(pactToken),
    owner: getAddress(owner),
    treasury: getAddress(treasury),
    factory: getAddress(factory),
    state: Number(state),
    minMet,
    raiseMin,
    raised,
    withdrawn,
    closeDate: Number(closeDate),
    priceStart,
    priceSlope,
    unitsSold: Number(unitsSold),
    remainingUnits: Number(remainingUnits),
    publicUnits: Number(publicUnits),
    publicUnitsSold: Number(publicUnitsSold),
  };
  return {
    ...result,
    phase: offeringPhase(result),
    ...(deposit != null ? { deposit } : {}),
  };
}

// The contract's own price for `units` from the current curve position.
export function quote(
  client: ChainClient,
  offering: Address,
  units: number,
): Promise<bigint> {
  return client.readContract({
    address: getAddress(offering),
    abi: OFFERING_ABI,
    functionName: "quote",
    args: [BigInt(units)],
  });
}

// Curve parameters straight off an offering-state read or a cached record
// (decimal strings; legacy caches may still hold integer numbers).
export const offeringStateCurve = (state: {
  priceStart: bigint | string | number;
  priceSlope: bigint | string | number;
}): CurveParams => ({
  priceStart: BigInt(state.priceStart),
  priceSlope: BigInt(state.priceSlope),
});

type Tranches = Pick<
  OfferingState,
  "remainingUnits" | "publicUnits" | "publicUnitsSold"
>;

// Public units still purchasable: capped by both remaining supply and the
// owner-set public tranche.
export const availablePublicUnits = (state: Tranches): number =>
  Math.min(
    state.remainingUnits,
    Math.max(0, state.publicUnits - state.publicUnitsSold),
  );

// Units a private claim can take: buyPrivate reserves the unsold public
// tranche, so the private ceiling is what remains after that headroom.
export const availablePrivateUnits = (state: Tranches): number =>
  Math.max(
    0,
    state.remainingUnits -
      Math.max(0, state.publicUnits - state.publicUnitsSold),
  );

// --- decoded logs ------------------------------------------------------------

// Where a log sits onchain; the `transactionHash:logIndex` pair is the
// identity every cache dedupes by.
export interface LogPosition {
  blockNumber: number;
  transactionHash: Hex;
  logIndex: number;
}

// The log shape `scan` yields: viem's decoded event with its position.
export interface DecodedLog {
  address: Address;
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint | number;
  transactionHash: Hex;
  logIndex: number;
}

const position = (log: DecodedLog): LogPosition => ({
  blockNumber: Number(log.blockNumber),
  transactionHash: log.transactionHash,
  logIndex: Number(log.logIndex),
});

// One OfferingCreated event: the factory's proof that `offering` is a PACT
// offering, plus the immutable terms the listing pages render.
export interface OfferingRecord extends LogPosition {
  offering: Address;
  pactToken: Address;
  issuer: Address;
  treasury: Address;
  projectName: string;
  raiseMin: bigint;
  closeDate: number;
  priceStart: bigint;
  priceSlope: bigint;
  publicUnits: number;
}

export interface Purchase extends LogPosition {
  offering: Address;
  buyer: Address;
  allocationId: Hex;
  units: number;
  cost: bigint;
  buyerName: string;
}

// The lifecycle events on one offering: how it ended, refund progress,
// escrow sweeps, proceeds withdrawals, and tranche/allocation changes.
export type LifecycleEvent = LogPosition &
  (
    | { type: "failed" }
    | { type: "closed"; usdcAmount: bigint; unsoldUnits: number }
    | { type: "refund-paid"; buyer: Address; amount: bigint }
    | { type: "refund-skipped"; buyer: Address }
    | { type: "swept"; units: number }
    | { type: "withdrawn"; amount: bigint }
    | { type: "allocation-cancelled"; allocationId: Hex }
    | { type: "public-units-updated"; publicUnits: number }
  );

export function offeringRecordFromLog(log: DecodedLog): OfferingRecord {
  const args = log.args as {
    issuer: Address;
    treasury: Address;
    offering: Address;
    pactToken: Address;
    projectName: string;
    raiseMin: bigint;
    closeDate: bigint;
    priceStart: bigint;
    priceSlope: bigint;
    publicUnits: bigint;
  };
  return {
    ...position(log),
    offering: getAddress(args.offering),
    pactToken: getAddress(args.pactToken),
    issuer: getAddress(args.issuer),
    treasury: getAddress(args.treasury),
    projectName: args.projectName,
    raiseMin: BigInt(args.raiseMin),
    closeDate: Number(args.closeDate),
    priceStart: BigInt(args.priceStart),
    priceSlope: BigInt(args.priceSlope),
    publicUnits: Number(args.publicUnits),
  };
}

export function purchaseFromLog(log: DecodedLog): Purchase {
  const args = log.args as {
    buyer: Address;
    allocationId: Hex;
    units: bigint;
    cost: bigint;
    buyerName: string;
  };
  return {
    ...position(log),
    offering: getAddress(log.address),
    buyer: getAddress(args.buyer),
    allocationId: args.allocationId,
    units: Number(args.units),
    cost: BigInt(args.cost),
    buyerName: args.buyerName || "",
  };
}

// Null for events outside the lifecycle set (Bought, Initialized, …).
export function lifecycleEventFromLog(log: DecodedLog): LifecycleEvent | null {
  const base = position(log);
  const { args } = log;
  switch (log.eventName) {
    case "Failed":
      return { ...base, type: "failed" };
    case "Closed":
      return {
        ...base,
        type: "closed",
        usdcAmount: BigInt(args.usdcAmount as bigint),
        unsoldUnits: Number(args.unsoldUnits),
      };
    case "RefundPaid":
      return {
        ...base,
        type: "refund-paid",
        buyer: getAddress(args.buyer as Address),
        amount: BigInt(args.amount as bigint),
      };
    case "RefundSkipped":
      return {
        ...base,
        type: "refund-skipped",
        buyer: getAddress(args.buyer as Address),
      };
    case "FailedUnitsSwept":
      return { ...base, type: "swept", units: Number(args.units) };
    case "Withdrawn":
      return {
        ...base,
        type: "withdrawn",
        amount: BigInt(args.amount as bigint),
      };
    case "AllocationCancelled":
      return {
        ...base,
        type: "allocation-cancelled",
        allocationId: args.allocationId as Hex,
      };
    case "PublicUnitsUpdated":
      return {
        ...base,
        type: "public-units-updated",
        publicUnits: Number(args.publicUnits),
      };
    default:
      return null;
  }
}

// --- scans -------------------------------------------------------------------

const event = <name extends string>(
  abi:
    typeof OFFERING_ABI | typeof OFFERING_FACTORY_ABI | typeof PACT_TOKEN_ABI,
  name: name,
) => getAbiItem({ abi, name } as never) as AbiEvent;

export const OFFERING_CREATED_EVENT = event(
  OFFERING_FACTORY_ABI,
  "OfferingCreated",
);
export const BOUGHT_EVENT = event(OFFERING_ABI, "Bought");
export const LIFECYCLE_EVENTS: AbiEvent[] = [
  "Failed",
  "Closed",
  "RefundPaid",
  "RefundSkipped",
  "FailedUnitsSwept",
  "Withdrawn",
  "AllocationCancelled",
  "PublicUnitsUpdated",
].map((name) => event(OFFERING_ABI, name));
export const TRANSFER_EVENTS: AbiEvent[] = [
  "TransferSingle",
  "TransferBatch",
].map((name) => event(PACT_TOKEN_ABI, name));

// A log request minus its block range: the emitter, the event(s) to match,
// and optional indexed-argument filters.
export interface ScanFilter {
  address?: Address;
  event?: AbiEvent;
  events?: readonly AbiEvent[];
  args?: Record<string, unknown>;
}

export interface ScanRange {
  fromBlock: number;
  toBlock?: number; // defaults to the latest block
}

// Public Base RPC caps eth_getLogs at 10k-block ranges.
export const SCAN_CHUNK_BLOCKS = 10_000;

// One getLogs over the whole range, 10k-block chunks only if the RPC refuses
// it. Logs come back decoded against the filter's events; foreign logs that
// merely share a topic are dropped.
export async function scan(
  client: ChainClient,
  filter: ScanFilter,
  { fromBlock, toBlock }: ScanRange,
): Promise<DecodedLog[]> {
  const latest =
    toBlock ?? Number(await client.getBlockNumber({ cacheTime: 0 }));
  if (fromBlock > latest) return [];
  const events = filter.event ? [filter.event] : (filter.events ?? []);
  const range = (from: number, to: number) =>
    client.getLogs({
      ...filter,
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    } as unknown as Parameters<ChainClient["getLogs"]>[0]);
  let logs;
  try {
    logs = await range(fromBlock, latest);
  } catch {
    logs = [];
    for (let from = fromBlock; from <= latest; from += SCAN_CHUNK_BLOCKS)
      logs.push(
        ...(await range(from, Math.min(from + SCAN_CHUNK_BLOCKS - 1, latest))),
      );
  }
  return parseEventLogs({ abi: events, logs }) as unknown as DecodedLog[];
}

export interface FactoryContext {
  client: ChainClient;
  factory: Address;
  deployBlock: number;
}

// Every offering the factory created, or just one when `offering` is given.
export async function scanOfferings(
  ctx: FactoryContext,
  offering?: Address,
): Promise<OfferingRecord[]> {
  const logs = await scan(
    ctx.client,
    {
      address: ctx.factory,
      event: OFFERING_CREATED_EVENT,
      ...(offering ? { args: { offering: getAddress(offering) } } : {}),
    },
    { fromBlock: ctx.deployBlock },
  );
  return logs.map(offeringRecordFromLog);
}

// The injection boundary: an address is an offering only if the pinned
// factory emitted OfferingCreated for it. A contract merely answering
// `factory()` with the right address would otherwise collect a USDC approve.
export async function findFactoryChild(
  ctx: FactoryContext,
  offering: Address,
): Promise<OfferingRecord | null> {
  const [record] = await scanOfferings(ctx, offering);
  return record && isAddressEqual(record.offering, offering) ? record : null;
}

export async function scanPurchases(
  client: ChainClient,
  offering: Address,
  range: ScanRange,
): Promise<Purchase[]> {
  const logs = await scan(
    client,
    { address: getAddress(offering), event: BOUGHT_EVENT },
    range,
  );
  return logs.map(purchaseFromLog);
}

export async function scanLifecycle(
  client: ChainClient,
  offering: Address,
  range: ScanRange,
): Promise<LifecycleEvent[]> {
  const logs = await scan(
    client,
    { address: getAddress(offering), events: LIFECYCLE_EVENTS },
    range,
  );
  return logs.map(lifecycleEventFromLog).filter((e) => e !== null);
}

export interface Holder {
  holder: Address;
  units: number;
  percent: number;
  role: "escrow" | "holder";
}

// Every address that ever sent or received units (minus the zero address),
// then live balances for each; zero balances drop out. Descending by units.
export async function capTable(
  client: ChainClient,
  pactToken: Address,
  offering: Address,
  range: ScanRange,
): Promise<Holder[]> {
  const token = getAddress(pactToken);
  const logs = await scan(
    client,
    { address: token, events: TRANSFER_EVENTS },
    range,
  );
  const seen = new Set<Address>();
  for (const log of logs)
    for (const account of [log.args.from, log.args.to] as Address[])
      if (account && BigInt(account) !== 0n) seen.add(getAddress(account));
  const holders = [...seen];
  const balances = await Promise.all(
    holders.map((holder) =>
      client.readContract({
        address: token,
        abi: PACT_TOKEN_ABI,
        functionName: "balanceOf",
        args: [holder, 0n],
      }),
    ),
  );
  return holders
    .map((holder, i) => ({
      holder,
      units: Number(balances[i]),
      percent: Number(balances[i]) / (TOTAL_LIQUID_SPLIT_UNITS / 100),
      role: (isAddressEqual(holder, offering)
        ? "escrow"
        : "holder") as Holder["role"],
    }))
    .filter((row) => row.units > 0)
    .sort((a, b) => b.units - a.units);
}
