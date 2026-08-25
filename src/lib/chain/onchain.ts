// The browser's send adapter. Reads go through the shared wagmi config's
// public client (the app's own Base transport) so they work without a wallet
// and never depend on which chain the wallet is pointed at; the wallet is only
// asked to switch chains, sign transactions, and sign allocation vouchers.
// Contract shape, decoding, and the buy plan live in @splits/pact-core.
import {
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  globalOverride,
  toUsdcBaseUnits,
} from "@splits/pact-core/chain/chain.ts";
import type { ChainClient } from "@splits/pact-core/chain/client.ts";
import {
  deriveOfferingCurve,
  unitsForBudget,
} from "@splits/pact-core/chain/curve.ts";
import type { Pact } from "@splits/pact-core/chain/curve.ts";
import { buildOfferingFactoryInputs } from "@splits/pact-core/chain/liquid-split.ts";
import {
  availablePrivateUnits,
  availablePublicUnits,
  offeringRecordFromLog,
  offeringStateCurve,
  quote,
  readOffering,
} from "@splits/pact-core/chain/reads.ts";
import type {
  OfferingRecord,
  OfferingState,
} from "@splits/pact-core/chain/reads.ts";
import { voucherTypedData } from "@splits/pact-core/chain/voucher.ts";
import type {
  DecodedVoucherLink,
  Voucher,
} from "@splits/pact-core/chain/voucher.ts";
import { planBuy, withSlippage } from "@splits/pact-core/chain/writes.ts";
import type { Call } from "@splits/pact-core/chain/writes.ts";
import {
  OFFERING_ABI,
  OFFERING_FACTORY_ABI,
  OFFERING_FACTORY_ADDRESS,
  PACT_TOKEN_ABI,
} from "@splits/pact-core/generated/offering-contracts.ts";
import {
  erc20Abi,
  getAddress,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
} from "viem";
import type { Address, Hex, Log } from "viem";
import {
  getAccount,
  getCapabilities,
  getPublicClient,
  sendTransaction,
  signTypedData,
  switchChain,
  sendCalls as wagmiSendCalls,
  waitForCallsStatus,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";

import { wagmiConfig } from "#lib/chain/wagmi.ts";

// wagmi's public client batches same-tick reads through multicall, so core's
// per-field reads cost one round trip.
export const client = (): ChainClient =>
  getPublicClient(wagmiConfig) as unknown as ChainClient;

// The token mints to holders and the escrow pushes units to the treasury on
// close/sweep, and both revert on a contract recipient whose
// onERC1155Received doesn't answer with its selector. The create form runs
// the same call the transfer would, so a bad recipient fails in the form,
// not at mint or close. ERC-165 is deliberately not consulted: receivers
// that skip or revert on supportsInterface still take transfers fine.
const erc1155ReceiverAbi = parseAbi([
  "function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes data) returns (bytes4)",
]);
const ON_ERC1155_RECEIVED = "0xf23a6e61";
export async function canReceiveUnits(address: Address): Promise<boolean> {
  const to = getAddress(address);
  const publicClient = getPublicClient(wagmiConfig);
  const code = await publicClient.getCode({ address: to });
  if (!code || code === "0x") return true;
  try {
    const { result } = await publicClient.simulateContract({
      abi: erc1155ReceiverAbi,
      address: to,
      functionName: "onERC1155Received",
      args: [to, to, 0n, 1n, "0x"],
    });
    return result === ON_ERC1155_RECEIVED;
  } catch {
    return false;
  }
}

// cacheTime 0: scans run right after a transaction lands (query
// invalidation), and viem's cached block number can predate that block —
// a scan would then stop one block short of the event it was rerun for.
export async function getLatestBlockNumber(): Promise<number> {
  return Number(await client().getBlockNumber({ cacheTime: 0 }));
}

// Block timestamp in seconds — used by the receipt page to date a purchase.
export async function getBlockTimestamp(blockNumber: number): Promise<number> {
  const block = await getPublicClient(wagmiConfig).getBlock({
    blockNumber: BigInt(blockNumber),
  });
  return Number(block.timestamp);
}

// The receipt slice the app consumes — satisfied by both viem transaction
// receipts and EIP-5792 batch receipts (WalletCallReceipt), whose logs carry
// only address/data/topics. parseEventLogs declares `(Log | RpcLog)[]` input
// but reads just those three fields to decode, so its call sites cast to
// bridge the over-strict declaration.
export interface ReceiptLike {
  status: "success" | "reverted";
  blockNumber: bigint;
  transactionHash: Hex;
  logs: { address: Hex; data: Hex; topics: Hex[] }[];
}

function assertNotReverted(receipt: { status: string }, message: string): void {
  if (receipt.status === "reverted") throw new Error(message);
}

// wagmi's switchChain adds the chain (with viem's public-RPC base metadata,
// never our keyed transport URL) when the wallet lacks it.
async function ensureBase(): Promise<void> {
  if (getAccount(wagmiConfig).chainId === BASE_CHAIN_ID) return;
  await switchChain(wagmiConfig, { chainId: BASE_CHAIN_ID });
}

function decodeOfferingCreated(
  receipt: ReceiptLike,
  factoryAddress: string,
): OfferingRecord {
  const factory = getAddress(factoryAddress);
  const [created] = parseEventLogs({
    abi: OFFERING_FACTORY_ABI,
    eventName: "OfferingCreated",
    logs: receipt.logs as Log[],
  }).filter((log) => isAddressEqual(getAddress(log.address), factory));
  if (!created)
    throw new Error(
      "Offering creation event was not found in the transaction receipt.",
    );
  return offeringRecordFromLog({
    ...created,
    blockNumber: created.blockNumber ?? receipt.blockNumber,
    transactionHash: created.transactionHash ?? receipt.transactionHash,
    logIndex: created.logIndex ?? 0,
  });
}

export async function createOffering({
  pact,
  owner,
  factoryAddress,
}: {
  pact: Pact;
  owner: Address;
  factoryAddress?: Address;
}) {
  const factory =
    factoryAddress ||
    (globalOverride("PACT_OFFERING_FACTORY_ADDRESS") as Address | undefined) ||
    OFFERING_FACTORY_ADDRESS;
  if (!owner) throw new Error("Connected wallet is required.");
  if (!factory) throw new Error("Offering factory has not been deployed yet.");
  const curve = deriveOfferingCurve(pact);
  if (!curve)
    throw new Error("Valid valuation band and offering units are required.");

  await ensureBase();
  const normalizedOwner = getAddress(owner);
  const treasury = getAddress(pact.proceedsAddress);
  const closeDate =
    Math.floor(Date.now() / 1000) + Number(pact.minimum.deadlineDays) * 86400;
  const inputs = buildOfferingFactoryInputs(pact);
  const publicUnits = Math.min(
    Number(pact.publicUnits) || 0,
    inputs.offeringUnits,
  );

  const txHash = await writeContract(wagmiConfig, {
    account: normalizedOwner,
    address: getAddress(factory),
    abi: OFFERING_FACTORY_ABI,
    functionName: "createOffering",
    args: [
      pact.projectName,
      toUsdcBaseUnits(pact.raise.min),
      BigInt(closeDate),
      curve.priceStart,
      curve.priceSlope,
      BigInt(publicUnits),
      treasury,
      normalizedOwner,
      inputs.holderAccounts,
      inputs.holderAllocations,
      inputs.offeringUnits,
    ],
    chainId: BASE_CHAIN_ID,
  });
  const receipt = await waitForTransactionReceipt(wagmiConfig, {
    hash: txHash,
  });
  assertNotReverted(receipt, "Offering creation transaction reverted.");
  return {
    chainId: BASE_CHAIN_ID,
    factoryAddress: getAddress(factory),
    curve,
    ...decodeOfferingCreated(receipt, factory),
  };
}

export function getOfferingState({
  offeringAddress,
  buyer,
}: {
  offeringAddress: Address;
  buyer?: Address | null;
}) {
  return readOffering(client(), offeringAddress, buyer);
}

export async function getProjectName({
  pactToken,
}: {
  pactToken: Address;
}): Promise<string> {
  return client().readContract({
    address: getAddress(pactToken),
    abi: PACT_TOKEN_ABI,
    functionName: "projectName",
  });
}

export async function isAllocationConsumed({
  offeringAddress,
  allocationId,
}: {
  offeringAddress: Address;
  allocationId: Hex;
}): Promise<boolean> {
  return client().readContract({
    address: getAddress(offeringAddress),
    abi: OFFERING_ABI,
    functionName: "allocationConsumed",
    args: [allocationId],
  });
}

// Signs an allocation voucher with the offering owner's wallet. Returns the
// hex signature; the caller assembles the share link.
export async function signVoucher({
  owner,
  offeringAddress,
  voucher,
}: {
  owner: Address;
  offeringAddress: Address;
  voucher: Voucher;
}): Promise<Hex> {
  await ensureBase();
  const typedData = voucherTypedData({
    offering: getAddress(offeringAddress),
    chainId: BASE_CHAIN_ID,
    voucher,
  });
  return signTypedData(wagmiConfig, {
    account: getAddress(owner),
    ...typedData,
  });
}

// EIP-5792: does this wallet execute batched calls atomically on Base?
// Unsupported/unknown methods just mean "no" — the sequential flow works everywhere.
async function atomicBatchSupported(account: Address): Promise<boolean> {
  try {
    const capabilities = await getCapabilities(wagmiConfig, {
      account,
      chainId: BASE_CHAIN_ID,
    });
    const status = capabilities.atomic?.status;
    return status === "supported" || status === "ready";
  } catch {
    return false;
  }
}

export interface SendResult {
  txHashes: Hex[];
  // The last call's receipt; when the batch lands atomically, the only one.
  receipt: ReceiptLike;
}

// Sends a call sequence from the connected wallet: one prompt via an EIP-5792
// atomic batch when the wallet supports it, else one transaction per call,
// each after the previous receipt (so a buy's gas estimation never runs
// against the allowance its approve is still granting).
export async function sendCalls(
  from: Address,
  calls: Call[],
): Promise<SendResult> {
  if (!from) throw new Error("Connected wallet is required.");
  const account = getAddress(from);
  await ensureBase();

  if (calls.length > 1 && (await atomicBatchSupported(account))) {
    const { id } = await wagmiSendCalls(wagmiConfig, {
      account,
      chainId: BASE_CHAIN_ID,
      forceAtomic: true,
      calls: calls.map(({ to, data, value }) => ({ to, data, value })),
    });
    const { receipts } = await waitForCallsStatus(wagmiConfig, {
      id,
      throwOnFailure: true,
    });
    const receipt: ReceiptLike | undefined = receipts?.[receipts.length - 1];
    if (!receipt) throw new Error("Wallet did not return a batch receipt.");
    return { txHashes: [receipt.transactionHash], receipt };
  }

  const txHashes: Hex[] = [];
  let receipt: ReceiptLike | undefined;
  for (const call of calls) {
    const hash = await sendTransaction(wagmiConfig, {
      account,
      chainId: BASE_CHAIN_ID,
      to: call.to,
      data: call.data,
      value: call.value ?? 0n,
    });
    txHashes.push(hash);
    receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
    assertNotReverted(receipt, `${call.description} reverted.`);
  }
  if (!receipt) throw new Error("Nothing to send.");
  return { txHashes, receipt };
}

export const sendCall = (from: Address, call: Call) => sendCalls(from, [call]);

const usdcAllowance = (buyer: Address, offering: Address) =>
  client().readContract({
    address: BASE_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [buyer, offering],
  });

// Thrown before any transaction when the curve moved between the quote the
// buyer saw and submit: money can only ever move on terms the buyer has
// confirmed on screen. Carries the fresh quote so the page can re-render it.
export class QuoteChangedError extends Error {
  readonly units: number;
  readonly cost: bigint;
  constructor(units: number, cost: bigint) {
    super("Prices moved since your quote.");
    this.units = units;
    this.cost = cost;
  }
}

// Fresh state, units for the budget, the contract's quote, and the plan;
// throws QuoteChangedError before anything is sent when the fresh quote
// differs from the one the buyer confirmed.
async function buy({
  record,
  buyer,
  budget,
  available,
  tooSmall,
  expected,
  plan,
}: {
  record: OfferingRecord;
  buyer: Address;
  budget: bigint;
  available: (state: OfferingState) => number;
  // The error when the budget does not reach one whole unit.
  tooSmall: string;
  expected?: { units: number; cost: bigint } | undefined;
  plan: (input: {
    units: number;
    cost: bigint;
    maxCost: bigint;
    allowance: bigint;
  }) => Promise<Call[]>;
}) {
  if (!buyer) throw new Error("Connected wallet is required.");
  await ensureBase();
  const account = getAddress(buyer);
  const state = await readOffering(client(), record.offering);
  const curve = offeringStateCurve(state);
  const units = unitsForBudget(
    curve,
    state.unitsSold,
    available(state),
    budget,
  );
  if (units <= 0) throw new Error(tooSmall);
  const cost = await quote(client(), record.offering, units);
  if (expected && (units !== expected.units || cost !== expected.cost))
    throw new QuoteChangedError(units, cost);
  // Slippage headroom never exceeds the budget: a race degrades to fewer
  // units, never to overspending.
  const padded = withSlippage(cost);
  const maxCost = padded < budget ? padded : budget;
  const allowance = await usdcAllowance(account, record.offering);
  const calls = await plan({ units, cost, maxCost, allowance });
  const { receipt } = await sendCalls(account, calls);
  return { state, units, cost, maxCost, txHash: receipt.transactionHash };
}

// The buyer's typed dollars are a hard budget: units are recomputed from
// fresh chain state at submit.
export async function buyPublicOffering({
  buyer,
  record,
  budgetUsdc,
  expected,
  buyerName = "",
}: {
  buyer: Address;
  record: OfferingRecord;
  budgetUsdc: bigint;
  expected?: { units: number; cost: bigint };
  buyerName?: string;
}) {
  return buy({
    record,
    buyer,
    budget: budgetUsdc,
    available: availablePublicUnits,
    tooSmall: "The amount is below the current price of one unit.",
    expected,
    plan: (input) =>
      planBuy({ record, buyer: getAddress(buyer), buyerName, ...input }),
  });
}

// Claims a private allocation: the plan signs the buyer with the link key,
// and the voucher cap bounds both the units and the slippage headroom.
export async function buyPrivateOffering({
  buyer,
  record,
  link,
  expected,
}: {
  buyer: Address;
  record: OfferingRecord;
  link: DecodedVoucherLink;
  expected?: { units: number; cost: bigint };
}) {
  return buy({
    record,
    buyer,
    budget: link.voucher.amountCapUsdc,
    available: availablePrivateUnits,
    tooSmall:
      "The allocation is too small to buy one whole unit at the current curve price.",
    expected,
    plan: (input) =>
      planBuy({
        record,
        buyer: getAddress(buyer),
        claim: { voucher: link, chainId: BASE_CHAIN_ID },
        ...input,
      }),
  });
}
