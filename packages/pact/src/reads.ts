// Every read the commands need, over the context's viem client. Reads are
// plain `readContract`/`getLogs`; the client batches same-tick reads through
// Multicall3 so `readOffering` costs one round trip.
import {
  OFFERING_ABI,
  OFFERING_FACTORY_ABI,
  PACT_TOKEN_ABI,
} from "splits-pact/generated/offering-contracts.ts";
import { TOTAL_LIQUID_SPLIT_UNITS } from "splits-pact/lib/chain/liquid-split.ts";
import { offeringPhase } from "splits-pact/lib/chain/offering-status.ts";
import { getAbiItem, getAddress, isAddressEqual, parseEventLogs } from "viem";
import type { Address, ContractFunctionName, Hex } from "viem";

import type { ChainClient, PactContext } from "#pact/context.ts";
import { usdc } from "#pact/format.ts";

export interface OfferingState {
  offering: Address;
  pactToken: Address;
  owner: Address;
  treasury: Address;
  factory: Address;
  state: number;
  phase: "live" | "limbo" | "failed" | "closed";
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
}

export async function readOffering(
  client: ChainClient,
  offeringAddress: Address,
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
  ] = (await Promise.all([
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
  ])) as [
    Address,
    Address,
    Address,
    Address,
    number,
    boolean,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
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
  return { ...result, phase: offeringPhase(result) };
}

// The JSON-safe shape `offering get` prints.
export function serializeOffering(state: OfferingState) {
  return {
    ...state,
    raiseMin: usdc(state.raiseMin),
    raised: usdc(state.raised),
    withdrawn: usdc(state.withdrawn),
    priceStart: usdc(state.priceStart),
    priceSlope: usdc(state.priceSlope),
    closeDateIso: new Date(state.closeDate * 1000).toISOString(),
    availablePublicUnits: Math.min(
      state.publicUnits - state.publicUnitsSold,
      state.remainingUnits,
    ),
    availablePrivateUnits: Math.max(
      state.remainingUnits - (state.publicUnits - state.publicUnitsSold),
      0,
    ),
  };
}

export async function quote(
  client: ChainClient,
  offering: Address,
  units: number,
): Promise<bigint> {
  return client.readContract({
    address: offering,
    abi: OFFERING_ABI,
    functionName: "quote",
    args: [BigInt(units)],
  });
}

const SCAN_CHUNK_BLOCKS = 10_000;

// One getLogs over the whole range, chunked only if the RPC refuses it.
async function scan(
  client: ChainClient,
  request: Omit<Parameters<ChainClient["getLogs"]>[0], "fromBlock" | "toBlock">,
  fromBlock: number,
) {
  const latest = Number(await client.getBlockNumber());
  if (fromBlock > latest) return [];
  const range = (from: number, to: number) =>
    client.getLogs({
      ...request,
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    } as Parameters<ChainClient["getLogs"]>[0]);
  try {
    return await range(fromBlock, latest);
  } catch {
    const logs = [];
    for (let from = fromBlock; from <= latest; from += SCAN_CHUNK_BLOCKS)
      logs.push(
        ...(await range(from, Math.min(from + SCAN_CHUNK_BLOCKS - 1, latest))),
      );
    return logs;
  }
}

export interface OfferingRecord {
  offering: Address;
  pactToken: Address;
  issuer: Address;
  treasury: Address;
  projectName: string;
  raiseMin: string;
  closeDate: number;
  priceStart: string;
  priceSlope: string;
  publicUnits: number;
  blockNumber: number;
  transactionHash: Hex;
}

export async function scanOfferings(
  ctx: Pick<PactContext, "client" | "factory" | "deployBlock">,
  offering?: Address,
): Promise<OfferingRecord[]> {
  const logs = await scan(
    ctx.client,
    {
      address: ctx.factory,
      event: getAbiItem({ abi: OFFERING_FACTORY_ABI, name: "OfferingCreated" }),
      ...(offering ? { args: { offering } } : {}),
    },
    ctx.deployBlock,
  );
  return parseEventLogs({
    abi: OFFERING_FACTORY_ABI,
    eventName: "OfferingCreated",
    logs,
  }).map((log) => ({
    offering: getAddress(log.args.offering),
    pactToken: getAddress(log.args.pactToken),
    issuer: getAddress(log.args.issuer),
    treasury: getAddress(log.args.treasury),
    projectName: log.args.projectName,
    raiseMin: usdc(log.args.raiseMin),
    closeDate: Number(log.args.closeDate),
    priceStart: usdc(log.args.priceStart),
    priceSlope: usdc(log.args.priceSlope),
    publicUnits: Number(log.args.publicUnits),
    blockNumber: Number(log.blockNumber),
    transactionHash: log.transactionHash,
  }));
}

// The injection boundary: an address is an offering only if the pinned
// factory emitted OfferingCreated for it. A contract merely answering
// `factory()` with the right address would otherwise collect a USDC approve.
export async function findFactoryChild(
  ctx: Pick<PactContext, "client" | "factory" | "deployBlock">,
  offering: Address,
): Promise<OfferingRecord | null> {
  const [record] = await scanOfferings(ctx, offering);
  return record && isAddressEqual(record.offering, offering) ? record : null;
}

export interface Purchase {
  buyer: Address;
  allocationId: Hex;
  units: number;
  cost: string;
  buyerName: string;
  transactionHash: Hex;
}

export async function scanPurchases(
  ctx: Pick<PactContext, "client">,
  offering: Address,
  fromBlock: number,
): Promise<Purchase[]> {
  const logs = await scan(
    ctx.client,
    {
      address: offering,
      event: getAbiItem({ abi: OFFERING_ABI, name: "Bought" }),
    },
    fromBlock,
  );
  return parseEventLogs({ abi: OFFERING_ABI, eventName: "Bought", logs }).map(
    (log) => ({
      buyer: getAddress(log.args.buyer),
      allocationId: log.args.allocationId,
      units: Number(log.args.units),
      cost: usdc(log.args.cost),
      buyerName: log.args.buyerName,
      transactionHash: log.transactionHash,
    }),
  );
}

export interface Holder {
  holder: Address;
  units: number;
  percent: number;
  role: "escrow" | "holder";
}

// Every address that ever received units, then live balances for each.
export async function capTable(
  ctx: Pick<PactContext, "client">,
  pactToken: Address,
  offering: Address,
  fromBlock: number,
): Promise<Holder[]> {
  const logs = await scan(
    ctx.client,
    {
      address: pactToken,
      events: [
        getAbiItem({ abi: PACT_TOKEN_ABI, name: "TransferSingle" }),
        getAbiItem({ abi: PACT_TOKEN_ABI, name: "TransferBatch" }),
      ],
    },
    fromBlock,
  );
  const seen = new Set<Address>();
  for (const log of parseEventLogs({ abi: PACT_TOKEN_ABI, logs })) {
    if (log.eventName !== "TransferSingle" && log.eventName !== "TransferBatch")
      continue;
    seen.add(getAddress(log.args.to));
  }
  const balances = await Promise.all(
    [...seen].map((holder) =>
      ctx.client.readContract({
        address: pactToken,
        abi: PACT_TOKEN_ABI,
        functionName: "balanceOf",
        args: [holder, 0n],
      }),
    ),
  );
  return [...seen]
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
