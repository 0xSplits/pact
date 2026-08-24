// All contract interaction for the browser. Reads always go through the
// shared wagmi config's public client (the app's own Base transport) so they
// work without a wallet and never depend on which chain the wallet is pointed
// at; the wallet is only asked to switch chains, sign transactions, and sign
// allocation vouchers.
//
// Amounts are bigint USDC base units end to end, mirroring the contract's
// uint256 math exactly. The only conversions are at the edges: parseUnits on
// dollar input (chain.ts), formatUnits at the display boundary (format.ts),
// and decimal strings inside the JSON localStorage caches.
import {
  erc20Abi,
  getAddress,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
} from "viem";
import type {
  Abi,
  AbiEvent,
  Address,
  ContractFunctionArgs,
  ContractFunctionName,
  Hex,
  Log,
  TransactionReceipt,
} from "viem";
import {
  getAccount,
  getCapabilities,
  getPublicClient,
  readContract,
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

// ERC-165 id of IERC1155Receiver. The token mints to holders with the receiver
// check and the escrow pushes units to the treasury on close/sweep, so a
// contract recipient without the hook makes the deploy (holders) or the close
// (treasury) revert; the create form checks every recipient first.
const ERC1155_RECEIVER_INTERFACE_ID = "0x4e2312e0";
const erc165Abi = parseAbi([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
]);
export async function canReceiveUnits(address: Address): Promise<boolean> {
  const code = await client().getCode({ address: getAddress(address) });
  if (!code || code === "0x") return true;
  try {
    return await readContract(wagmiConfig, {
      abi: erc165Abi,
      address: getAddress(address),
      functionName: "supportsInterface",
      args: [ERC1155_RECEIVER_INTERFACE_ID],
    });
  } catch {
    return false;
  }
}

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

// viem types `event`/`events` as mutually exclusive, so spreading a filter
// holding both optionals breaks the union — branch instead.
export const getLogs: GetLogsFn = async ({
  fromBlock,
  toBlock,
  address,
  event,
  events,
  args,
}) => {
  const range = {
    address,
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
    strict: true,
  } as const;
  return event
    ? client().getLogs({ ...range, event, args })
    : client().getLogs({ ...range, events });
};

// cacheTime 0: scans run right after a transaction lands (query
// invalidation), and viem's cached block number can predate that block —
// a scan would then stop one block short of the event it was rerun for.
export async function getLatestBlockNumber(): Promise<number> {
  return Number(await client().getBlockNumber({ cacheTime: 0 }));
}

// Block timestamp in seconds — used by the receipt page to date a purchase.
export async function getBlockTimestamp(blockNumber: number): Promise<number> {
  const block = await client().getBlock({ blockNumber: BigInt(blockNumber) });
  return Number(block.timestamp);
}

// The receipt slice the app consumes — satisfied by both viem transaction
// receipts and EIP-5792 batch receipts (WalletCallReceipt), whose logs carry
// only address/data/topics. parseEventLogs declares `(Log | RpcLog)[]` input
// but reads just those three fields to decode, so its call sites cast to
// bridge the over-strict declaration.
interface ReceiptLike {
  status: "success" | "reverted";
  blockNumber: bigint;
  transactionHash: Hex;
  logs: { address: Hex; data: Hex; topics: Hex[] }[];
}

function assertNotReverted(receipt: { status: string }, message: string): void {
  if (receipt.status === "reverted") throw new Error(message);
}

// The offering record shape cached by the listing scan (offerings.ts) and
// seeded by the create flow, decoded from an OfferingCreated log. USDC
// amounts are decimal strings so the record stays JSON-safe for the cache;
// convert with BigInt() (which also accepts the integer numbers older cached
// entries carry) before doing math.
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
  blockNumber: number | null;
  txHash: string | null;
}

