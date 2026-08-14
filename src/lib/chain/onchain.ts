// All contract interaction for the browser. Reads always go through the
// public Base RPC so they work without a wallet and never depend on which
// chain the wallet is pointed at; the wallet provider is only asked to
// switch chains, sign transactions, and sign allocation vouchers.
//
// Amounts are plain numbers in USDC base units. That is safe well past any
// raise size this prototype targets (Number stays exact below ~$9B).
import {
  BASE_CHAIN_ID,
  BASE_CHAIN_ID_HEX,
  BASE_CHAIN_PARAMS,
  BASE_RPC_URL,
  BASE_USDC_ADDRESS,
  toUsdcBaseUnits,
} from './chain.ts';
import { buildOfferingFactoryInputs } from './liquid-split.ts';
import { deriveOfferingCurve, costForUnits, unitsForBudget } from './curve.ts';
import type { CurveParams, Pact } from './curve.ts';
import { voucherTypedData, signClaim } from './voucher.ts';
import type { Voucher } from './voucher.ts';
import {
  OFFERING_FACTORY_ADDRESS,
  OFFERING_FACTORY_ABI,
  OFFERING_ABI,
  PACT_TOKEN_ABI,
} from '../../generated/offering-contracts.ts';

import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, numberToHex } from 'viem';
import type { Abi, Address, Hex } from 'viem';

// The slice of EIP-1193 the app uses. Deliberately looser than viem's typed
// provider: wallet RPCs are called with hand-built params objects.
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<any>;
  on?(event: string, handler: (...args: any[]) => void): void;
}

// A raw eth_getLogs entry (quantities still hex-encoded).
export interface RawLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber?: string | null;
  transactionHash?: string | null;
  logIndex?: string | null;
}

export type GetLogsFn = (args: {
  address?: string;
  topics?: (Hex | Hex[] | null)[] | readonly Hex[];
  fromBlock: number;
  toBlock: number;
}) => Promise<RawLog[]>;

interface RawReceipt {
  status?: string | number;
  logs?: RawLog[];
  blockNumber: string;
  transactionHash?: Hex;
}

// One read in a readMany batch. The ABI is deliberately widened to `Abi` so
// batches can mix contracts and pick functions dynamically.
export interface ContractCall {
  address: string;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

interface TxWaitOptions {
  rpcUrl?: string;
  timeoutMs?: number;
  pollMs?: number;
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

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
        name: 'calls',
        type: 'tuple[]',
      },
    ],
    name: 'aggregate3',
    outputs: [
      {
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
        name: 'returnData',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;
const ERC20_ABI = [
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function normalizeChainId(chainId: unknown): number {
  if (typeof chainId === 'number') return chainId;
  if (typeof chainId === 'string' && chainId.startsWith('0x')) return parseInt(chainId, 16);
  return Number(chainId);
}

async function ensureBase(provider: Eip1193Provider): Promise<void> {
  const current = await provider.request({ method: 'eth_chainId' });
  if (normalizeChainId(current) === BASE_CHAIN_ID) return;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BASE_CHAIN_ID_HEX }],
    });
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: number }).code === 4902) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [BASE_CHAIN_PARAMS],
      });
      // Some wallets add a chain without selecting it, so switch again explicitly.
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: BASE_CHAIN_ID_HEX }],
      });
      return;
    }
    throw err;
  }
}

async function rpcCall(method: string, params: unknown[], rpcUrl: string = BASE_RPC_URL): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'Base RPC request failed.');
  return body.result;
}

export async function getLatestBlockNumber(rpcUrl?: string): Promise<number> {
  return parseInt(await rpcCall('eth_blockNumber', [], rpcUrl), 16);
}

// eth_getLogs over a numeric block range. Callers chunk ranges themselves —
// public Base RPC caps a request at 10k blocks (see offerings.ts).
export async function getLogs(
  { address, topics, fromBlock, toBlock }: Parameters<GetLogsFn>[0],
  rpcUrl?: string,
): Promise<RawLog[]> {
  return rpcCall('eth_getLogs', [{
    ...(address ? { address: getAddress(address) } : {}),
    topics,
    fromBlock: numberToHex(fromBlock),
    toBlock: numberToHex(toBlock),
  }], rpcUrl);
}

