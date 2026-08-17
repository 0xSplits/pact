// All contract interaction for the browser. Reads always go through the
// shared wagmi config's public client (the app's own Base transport) so they
// work without a wallet and never depend on which chain the wallet is pointed
// at; the wallet is only asked to switch chains, sign transactions, and sign
// allocation vouchers.
//
// Amounts are plain numbers in USDC base units. That is safe well past any
// raise size this prototype targets (Number stays exact below ~$9B). The
// bigint→number conversion happens exactly where reads and events decode.
import { erc20Abi, getAddress, isAddressEqual, parseEventLogs } from "viem";
import type {
  Abi,
  AbiEvent,
  Address,
  ContractFunctionParameters,
  Hex,
  Log,
  TransactionReceipt,
} from "viem";
import {
  getAccount,
  getCapabilities,
  getPublicClient,
  readContracts,
  sendCalls,
  signTypedData,
  switchChain,
  waitForCallsStatus,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";

import {
  OFFERING_ABI,
  OFFERING_FACTORY_ABI,
  OFFERING_FACTORY_ADDRESS,
  PACT_TOKEN_ABI,
} from "#generated/offering-contracts.ts";
import {
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  globalOverride,
  toUsdcBaseUnits,
} from "#lib/chain/chain.ts";
import {
  costForUnits,
  deriveOfferingCurve,
  unitsForBudget,
} from "#lib/chain/curve.ts";
import type { CurveParams, Pact } from "#lib/chain/curve.ts";
import { buildOfferingFactoryInputs } from "#lib/chain/liquid-split.ts";
import { signClaim, voucherTypedData } from "#lib/chain/voucher.ts";
import type { Voucher } from "#lib/chain/voucher.ts";
import { wagmiConfig } from "#lib/chain/wagmi.ts";

const client = () => getPublicClient(wagmiConfig);

// A block-range log request with the event(s) to decode. Callers chunk
// ranges themselves — public Base RPC caps a request at 10k blocks (see
// offerings.ts) — and get back viem-decoded logs (typed `args`).
export type GetLogsFn = (args: {
  address?: Address;
  event?: AbiEvent;
  events?: readonly AbiEvent[];
  args?: Record<string, unknown>;
  fromBlock: number;
  toBlock: number;
}) => Promise<any[]>;

export const getLogs: GetLogsFn = async ({ fromBlock, toBlock, ...filter }) =>
  client().getLogs({
    ...filter,
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
    strict: true,
  } as any);

export async function getLatestBlockNumber(): Promise<number> {
  return Number(await client().getBlockNumber());
}

// The receipt slice the app consumes — satisfied by both viem transaction
// receipts and EIP-5792 batch receipts (whose logs still carry raw hex
// quantities; Number() parses those too).
interface ReceiptLike {
  status: "success" | "reverted";
  blockNumber: bigint;
  transactionHash: Hex;
  logs: unknown[];
}

function assertNotReverted(receipt: { status: string }, message: string): void {
  if (receipt.status === "reverted") throw new Error(message);
}

// The offering record shape cached by the listing scan (offerings.ts) and
// seeded by the create flow, decoded from an OfferingCreated log.
export interface OfferingRecord {
  offering: Address;
  pactToken: Address;
  issuer: Address;
  treasury: Address;
  projectName: string;
  raiseMin: number;
  closeDate: number;
  priceStart: number;
  priceSlope: number;
  publicUnits: number;
  blockNumber: number | null;
  txHash: string | null;
}

// The purchase shape used across the app, decoded from a Bought log.
export interface Purchase {
  offering: Address;
  buyer: Address;
  allocationId: Hex;
  units: number;
  cost: number;
  buyerName: string;
  blockNumber: number | null;
  txHash: string | null;
  logIndex: number;
}

// Full offering snapshot from one batched read. This shape is the canonical
// "offering state" used across the app; the contract is always authoritative.
export interface OfferingState {
  offeringAddress: Address;
  remainingUnits: number;
  unitsSold: number;
  minMet: boolean;
  state: number;
  raised: number;
  withdrawn: number;
  raiseMin: number;
  closeDate: number;
  owner: Address;
  treasury: Address;
  pactToken: Address;
  priceStart: number;
  priceSlope: number;
  publicUnits: number;
  publicUnitsSold: number;
  deposit?: number;
}

// wagmi's switchChain adds the chain (with viem's public-RPC base metadata,
// never our keyed transport URL) when the wallet lacks it.
async function ensureBase(): Promise<void> {
  if (getAccount(wagmiConfig).chainId === BASE_CHAIN_ID) return;
  await switchChain(wagmiConfig, { chainId: BASE_CHAIN_ID });
}

// Batched reads in one multicall round trip; wagmi degrades to per-call
// reads when the aggregate call fails.
export async function readMany(
  calls: ContractFunctionParameters[],
): Promise<unknown[]> {
  return readContracts(wagmiConfig, {
    contracts: calls,
    allowFailure: false,
  }) as Promise<unknown[]>;
}

// Maps a viem-decoded OfferingCreated log to the all-number, JSON-safe record
// the listing caches store (a bigint anywhere in it would break them).
export function offeringRecordFromLog(log: {
  args: {
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
  blockNumber?: bigint | number | string | null;
  transactionHash?: Hex | null;
}): OfferingRecord {
  const { args } = log;
  return {
    offering: getAddress(args.offering),
    pactToken: getAddress(args.pactToken),
    issuer: getAddress(args.issuer),
    treasury: getAddress(args.treasury),
    projectName: args.projectName,
    raiseMin: Number(args.raiseMin),
    closeDate: Number(args.closeDate),
    priceStart: Number(args.priceStart),
    priceSlope: Number(args.priceSlope),
    publicUnits: Number(args.publicUnits),
    blockNumber: log.blockNumber != null ? Number(log.blockNumber) : null,
    txHash: log.transactionHash || null,
  };
}

// Maps a viem-decoded Bought log to the all-number purchase shape.
export function purchaseFromLog(log: {
  address: string;
  args: {
    buyer: Address;
    allocationId: Hex;
    units: bigint;
    cost: bigint;
    buyerName: string;
  };
  blockNumber?: bigint | number | string | null;
  transactionHash?: Hex | null;
  logIndex?: bigint | number | string | null;
}): Purchase {
  const { args } = log;
  return {
    offering: getAddress(log.address),
    buyer: getAddress(args.buyer),
    allocationId: args.allocationId,
    units: Number(args.units),
    cost: Number(args.cost),
    buyerName: args.buyerName || "",
    blockNumber: log.blockNumber != null ? Number(log.blockNumber) : null,
    txHash: log.transactionHash || null,
    logIndex: log.logIndex != null ? Number(log.logIndex) : 0,
  };
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
  return offeringRecordFromLog(created);
}

function purchaseFromReceipt(
  receipt: ReceiptLike,
  offering: Address,
  buyer: Address,
): Purchase | null {
  const [bought] = parseEventLogs({
    abi: OFFERING_ABI,
    eventName: "Bought",
    logs: receipt.logs as Log[],
    args: { buyer },
  }).filter((log) => isAddressEqual(getAddress(log.address), offering));
  return bought ? purchaseFromLog(bought) : null;
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
  const inputs = buildOfferingFactoryInputs(pact, { getAddress });
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
      BigInt(toUsdcBaseUnits(pact.raise.min)),
      BigInt(closeDate),
      BigInt(curve.priceStart),
      BigInt(curve.priceSlope),
      BigInt(publicUnits),
      treasury,
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
  const created = decodeOfferingCreated(receipt, factory);
  return {
    chainId: BASE_CHAIN_ID,
    factoryAddress: getAddress(factory),
    transactionHash: txHash,
    curve,
    ...created,
    blockNumber:
      created.blockNumber != null
        ? created.blockNumber
        : Number(receipt.blockNumber),
  };
}

export async function getOfferingState({
  offeringAddress,
  buyer,
}: {
  offeringAddress: Address;
  buyer?: Address | null;
}): Promise<OfferingState> {
  const offering = getAddress(offeringAddress);
  const normalizedBuyer = buyer ? getAddress(buyer) : null;
  const fields = [
    "remainingUnits",
    "unitsSold",
    "minMet",
    "state",
    "raised",
    "withdrawn",
    "raiseMin",
    "closeDate",
    "owner",
    "treasury",
    "pactToken",
    "priceStart",
    "priceSlope",
    "publicUnits",
    "publicUnitsSold",
  ] as const;
  const calls: ContractFunctionParameters[] = fields.map((functionName) => ({
    address: offering,
    abi: OFFERING_ABI,
    functionName,
  }));
  if (normalizedBuyer)
    calls.push({
      address: offering,
      abi: OFFERING_ABI,
      functionName: "deposits",
      args: [normalizedBuyer],
    });
  const values = await readMany(calls);
  // Zip results back to their field names so reordering or inserting a field
  // can never silently shift every value after it.
  const v = Object.fromEntries(
    fields.map((name, i) => [name, values[i]]),
  ) as Record<(typeof fields)[number], unknown>;
  const result: OfferingState = {
    offeringAddress: offering,
    remainingUnits: Number(v.remainingUnits),
    unitsSold: Number(v.unitsSold),
    minMet: v.minMet as boolean,
    state: Number(v.state),
    raised: Number(v.raised),
    withdrawn: Number(v.withdrawn),
    raiseMin: Number(v.raiseMin),
    closeDate: Number(v.closeDate),
    owner: getAddress(v.owner as string),
    treasury: getAddress(v.treasury as string),
    pactToken: getAddress(v.pactToken as string),
    priceStart: Number(v.priceStart),
    priceSlope: Number(v.priceSlope),
    publicUnits: Number(v.publicUnits),
    publicUnitsSold: Number(v.publicUnitsSold),
  };
  if (normalizedBuyer) result.deposit = Number(values[fields.length]);
  return result;
}

// Curve parameters straight off an offering-state read.
export const offeringStateCurve = (
  state: Pick<OfferingState, "priceStart" | "priceSlope">,
): CurveParams => ({
  priceStart: state.priceStart,
  priceSlope: state.priceSlope,
});

// Public units still purchasable: capped by both remaining supply and the
// owner-set public tranche.
export const availablePublicUnits = (
  state: Pick<
    OfferingState,
    "remainingUnits" | "publicUnits" | "publicUnitsSold"
  >,
): number =>
  Math.min(
    state.remainingUnits,
    Math.max(0, state.publicUnits - state.publicUnitsSold),
  );

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

// Options shared by every state-changing offering call.
export interface OfferingTxOptions {
  from: Address;
  offeringAddress: Address;
}

async function sendOfferingFunction({
  from,
  offeringAddress,
  functionName,
  args = [],
}: OfferingTxOptions & {
  functionName: string;
  args?: readonly unknown[];
}) {
  if (!from) throw new Error("Connected wallet is required.");
  const offering = getAddress(offeringAddress);
  await ensureBase();
  const txHash = await writeContract(wagmiConfig, {
    account: getAddress(from),
    address: offering,
    abi: OFFERING_ABI as Abi,
    functionName,
    args,
    chainId: BASE_CHAIN_ID,
  });
  const receipt = await waitForTransactionReceipt(wagmiConfig, {
    hash: txHash,
  });
  assertNotReverted(receipt, "Offering transaction reverted.");
  return { txHash, receipt };
}

export function withdrawOffering(options: OfferingTxOptions) {
  return sendOfferingFunction({ ...options, functionName: "withdraw" });
}

export function closeAndWithdrawOffering(options: OfferingTxOptions) {
  return sendOfferingFunction({ ...options, functionName: "closeAndWithdraw" });
}

export function markOfferingFailed(options: OfferingTxOptions) {
  return sendOfferingFunction({ ...options, functionName: "markFailed" });
}

export function refundOffering(options: OfferingTxOptions) {
  return sendOfferingFunction({ ...options, functionName: "refund" });
}

export function refundAllOffering(
  options: OfferingTxOptions & { buyers?: Address[] },
) {
  const buyers = (options.buyers || []).map((a) => getAddress(a));
  return sendOfferingFunction({
    ...options,
    functionName: "refundAll",
    args: [buyers],
  });
}

export function sweepFailedUnits(options: OfferingTxOptions) {
  return sendOfferingFunction({ ...options, functionName: "sweepFailedUnits" });
}

export function setPublicUnits(
  options: OfferingTxOptions & { publicUnits: number },
) {
  return sendOfferingFunction({
    ...options,
    functionName: "setPublicUnits",
    args: [BigInt(options.publicUnits)],
  });
}

export function cancelAllocation(
  options: OfferingTxOptions & { allocationId: Hex },
) {
  return sendOfferingFunction({
    ...options,
    functionName: "cancelAllocation",
    args: [options.allocationId],
  });
}

// EIP-5792: does this wallet execute batched calls atomically on Base?
// Unsupported/unknown methods just mean "no" — the two-transaction flow works everywhere.
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

const usdcAllowance = (buyer: Address, offering: Address) =>
  client().readContract({
    address: BASE_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [buyer, offering],
  });

// The buy transaction in contract-call form, usable by both the batch
// (sendCalls) and sequential (writeContract) paths.
interface BuyCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

// Approve (when needed) and buy. One wallet prompt via an EIP-5792 atomic
// batch when the wallet supports it, else the sequential two-transaction flow
// (which waits for the approve receipt before sending the buy, so the buy's
// gas estimation never runs against a zero allowance).
async function payWithApproval({
  buyer,
  offering,
  amount,
  buyCall,
}: {
  buyer: Address;
  offering: Address;
  amount: number;
  buyCall: BuyCall;
}): Promise<{
  approveTxHash: Hex | null;
  buyTxHash: Hex;
  buyReceipt: ReceiptLike;
}> {
  const approveArgs = {
    abi: erc20Abi,
    functionName: "approve",
    args: [offering, BigInt(amount)],
  } as const;
  const needsApproval = (await usdcAllowance(buyer, offering)) < BigInt(amount);

  if (needsApproval && (await atomicBatchSupported(buyer))) {
    const { id } = await sendCalls(wagmiConfig, {
      account: buyer,
      chainId: BASE_CHAIN_ID,
      forceAtomic: true,
      calls: [
        { to: BASE_USDC_ADDRESS, ...approveArgs },
        {
          to: buyCall.address,
          abi: buyCall.abi,
          functionName: buyCall.functionName,
          args: buyCall.args,
        },
      ],
    });
    const { receipts } = await waitForCallsStatus(wagmiConfig, {
      id,
      throwOnFailure: true,
    });
    // The batch lands as one transaction when atomic; the last receipt carries it.
    const buyReceipt = receipts?.[receipts.length - 1] as
      ReceiptLike | undefined;
    if (!buyReceipt) throw new Error("Wallet did not return a batch receipt.");
    return {
      approveTxHash: null,
      buyTxHash: buyReceipt.transactionHash,
      buyReceipt,
    };
  }

  let approveTxHash: Hex | null = null;
  if (needsApproval) {
    approveTxHash = await writeContract(wagmiConfig, {
      account: buyer,
      chainId: BASE_CHAIN_ID,
      address: BASE_USDC_ADDRESS,
      ...approveArgs,
    });
    const approveReceipt = await waitForTransactionReceipt(wagmiConfig, {
      hash: approveTxHash,
    });
    assertNotReverted(approveReceipt, "USDC approval reverted.");
  }
  const buyTxHash = await writeContract(wagmiConfig, {
    account: buyer,
    chainId: BASE_CHAIN_ID,
    ...buyCall,
  });
  const buyReceipt: TransactionReceipt = await waitForTransactionReceipt(
    wagmiConfig,
    { hash: buyTxHash },
  );
  return { approveTxHash, buyTxHash, buyReceipt };
}

export async function quotePublicPurchase({
  offeringAddress,
  units,
}: {
  offeringAddress: Address;
  units: number;
}) {
  if (!Number.isInteger(units) || units <= 0)
    throw new Error("Enter at least one whole unit.");
  const state = await getOfferingState({ offeringAddress });
  const available = availablePublicUnits(state);
  if (units > available)
    throw new Error(`Only ${available} public units remain.`);
  const curve = offeringStateCurve(state);
  const cost = costForUnits(curve, state.unitsSold, units);
  const maxCost = Math.ceil(cost * 1.01);
  return { state, units, cost, maxCost };
}

export async function buyPublicOffering({
  buyer,
  offeringAddress,
  units,
  buyerName = "",
}: {
  buyer: Address;
  offeringAddress: Address;
  units: number;
  buyerName?: string;
}) {
  if (!buyer) throw new Error("Connected wallet is required.");
  await ensureBase();
  const normalizedBuyer = getAddress(buyer);
  const offering = getAddress(offeringAddress);
  const quote = await quotePublicPurchase({ offeringAddress, units });
  const { approveTxHash, buyTxHash, buyReceipt } = await payWithApproval({
    buyer: normalizedBuyer,
    offering,
    amount: quote.maxCost,
    buyCall: {
      address: offering,
      abi: OFFERING_ABI,
      functionName: "buyPublic",
      args: [BigInt(quote.units), BigInt(quote.maxCost), buyerName],
    },
  });
  assertNotReverted(buyReceipt, "Offering purchase reverted.");
  const purchase = purchaseFromReceipt(buyReceipt, offering, normalizedBuyer);
  return { ...quote, ...(purchase || {}), approveTxHash, buyTxHash };
}

// Claims a private allocation: the buyer's wallet sends buyPrivate carrying
// the owner-signed voucher and a fresh link-key signature over the buyer.
export async function buyPrivateOffering({
  buyer,
  offeringAddress,
  voucher,
  ownerSig,
  linkPrivateKey,
}: {
  buyer: Address;
  offeringAddress: Address;
  voucher: Voucher;
  ownerSig: Hex;
  linkPrivateKey: Hex;
}) {
  if (!buyer) throw new Error("Connected wallet is required.");

  await ensureBase();
  const normalizedBuyer = getAddress(buyer);
  const offering = getAddress(offeringAddress);
  const state = await getOfferingState({ offeringAddress });
  const curve = offeringStateCurve(state);
  const cap = Number(voucher.amountCapUsdc);
  const units = unitsForBudget(
    curve,
    state.unitsSold,
    state.remainingUnits,
    cap,
  );
  if (units <= 0)
    throw new Error(
      "The allocation is too small to buy one whole unit at the current curve price.",
    );
  const cost = costForUnits(curve, state.unitsSold, units);
  // The voucher cap bounds slippage: price drift between invite and claim is
  // accepted, but never beyond the dollars the owner endorsed.
  const maxCost = Math.min(cap, Math.ceil(cost * 1.01));

  const claimSig = await signClaim({
    linkPrivateKey,
    offering,
    allocationId: voucher.allocationId,
    buyer: normalizedBuyer,
  });
  const { approveTxHash, buyTxHash, buyReceipt } = await payWithApproval({
    buyer: normalizedBuyer,
    offering,
    amount: maxCost,
    buyCall: {
      address: offering,
      abi: OFFERING_ABI,
      functionName: "buyPrivate",
      args: [
        {
          allocationId: voucher.allocationId,
          buyerName: voucher.buyerName,
          amountCapUsdc: BigInt(voucher.amountCapUsdc),
          linkKey: voucher.linkKey,
        },
        ownerSig,
        claimSig,
        BigInt(units),
        BigInt(maxCost),
      ],
    },
  });
  assertNotReverted(buyReceipt, "Allocation claim reverted.");
  const purchase = purchaseFromReceipt(buyReceipt, offering, normalizedBuyer);
  return {
    state,
    units,
    cost,
    maxCost,
    ...(purchase || {}),
    approveTxHash,
    buyTxHash,
  };
}