// The purchase shape used across the app, decoded from a Bought log.
// `cost` is a decimal string for the same JSON-cache reason as above.
export interface Purchase {
  offering: Address;
  buyer: Address;
  allocationId: Hex;
  units: number;
  cost: string;
  buyerName: string;
  blockNumber: number | null;
  txHash: string | null;
  logIndex: number;
}

// A terminal-lifecycle log on one offering — how the raise ended, refund
// progress, and escrow sweeps — decoded from the events the final-state view
// scans. USDC amounts are decimal strings for the same JSON-cache reason as
// above.
export type LifecycleEvent = {
  txHash: string | null;
  blockNumber: number | null;
  logIndex: number;
} & (
  | { type: "failed" }
  | { type: "closed"; usdcAmount: string; unsoldUnits: number }
  | { type: "refund-paid"; buyer: Address; amount: string }
  | { type: "refund-skipped"; buyer: Address }
  | { type: "swept"; units: number }
);

// Maps a viem-decoded lifecycle log (Failed/Closed/RefundPaid/RefundSkipped/
// FailedUnitsSwept) to the JSON-safe shape above; null for other events.
export function lifecycleEventFromLog(log: {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber?: bigint | number | string | null;
  transactionHash?: Hex | null;
  logIndex?: bigint | number | string | null;
}): LifecycleEvent | null {
  const base = {
    txHash: log.transactionHash || null,
    blockNumber: log.blockNumber != null ? Number(log.blockNumber) : null,
    logIndex: log.logIndex != null ? Number(log.logIndex) : 0,
  };
  const { args } = log;
  switch (log.eventName) {
    case "Failed":
      return { ...base, type: "failed" };
    case "Closed":
      return {
        ...base,
        type: "closed",
        usdcAmount: BigInt(args.usdcAmount as bigint).toString(),
        unsoldUnits: Number(args.unsoldUnits),
      };
    case "RefundPaid":
      return {
        ...base,
        type: "refund-paid",
        buyer: getAddress(args.buyer as Address),
        amount: BigInt(args.amount as bigint).toString(),
      };
    case "RefundSkipped":
      return {
        ...base,
        type: "refund-skipped",
        buyer: getAddress(args.buyer as Address),
      };
    case "FailedUnitsSwept":
      return { ...base, type: "swept", units: Number(args.units) };
    default:
      return null;
  }
}

// Full offering snapshot from one batched read. This shape is the canonical
// "offering state" used across the app; the contract is always authoritative.
export interface OfferingState {
  offeringAddress: Address;
  remainingUnits: number;
  unitsSold: number;
  minMet: boolean;
  state: number;
  raised: bigint;
  withdrawn: bigint;
  raiseMin: bigint;
  closeDate: number;
  owner: Address;
  treasury: Address;
  pactToken: Address;
  priceStart: bigint;
  priceSlope: bigint;
  publicUnits: number;
  publicUnitsSold: number;
  deposit?: bigint;
}

// wagmi's switchChain adds the chain (with viem's public-RPC base metadata,
// never our keyed transport URL) when the wallet lacks it.
async function ensureBase(): Promise<void> {
  if (getAccount(wagmiConfig).chainId === BASE_CHAIN_ID) return;
  await switchChain(wagmiConfig, { chainId: BASE_CHAIN_ID });
}

// Maps a viem-decoded OfferingCreated log to the JSON-safe record the listing
// caches store (bigint amounts become decimal strings — JSON.stringify throws
// on bigint).
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
    raiseMin: BigInt(args.raiseMin).toString(),
    closeDate: Number(args.closeDate),
    priceStart: BigInt(args.priceStart).toString(),
    priceSlope: BigInt(args.priceSlope).toString(),
    publicUnits: Number(args.publicUnits),
    blockNumber: log.blockNumber != null ? Number(log.blockNumber) : null,
    txHash: log.transactionHash || null,
  };
}