// The wallet usually learns about its own transaction first, but some wallets
// serve read requests unreliably (or against the wrong chain), so every poll
// also asks the public RPC. The transaction hash is public either way.
async function waitForReceipt(txHash: Hex, options: TxWaitOptions & { provider?: Eip1193Provider } = {}): Promise<RawReceipt> {
  const timeoutMs = options.timeoutMs || 120000;
  const pollMs = options.pollMs || 1500;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const receipt = (options.provider
      ? await options.provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] }).catch(() => null)
      : null)
      || await rpcCall('eth_getTransactionReceipt', [txHash], options.rpcUrl).catch(() => null);
    if (receipt) return receipt;
    await sleep(pollMs);
  }

  throw new Error('Timed out waiting for the transaction receipt.');
}

function assertNotReverted(receipt: RawReceipt, message: string): void {
  if (receipt.status && normalizeChainId(receipt.status) === 0) throw new Error(message);
}

export async function readContract({ address, abi, functionName, args = [], rpcUrl }: ContractCall & { rpcUrl?: string }): Promise<unknown> {
  const data = encodeFunctionData({ abi, functionName, args });
  const result = await rpcCall('eth_call', [{ to: getAddress(address), data }, 'latest'], rpcUrl);
  return decodeFunctionResult({ abi, functionName, data: result });
}

async function readContractsMulticall(calls: ContractCall[], rpcUrl?: string): Promise<unknown[]> {
  const encodedCalls = calls.map(call => ({
    target: getAddress(call.address),
    allowFailure: false,
    callData: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args || [] }),
  }));
  const data = encodeFunctionData({ abi: MULTICALL3_ABI, functionName: 'aggregate3', args: [encodedCalls] });
  const result = await rpcCall('eth_call', [{ to: MULTICALL3_ADDRESS, data }, 'latest'], rpcUrl);
  const decoded = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', data: result });
  if (decoded.length !== calls.length) throw new Error('Multicall read failed.');
  return decoded.map((item, index) => {
    if (!item.success) throw new Error('Multicall read failed.');
    const call = calls[index];
    return decodeFunctionResult({ abi: call.abi, functionName: call.functionName, data: item.returnData });
  });
}

// Batched reads with a per-call fallback for RPCs without Multicall3.
export async function readMany(calls: ContractCall[], rpcUrl?: string): Promise<unknown[]> {
  try {
    return await readContractsMulticall(calls, rpcUrl);
  } catch (err) {
    const values = [];
    for (const call of calls) values.push(await readContract({ ...call, rpcUrl }));
    return values;
  }
}

const eventTopics = (log: RawLog) => log.topics as [Hex, ...Hex[]];

// Decodes an OfferingCreated log into the offering record shape cached by the
// listing scan (offerings.ts) and seeded by the create flow.
export function decodeOfferingCreatedLog(log: RawLog): OfferingRecord | null {
  const event = decodeEventLog({ abi: OFFERING_FACTORY_ABI, data: log.data, topics: eventTopics(log) });
  if (event.eventName !== 'OfferingCreated' || !event.args) return null;
  return {
    offering: getAddress(event.args.offering),
    pactToken: getAddress(event.args.pactToken),
    issuer: getAddress(event.args.issuer),
    treasury: getAddress(event.args.treasury),
    projectName: event.args.projectName,
    raiseMin: Number(event.args.raiseMin),
    closeDate: Number(event.args.closeDate),
    priceStart: Number(event.args.priceStart),
    priceSlope: Number(event.args.priceSlope),
    publicUnits: Number(event.args.publicUnits),
    blockNumber: log.blockNumber != null ? parseInt(log.blockNumber, 16) : null,
    txHash: log.transactionHash || null,
  };
}

function decodeOfferingCreated(receipt: RawReceipt, factoryAddress: string): OfferingRecord {
  const normalizedFactory = getAddress(factoryAddress).toLowerCase();
  for (const log of (receipt && receipt.logs) || []) {
    if (String(log.address || '').toLowerCase() !== normalizedFactory) continue;
    try {
      const record = decodeOfferingCreatedLog(log);
      if (record) return record;
    } catch (err) {}
  }
  throw new Error('Offering creation event was not found in the transaction receipt.');
}

