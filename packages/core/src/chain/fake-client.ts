// The one test fake for ChainClient, shared by core, app, and CLI unit tests.
// Logs are raw (topics + data) so the same decoding path runs as in
// production; reads answer by function name.
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import type { Abi, AbiEvent, Address, Hex } from "viem";

import type { ChainClient } from "#core/chain/client.ts";

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  blockHash: Hex;
  transactionIndex: number;
  removed: boolean;
}

// An encoded event log as an RPC would return it.
export function encodeLog(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  at: {
    address: Address;
    blockNumber?: number;
    transactionHash?: Hex;
    logIndex?: number;
  },
): RawLog {
  const item = abi.find(
    (entry) => entry.type === "event" && entry.name === eventName,
  ) as AbiEvent | undefined;
  if (!item) throw new Error(`No event ${eventName}`);
  return {
    address: at.address,
    topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[],
    data: encodeAbiParameters(
      item.inputs.filter((input) => !input.indexed),
      item.inputs
        .filter((input) => !input.indexed)
        .map((input) => args[input.name!]),
    ),
    blockNumber: BigInt(at.blockNumber ?? 1),
    transactionHash: at.transactionHash ?? (("0x" + "11".repeat(32)) as Hex),
    logIndex: at.logIndex ?? 0,
    blockHash: ("0x" + "22".repeat(32)) as Hex,
    transactionIndex: 0,
    removed: false,
  };
}

export interface FakeChainClientOptions {
  logs?: RawLog[];
  // Return values by function name, or a function of the call's args; keyed
  // reads may also be scoped per contract with `reads[address][fn]`.
  reads?: Record<string, unknown>;
  latestBlock?: number;
  chainId?: number;
  // Below this block a whole-range getLogs throws (the public RPC's cap).
  maxRange?: number;
}

const matches = (log: RawLog, topics: (Hex | Hex[] | null)[]) =>
  topics.every((topic, i) =>
    topic == null
      ? true
      : Array.isArray(topic)
        ? topic.includes(log.topics[i]!)
        : log.topics[i] === topic,
  );

export function fakeChainClient({
  logs = [],
  reads = {},
  latestBlock = 100,
  chainId = 8453,
  maxRange,
}: FakeChainClientOptions = {}) {
  const ranges: Array<[number, number]> = [];
  const client = {
    ranges,
    getChainId: async () => chainId,
    getBlockNumber: async () => BigInt(latestBlock),
    getLogs: async (request: {
      address?: Address;
      event?: AbiEvent;
      events?: readonly AbiEvent[];
      args?: Record<string, unknown>;
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      const from = Number(request.fromBlock);
      const to = Number(request.toBlock);
      ranges.push([from, to]);
      if (maxRange != null && to - from + 1 > maxRange)
        throw new Error("query exceeds max block range");
      const events = request.event ? [request.event] : (request.events ?? []);
      const topics = events.map((event) =>
        encodeEventTopics({
          abi: [event],
          eventName: event.name,
          args: request.args,
        } as never),
      );
      return logs.filter((log) => {
        const inBlock =
          Number(log.blockNumber) >= from && Number(log.blockNumber) <= to;
        const byAddress =
          !request.address ||
          getAddress(log.address) === getAddress(request.address);
        return (
          inBlock &&
          byAddress &&
          topics.some((filter) => matches(log, filter as Hex[]))
        );
      });
    },
    readContract: async ({
      address,
      functionName,
      args,
    }: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
    }) => {
      const scoped = reads[getAddress(address)] as
        Record<string, unknown> | undefined;
      const value = scoped?.[functionName] ?? reads[functionName];
      if (value === undefined)
        throw new Error(`fake: no read for ${functionName} at ${address}`);
      return typeof value === "function" ? value(...(args ?? [])) : value;
    },
    call: async () => ({ data: "0x" as Hex }),
    waitForTransactionReceipt: async () => {
      throw new Error("fake: no receipts");
    },
    verifyTypedData: async () => true,
  };
  return client as unknown as ChainClient & { ranges: Array<[number, number]> };
}