// Maps a viem-decoded Bought log to the JSON-safe purchase shape.
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
    cost: BigInt(args.cost).toString(),
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
  // Individual typed reads: the public client batches same-tick calls into
  // one multicall round trip (wagmi's default batch.multicall), so this costs
  // a single RPC request while keeping per-field return types.
  const read = <
    functionName extends ContractFunctionName<typeof OFFERING_ABI, "view">,
  >(
    functionName: functionName,
  ) =>
    readContract(wagmiConfig, {
      address: offering,
      abi: OFFERING_ABI,
      functionName,
    });
  const [
    remainingUnits,
    unitsSold,
    minMet,
    state,
    raised,
    withdrawn,
    raiseMin,
    closeDate,
    owner,
    treasury,
    pactToken,
    priceStart,
    priceSlope,
    publicUnits,
    publicUnitsSold,
    deposit,
  ] = await Promise.all([
    read("remainingUnits"),
    read("unitsSold"),
    read("minMet"),
    read("state"),
    read("raised"),
    read("withdrawn"),
    read("raiseMin"),
    read("closeDate"),
    read("owner"),
    read("treasury"),
    read("pactToken"),
    read("priceStart"),
    read("priceSlope"),
    read("publicUnits"),
    read("publicUnitsSold"),
    normalizedBuyer
      ? readContract(wagmiConfig, {
          address: offering,
          abi: OFFERING_ABI,
          functionName: "deposits",
          args: [normalizedBuyer],
        })
      : null,
  ]);
  const result: OfferingState = {
    offeringAddress: offering,
    remainingUnits: Number(remainingUnits),
    unitsSold: Number(unitsSold),
    minMet,
    state: Number(state),
    raised,
    withdrawn,
    raiseMin,
    closeDate: Number(closeDate),
    owner: getAddress(owner),
    treasury: getAddress(treasury),
    pactToken: getAddress(pactToken),
    priceStart,
    priceSlope,
    publicUnits: Number(publicUnits),
    publicUnitsSold: Number(publicUnitsSold),
  };
  if (deposit != null) result.deposit = deposit;
  return result;
}