// Decodes a Bought log into the purchase shape used across the app.
export function decodeBoughtLog(log: RawLog): Purchase | null {
  const event = decodeEventLog({ abi: OFFERING_ABI, data: log.data, topics: eventTopics(log) });
  if (event.eventName !== 'Bought' || !event.args) return null;
  return {
    offering: getAddress(log.address),
    buyer: getAddress(event.args.buyer),
    allocationId: event.args.allocationId,
    units: Number(event.args.units),
    cost: Number(event.args.cost),
    buyerName: event.args.buyerName || '',
    blockNumber: log.blockNumber != null ? parseInt(log.blockNumber, 16) : null,
    txHash: log.transactionHash || null,
    logIndex: log.logIndex != null ? parseInt(log.logIndex, 16) : 0,
  };
}

export async function createOffering({ provider, pact, owner, factoryAddress, rpcUrl, timeoutMs, pollMs }: {
  provider: Eip1193Provider;
  pact: Pact;
  owner: string;
  factoryAddress?: string;
} & TxWaitOptions) {
  const factory = factoryAddress
    || (typeof globalThis !== 'undefined' && (globalThis as Record<string, any>).PACT_OFFERING_FACTORY_ADDRESS)
    || OFFERING_FACTORY_ADDRESS;
  if (!provider) throw new Error('Wallet provider is required.');
  if (!owner) throw new Error('Connected wallet is required.');
  if (!factory) throw new Error('Offering factory has not been deployed yet.');
  const curve = deriveOfferingCurve(pact);
  if (!curve) throw new Error('Valid valuation band and offering units are required.');

  await ensureBase(provider);
  const normalizedOwner = getAddress(owner);
  const treasury = getAddress(pact.proceedsAddress);
  const closeDate = Math.floor(Date.now() / 1000) + Number(pact.minimum.deadlineDays) * 86400;
  const inputs = buildOfferingFactoryInputs(pact, { getAddress });
  const publicUnits = Math.min(Number(pact.publicUnits) || 0, inputs.offeringUnits);
  const data = encodeFunctionData({
    abi: OFFERING_FACTORY_ABI,
    functionName: 'createOffering',
    args: [
      pact.projectName,
      BigInt(toUsdcBaseUnits(pact.raise.min)),
      BigInt(closeDate),
      BigInt(curve.priceStart),
      BigInt(curve.priceSlope),
      BigInt(publicUnits),
      treasury,
      inputs.holderAccounts as Address[],
      inputs.holderAllocations,
      inputs.offeringUnits,
    ],
  });

  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from: normalizedOwner,
      to: getAddress(factory),
      data,
      chainId: BASE_CHAIN_ID_HEX,
    }],
  });
  const receipt = await waitForReceipt(txHash, { provider, rpcUrl, timeoutMs, pollMs });
  assertNotReverted(receipt, 'Offering creation transaction reverted.');
  const created = decodeOfferingCreated(receipt, factory);
  return {
    chainId: BASE_CHAIN_ID,
    factoryAddress: getAddress(factory),
    transactionHash: txHash as Hex,
    curve,
    ...created,
    blockNumber: created.blockNumber != null
      ? created.blockNumber
      : parseInt(receipt.blockNumber, 16),
  };
}

export async function getOfferingState({ offeringAddress, buyer, rpcUrl }: {
  offeringAddress: string;
  buyer?: string | null;
  rpcUrl?: string;
}): Promise<OfferingState> {
  const offering = getAddress(offeringAddress);
  const normalizedBuyer = buyer ? getAddress(buyer) : null;
  const fields = [
    'remainingUnits', 'unitsSold', 'minMet', 'state', 'raised', 'withdrawn', 'raiseMin',
    'closeDate', 'owner', 'treasury', 'pactToken', 'priceStart', 'priceSlope',
    'publicUnits', 'publicUnitsSold',
  ];
  const calls: ContractCall[] = fields.map(functionName => ({ address: offering, abi: OFFERING_ABI, functionName }));
  if (normalizedBuyer) calls.push({ address: offering, abi: OFFERING_ABI, functionName: 'deposits', args: [normalizedBuyer] });
  const values = await readMany(calls, rpcUrl);
  const [
    remainingUnits, unitsSold, minMet, state, raised, withdrawn, raiseMin, closeDate, owner, treasury,
    pactToken, priceStart, priceSlope, publicUnits, publicUnitsSold, deposit,
  ] = values;
  const result: OfferingState = {
    offeringAddress: offering,
    remainingUnits: Number(remainingUnits),
    unitsSold: Number(unitsSold),
    minMet: minMet as boolean,
    state: Number(state),
    raised: Number(raised),
    withdrawn: Number(withdrawn),
    raiseMin: Number(raiseMin),
    closeDate: Number(closeDate),
    owner: getAddress(owner as string),
    treasury: getAddress(treasury as string),
    pactToken: getAddress(pactToken as string),
    priceStart: Number(priceStart),
    priceSlope: Number(priceSlope),
    publicUnits: Number(publicUnits),
    publicUnitsSold: Number(publicUnitsSold),
  };
  if (normalizedBuyer) result.deposit = Number(deposit);
  return result;
}