// Curve parameters straight off an offering-state read (bigint) or a cached
// record (decimal strings; legacy caches may still hold integer numbers).
export const offeringStateCurve = (state: {
  priceStart: bigint | string | number;
  priceSlope: bigint | string | number;
}): CurveParams => ({
  priceStart: BigInt(state.priceStart),
  priceSlope: BigInt(state.priceSlope),
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

// Units a private claim can take: buyPrivate reserves the unsold public
// tranche, so the private ceiling is what remains after that headroom.
export const availablePrivateUnits = (
  state: Pick<
    OfferingState,
    "remainingUnits" | "publicUnits" | "publicUnitsSold"
  >,
): number =>
  Math.max(
    0,
    state.remainingUnits -
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

async function sendOfferingFunction<
  functionName extends ContractFunctionName<
    typeof OFFERING_ABI,
    "nonpayable" | "payable"
  >,
>({
  from,
  offeringAddress,
  functionName,
  args,
}: OfferingTxOptions & {
  functionName: functionName;
  args?: ContractFunctionArgs<
    typeof OFFERING_ABI,
    "nonpayable" | "payable",
    functionName
  >;
}) {
  if (!from) throw new Error("Connected wallet is required.");
  const offering = getAddress(offeringAddress);
  await ensureBase();
  const txHash = await writeContract(wagmiConfig, {
    account: getAddress(from),
    address: offering,
    // wagmi computes its parameter union over concrete function names and
    // can't distribute it over a generic one, so the call widens here; the
    // wrapper signature above still pins the name and args per function.
    abi: OFFERING_ABI as Abi,
    functionName: functionName as string,
    args: args as readonly unknown[] | undefined,
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
  amount: bigint;
  buyCall: BuyCall;
}): Promise<{
  approveTxHash: Hex | null;
  buyTxHash: Hex;
  buyReceipt: ReceiptLike;
}> {
  const approveArgs = {
    abi: erc20Abi,
    functionName: "approve",
    args: [offering, amount],
  } as const;
  const needsApproval = (await usdcAllowance(buyer, offering)) < amount;

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
    const buyReceipt: ReceiptLike | undefined = receipts?.[receipts.length - 1];
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

// +1% slippage headroom, ceil-divided so the buffer never rounds to zero.
const withSlippage = (cost: bigint): bigint => (cost * 101n + 99n) / 100n;

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

// The buyer's typed dollars are a hard budget: units are recomputed from
// fresh chain state at submit and maxCost never exceeds the budget, so a
// race degrades to fewer units, never to overspending.
export async function buyPublicOffering({
  buyer,
  offeringAddress,
  budgetUsdc,
  expected,
  buyerName = "",
}: {
  buyer: Address;
  offeringAddress: Address;
  budgetUsdc: bigint;
  expected?: { units: number; cost: bigint };
  buyerName?: string;
}) {
  if (!buyer) throw new Error("Connected wallet is required.");
  await ensureBase();
  const normalizedBuyer = getAddress(buyer);
  const offering = getAddress(offeringAddress);
  const state = await getOfferingState({ offeringAddress });
  const curve = offeringStateCurve(state);
  const units = unitsForBudget(
    curve,
    state.unitsSold,
    availablePublicUnits(state),
    budgetUsdc,
  );
  if (units <= 0)
    throw new Error("The amount is below the current price of one unit.");
  const cost = costForUnits(curve, state.unitsSold, units);
  if (expected && (units !== expected.units || cost !== expected.cost))
    throw new QuoteChangedError(units, cost);
  const costWithSlippage = withSlippage(cost);
  const maxCost = costWithSlippage < budgetUsdc ? costWithSlippage : budgetUsdc;
  const { approveTxHash, buyTxHash, buyReceipt } = await payWithApproval({
    buyer: normalizedBuyer,
    offering,
    amount: maxCost,
    buyCall: {
      address: offering,
      abi: OFFERING_ABI,
      functionName: "buyPublic",
      args: [BigInt(units), maxCost, buyerName],
    },
  });
  assertNotReverted(buyReceipt, "Offering purchase reverted.");
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

// Claims a private allocation: the buyer's wallet sends buyPrivate carrying
// the owner-signed voucher and a fresh link-key signature over the buyer.
export async function buyPrivateOffering({
  buyer,
  offeringAddress,
  voucher,
  ownerSig,
  linkPrivateKey,
  expected,
}: {
  buyer: Address;
  offeringAddress: Address;
  voucher: Voucher;
  ownerSig: Hex;
  linkPrivateKey: Hex;
  expected?: { units: number; cost: bigint };
}) {
  if (!buyer) throw new Error("Connected wallet is required.");

  await ensureBase();
  const normalizedBuyer = getAddress(buyer);
  const offering = getAddress(offeringAddress);
  const state = await getOfferingState({ offeringAddress });
  const curve = offeringStateCurve(state);
  const cap = BigInt(voucher.amountCapUsdc);
  const units = unitsForBudget(
    curve,
    state.unitsSold,
    availablePrivateUnits(state),
    cap,
  );
  if (units <= 0)
    throw new Error(
      "The allocation is too small to buy one whole unit at the current curve price.",
    );
  const cost = costForUnits(curve, state.unitsSold, units);
  // Claims are one-shot, so a drifted quote must be re-confirmed, not
  // silently absorbed.
  if (expected && (units !== expected.units || cost !== expected.cost))
    throw new QuoteChangedError(units, cost);
  // The voucher cap bounds slippage: price drift between invite and claim is
  // accepted, but never beyond the dollars the owner endorsed.
  const costWithSlippage = withSlippage(cost);
  const maxCost = costWithSlippage < cap ? costWithSlippage : cap;

  const claimSig = await signClaim({
    linkPrivateKey,
    offering,
    chainId: BASE_CHAIN_ID,
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
        maxCost,
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