export async function getProjectName({ pactToken, rpcUrl }: { pactToken: string; rpcUrl?: string }): Promise<string> {
  return await readContract({ address: getAddress(pactToken), abi: PACT_TOKEN_ABI, functionName: 'projectName', rpcUrl }) as string;
}

export async function isAllocationConsumed({ offeringAddress, allocationId, rpcUrl }: {
  offeringAddress: string;
  allocationId: Hex;
  rpcUrl?: string;
}): Promise<boolean> {
  return await readContract({
    address: getAddress(offeringAddress),
    abi: OFFERING_ABI,
    functionName: 'allocationConsumed',
    args: [allocationId],
    rpcUrl,
  }) as boolean;
}

// Signs an allocation voucher with the offering owner's wallet. Returns the
// hex signature; the caller assembles the share link.
export async function signVoucher({ provider, owner, offeringAddress, voucher }: {
  provider: Eip1193Provider;
  owner: string;
  offeringAddress: string;
  voucher: Voucher;
}): Promise<Hex> {
  if (!provider) throw new Error('Wallet provider is required.');
  await ensureBase(provider);
  const typedData = voucherTypedData({
    offering: getAddress(offeringAddress),
    chainId: BASE_CHAIN_ID,
    voucher,
  });
  return provider.request({
    method: 'eth_signTypedData_v4',
    params: [getAddress(owner), JSON.stringify(typedData, (key, value) => typeof value === 'bigint' ? value.toString() : value)],
  });
}

// Options shared by every state-changing offering call.
export interface OfferingTxOptions extends TxWaitOptions {
  provider: Eip1193Provider;
  from: string;
  offeringAddress: string;
}

async function sendOfferingFunction({ provider, from, offeringAddress, functionName, args = [], rpcUrl, timeoutMs, pollMs }: OfferingTxOptions & {
  functionName: string;
  args?: readonly unknown[];
}) {
  if (!provider) throw new Error('Wallet provider is required.');
  if (!from) throw new Error('Connected wallet is required.');
  const offering = getAddress(offeringAddress);
  await ensureBase(provider);
  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from: getAddress(from),
      to: offering,
      data: encodeFunctionData({ abi: OFFERING_ABI as Abi, functionName, args }),
      chainId: BASE_CHAIN_ID_HEX,
    }],
  });
  const receipt = await waitForReceipt(txHash, { provider, rpcUrl, timeoutMs, pollMs });
  assertNotReverted(receipt, 'Offering transaction reverted.');
  return { txHash: txHash as Hex, receipt };
}

export function withdrawOffering(options: OfferingTxOptions) {
  return sendOfferingFunction({ ...options, functionName: 'withdraw' });
}

export function closeAndWithdrawOffering(options: OfferingTxOptions) {
  return sendOfferingFunction({ ...options, functionName: 'closeAndWithdraw' });
}

export function markOfferingFailed(options: OfferingTxOptions) {
  return sendOfferingFunction({ ...options, functionName: 'markFailed' });
}

export function refundOffering(options: OfferingTxOptions) {
  return sendOfferingFunction({ ...options, functionName: 'refund' });
}

export function refundAllOffering(options: OfferingTxOptions & { buyers?: string[] }) {
  const buyers = (options.buyers || []).map(a => getAddress(a));
  return sendOfferingFunction({ ...options, functionName: 'refundAll', args: [buyers] });
}

export function sweepFailedUnits(options: OfferingTxOptions) {
  return sendOfferingFunction({ ...options, functionName: 'sweepFailedUnits' });
}

export function setPublicUnits(options: OfferingTxOptions & { publicUnits: number }) {
  return sendOfferingFunction({
    ...options,
    functionName: 'setPublicUnits',
    args: [BigInt(options.publicUnits)],
  });
}

export function cancelAllocation(options: OfferingTxOptions & { allocationId: string }) {
  return sendOfferingFunction({
    ...options,
    functionName: 'cancelAllocation',
    args: [options.allocationId],
  });
}

// EIP-5792: does this wallet execute batched calls atomically on Base?
// Unsupported/unknown methods just mean "no" — the two-transaction flow works everywhere.
export async function atomicBatchSupported(provider: Eip1193Provider, account: Address): Promise<boolean> {
  try {
    const capabilities = await provider.request({ method: 'wallet_getCapabilities', params: [account, [BASE_CHAIN_ID_HEX]] });
    const status = capabilities && capabilities[BASE_CHAIN_ID_HEX] && capabilities[BASE_CHAIN_ID_HEX].atomic
      && capabilities[BASE_CHAIN_ID_HEX].atomic.status;
    return status === 'supported' || status === 'ready';
  } catch (err) {
    return false;
  }
}

// EIP-5792 wallet_sendCalls + wallet_getCallsStatus poll. Returns the final
// receipt (the batch lands as one transaction when atomic).
export async function sendBatchedCalls({ provider, from, calls, timeoutMs, pollMs }: TxWaitOptions & {
  provider: Eip1193Provider;
  from: Address;
  calls: Array<{ to: Address; data: Hex }>;
}): Promise<RawReceipt> {
  const sent = await provider.request({
    method: 'wallet_sendCalls',
    params: [{ version: '2.0.0', chainId: BASE_CHAIN_ID_HEX, from, atomicRequired: true, calls }],
  });
  const batchId = typeof sent === 'string' ? sent : sent && sent.id;
  if (!batchId) throw new Error('Wallet did not return a batch id.');

  const deadline = Date.now() + (timeoutMs || 120000);
  while (Date.now() < deadline) {
    const result = await provider.request({ method: 'wallet_getCallsStatus', params: [batchId] }).catch(() => null);
    const status = result && Number(result.status);
    if (status >= 400) throw new Error('Batched transaction failed in the wallet.');
    const receipt = result && result.receipts && result.receipts[result.receipts.length - 1];
    if (status === 200 && receipt) return receipt;
    await sleep(pollMs || 1500);
  }
  throw new Error('Timed out waiting for the batched transaction.');
}

const usdcAllowance = async (buyer: Address, offering: Address, rpcUrl?: string) => await readContract({
  address: BASE_USDC_ADDRESS,
  abi: ERC20_ABI as Abi,
  functionName: 'allowance',
  args: [buyer, offering],
  rpcUrl,
}) as bigint;

const approveCall = (offering: Address, amount: number) => ({
  to: BASE_USDC_ADDRESS as Address,
  data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [offering, BigInt(amount)] }),
});

// Approve (when needed) and buy. One wallet prompt via an EIP-5792 atomic
// batch when the wallet supports it, else the sequential two-transaction flow.
async function payWithApproval({ provider, buyer, offering, amount, buyData, rpcUrl, timeoutMs, pollMs }: TxWaitOptions & {
  provider: Eip1193Provider;
  buyer: Address;
  offering: Address;
  amount: number;
  buyData: Hex;
}): Promise<{ approveTxHash: Hex | null; buyTxHash: Hex; buyReceipt: RawReceipt }> {
  const buyCall = { to: offering, data: buyData };
  const needsApproval = await usdcAllowance(buyer, offering, rpcUrl) < BigInt(amount);

  if (needsApproval && await atomicBatchSupported(provider, buyer)) {
    const buyReceipt = await sendBatchedCalls({
      provider, from: buyer, calls: [approveCall(offering, amount), buyCall], timeoutMs, pollMs,
    });
    return { approveTxHash: null, buyTxHash: buyReceipt.transactionHash as Hex, buyReceipt };
  }

  let approveTxHash: Hex | null = null;
  if (needsApproval) {
    approveTxHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: buyer, ...approveCall(offering, amount), chainId: BASE_CHAIN_ID_HEX }],
    });
    const approveReceipt = await waitForReceipt(approveTxHash!, { provider, rpcUrl, timeoutMs, pollMs });
    assertNotReverted(approveReceipt, 'USDC approval reverted.');
  }
  const buyTxHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: buyer, ...buyCall, chainId: BASE_CHAIN_ID_HEX }],
  });
  const buyReceipt = await waitForReceipt(buyTxHash, { provider, rpcUrl, timeoutMs, pollMs });
  return { approveTxHash, buyTxHash, buyReceipt };
}

function purchaseFromReceipt(receipt: RawReceipt, offering: string, buyer: string): Purchase | null {
  for (const log of receipt.logs || []) {
    if (String(log.address || '').toLowerCase() !== offering.toLowerCase()) continue;
    try {
      const purchase = decodeBoughtLog(log);
      if (purchase && purchase.buyer.toLowerCase() === buyer.toLowerCase()) return purchase;
    } catch (err) {}
  }
  return null;
}

// Quote for a dollar budget against live curve position and available supply.
export async function quoteOfferingPurchase({ offeringAddress, amountUsd, publicOnly = true, rpcUrl }: {
  offeringAddress: string;
  amountUsd: number;
  publicOnly?: boolean;
  rpcUrl?: string;
}) {
  const state = await getOfferingState({ offeringAddress, rpcUrl });
  const curve: CurveParams = { priceStart: state.priceStart, priceSlope: state.priceSlope };
  const available = publicOnly
    ? Math.min(state.remainingUnits, Math.max(0, state.publicUnits - state.publicUnitsSold))
    : state.remainingUnits;
  const budget = toUsdcBaseUnits(Number(amountUsd));
  const units = unitsForBudget(curve, state.unitsSold, available, budget);
  if (units <= 0) throw new Error('Amount is too small to buy one whole unit at the current curve price.');
  const cost = costForUnits(curve, state.unitsSold, units);
  const maxCost = Math.ceil(cost * 1.01);
  return { state, units, cost, maxCost };
}

export async function buyPublicOffering({ provider, buyer, offeringAddress, amountUsd, buyerName = '', rpcUrl, timeoutMs, pollMs }: TxWaitOptions & {
  provider: Eip1193Provider;
  buyer: string;
  offeringAddress: string;
  amountUsd: number;
  buyerName?: string;
}) {
  if (!provider) throw new Error('Wallet provider is required.');
  if (!buyer) throw new Error('Connected wallet is required.');

  await ensureBase(provider);
  const normalizedBuyer = getAddress(buyer);
  const offering = getAddress(offeringAddress);
  const quote = await quoteOfferingPurchase({ offeringAddress, amountUsd, publicOnly: true, rpcUrl });
  const { approveTxHash, buyTxHash, buyReceipt } = await payWithApproval({
    provider, buyer: normalizedBuyer, offering, amount: quote.maxCost, rpcUrl, timeoutMs, pollMs,
    buyData: encodeFunctionData({
      abi: OFFERING_ABI,
      functionName: 'buyPublic',
      args: [BigInt(quote.units), BigInt(quote.maxCost), buyerName],
    }),
  });
  assertNotReverted(buyReceipt, 'Offering purchase reverted.');
  const purchase = purchaseFromReceipt(buyReceipt, offering, normalizedBuyer);
  return { ...quote, ...(purchase || {}), approveTxHash, buyTxHash };
}

// Claims a private allocation: the buyer's wallet sends buyPrivate carrying
// the owner-signed voucher and a fresh link-key signature over the buyer.
export async function buyPrivateOffering({ provider, buyer, offeringAddress, voucher, ownerSig, linkPrivateKey, rpcUrl, timeoutMs, pollMs }: TxWaitOptions & {
  provider: Eip1193Provider;
  buyer: string;
  offeringAddress: string;
  voucher: Voucher;
  ownerSig: Hex;
  linkPrivateKey: Hex;
}) {
  if (!provider) throw new Error('Wallet provider is required.');
  if (!buyer) throw new Error('Connected wallet is required.');

  await ensureBase(provider);
  const normalizedBuyer = getAddress(buyer);
  const offering = getAddress(offeringAddress);
  const state = await getOfferingState({ offeringAddress, rpcUrl });
  const curve: CurveParams = { priceStart: state.priceStart, priceSlope: state.priceSlope };
  const cap = Number(voucher.amountCapUsdc);
  const units = unitsForBudget(curve, state.unitsSold, state.remainingUnits, cap);
  if (units <= 0) throw new Error('The allocation is too small to buy one whole unit at the current curve price.');
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
    provider, buyer: normalizedBuyer, offering, amount: maxCost, rpcUrl, timeoutMs, pollMs,
    buyData: encodeFunctionData({
      abi: OFFERING_ABI,
      functionName: 'buyPrivate',
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
    }),
  });
  assertNotReverted(buyReceipt, 'Allocation claim reverted.');
  const purchase = purchaseFromReceipt(buyReceipt, offering, normalizedBuyer);
  return { state, units, cost, maxCost, ...(purchase || {}), approveTxHash, buyTxHash };
}
