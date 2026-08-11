// All contract interaction for the browser. Reads always go through the
// public Base RPC so they work without a wallet and never depend on which
// chain the wallet is pointed at; the wallet provider is only asked to
// switch chains and sign transactions.
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
} from './chain.js';
import { buildOfferingFactoryInputs } from './liquid-split.js';
import { deriveOfferingCurve, costForUnits, unitsForBudget } from './curve.js';
import {
  OFFERING_FACTORY_ADDRESS,
  OFFERING_FACTORY_ABI,
  OFFERING_ABI,
} from '../generated/offering-contracts.js';

import { decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData, getAddress, zeroAddress } from 'viem';

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
];
const LS1155_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'operator', type: 'address' },
      { indexed: true, internalType: 'address', name: 'from', type: 'address' },
      { indexed: true, internalType: 'address', name: 'to', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'id', type: 'uint256' },
      { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'TransferSingle',
    type: 'event',
  },
  {
    inputs: [
      { internalType: 'address', name: '', type: 'address' },
      { internalType: 'uint256', name: '', type: 'uint256' },
    ],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];
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
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeChainId(chainId) {
  if (typeof chainId === 'number') return chainId;
  if (typeof chainId === 'string' && chainId.startsWith('0x')) return parseInt(chainId, 16);
  return Number(chainId);
}

async function ensureBase(provider) {
  const current = await provider.request({ method: 'eth_chainId' });
  if (normalizeChainId(current) === BASE_CHAIN_ID) return;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BASE_CHAIN_ID_HEX }],
    });
  } catch (err) {
    if (err && err.code === 4902) {
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

async function rpcCall(method, params, rpcUrl = BASE_RPC_URL) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'Base RPC request failed.');
  return body.result;
}

// The wallet usually learns about its own transaction first, but some wallets
// serve read requests unreliably (or against the wrong chain), so every poll
// also asks the public RPC. The transaction hash is public either way.
async function waitForReceipt(txHash, options = {}) {
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

function assertNotReverted(receipt, message) {
  if (receipt.status && normalizeChainId(receipt.status) === 0) throw new Error(message);
}

async function readContract({ address, abi, functionName, args = [], rpcUrl }) {
  const data = encodeFunctionData({ abi, functionName, args });
  const result = await rpcCall('eth_call', [{ to: getAddress(address), data }, 'latest'], rpcUrl);
  return decodeFunctionResult({ abi, functionName, data: result });
}

async function readContractsMulticall(calls, rpcUrl) {
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
async function readMany(calls, rpcUrl) {
  try {
    return await readContractsMulticall(calls, rpcUrl);
  } catch (err) {
    const values = [];
    for (const call of calls) values.push(await readContract({ ...call, rpcUrl }));
    return values;
  }
}

function decodeOfferingCreated(receipt, factoryAddress) {
  const normalizedFactory = getAddress(factoryAddress);
  for (const log of (receipt && receipt.logs) || []) {
    if (String(log.address || '').toLowerCase() !== normalizedFactory.toLowerCase()) continue;
    try {
      const event = decodeEventLog({
        abi: OFFERING_FACTORY_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (event.eventName === 'OfferingCreated' && event.args) {
        return {
          offeringAddress: getAddress(event.args.offering),
          liquidSplitAddress: getAddress(event.args.liquidSplit),
          paymentToken: getAddress(event.args.paymentToken),
          raiseMin: Number(event.args.raiseMin),
          closeDate: Number(event.args.closeDate),
          priceStart: Number(event.args.priceStart),
          priceSlope: Number(event.args.priceSlope),
        };
      }
    } catch (err) {}
  }
  throw new Error('Offering creation event was not found in the transaction receipt.');
}

async function getTransactionBlockNumber(txHash, rpcUrl) {
  if (!txHash) return null;
  const receipt = await rpcCall('eth_getTransactionReceipt', [txHash], rpcUrl);
  return receipt && receipt.blockNumber ? receipt.blockNumber : null;
}

export async function getLiquidSplitTokenBalance({ liquidSplitAddress, account, tokenId = 0, rpcUrl } = {}) {
  return readContract({
    address: getAddress(liquidSplitAddress),
    abi: LS1155_ABI,
    functionName: 'balanceOf',
    args: [getAddress(account), BigInt(tokenId)],
    rpcUrl,
  });
}

function decodeTransferSingleAmount(data) {
  const id = BigInt('0x' + data.slice(2, 66));
  const amount = BigInt('0x' + data.slice(66, 130));
  return { id, amount };
}

function topicAddress(topic) {
  return getAddress('0x' + topic.slice(-40));
}

// Every address that currently holds Liquid Split units, discovered from
// TransferSingle logs and confirmed with batched balance reads.
export async function getLiquidSplitHolders({ liquidSplitAddress, tokenId = 0, fromBlock, deploymentTxHash, rpcUrl } = {}) {
  const address = getAddress(liquidSplitAddress);
  const id = BigInt(tokenId);
  const startBlock = fromBlock
    || await getTransactionBlockNumber(deploymentTxHash, rpcUrl)
    || '0x0';
  const transferTopic = encodeEventTopics({
    abi: LS1155_ABI,
    eventName: 'TransferSingle',
  })[0];
  const logs = await rpcCall('eth_getLogs', [{
    address,
    fromBlock: startBlock,
    toBlock: 'latest',
    topics: [transferTopic],
  }], rpcUrl);
  const addresses = new Set();
  for (const log of logs || []) {
    if (!log.data || log.data.length < 130 || !log.topics || log.topics.length < 4) continue;
    const decoded = decodeTransferSingleAmount(log.data);
    if (decoded.id !== id || decoded.amount === 0n) continue;
    const from = topicAddress(log.topics[2]);
    const to = topicAddress(log.topics[3]);
    if (from.toLowerCase() !== zeroAddress.toLowerCase()) addresses.add(from);
    if (to.toLowerCase() !== zeroAddress.toLowerCase()) addresses.add(to);
  }
  const sorted = Array.from(addresses).sort((a, b) => a.toLowerCase() > b.toLowerCase() ? 1 : -1);
  const balances = await readMany(sorted.map(account => ({
    address,
    abi: LS1155_ABI,
    functionName: 'balanceOf',
    args: [account, id],
  })), rpcUrl);
  return sorted
    .map((account, index) => ({ address: account, balance: Number(balances[index]) }))
    .filter(holder => holder.balance > 0);
}

export async function getOfferingPurchaseFromTx({ txHash, offeringAddress, buyer, rpcUrl } = {}) {
  if (!txHash) throw new Error('Purchase transaction hash is required.');
  const receipt = await rpcCall('eth_getTransactionReceipt', [txHash], rpcUrl);
  if (!receipt) throw new Error('Purchase transaction receipt was not found.');
  return getOfferingPurchaseFromReceipt({ receipt, offeringAddress, buyer });
}

function getOfferingPurchaseFromReceipt({ receipt, offeringAddress, buyer }) {
  const offering = getAddress(offeringAddress);
  const normalizedBuyer = buyer ? getAddress(buyer) : null;
  for (const log of receipt.logs || []) {
    if (String(log.address || '').toLowerCase() !== offering.toLowerCase()) continue;
    try {
      const event = decodeEventLog({
        abi: OFFERING_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (event.eventName !== 'Bought' || !event.args) continue;
      if (normalizedBuyer && String(event.args.buyer || '').toLowerCase() !== normalizedBuyer.toLowerCase()) continue;
      return {
        buyer: getAddress(event.args.buyer),
        units: Number(event.args.units),
        cost: Number(event.args.cost),
      };
    } catch (err) {}
  }
  throw new Error('Purchase event was not found in the transaction receipt.');
}

// Most recent Bought event for a buyer. Used to recover a purchase that
// settled onchain but never made it into the local database.
export async function getOfferingPurchaseForBuyer({ offeringAddress, buyer, fromBlock, deploymentTxHash, rpcUrl } = {}) {
  const offering = getAddress(offeringAddress);
  const normalizedBuyer = getAddress(buyer);
  const startBlock = fromBlock
    || await getTransactionBlockNumber(deploymentTxHash, rpcUrl)
    || '0x0';
  const topics = encodeEventTopics({ abi: OFFERING_ABI, eventName: 'Bought', args: { buyer: normalizedBuyer } });
  const logs = await rpcCall('eth_getLogs', [{
    address: offering,
    fromBlock: startBlock,
    toBlock: 'latest',
    topics,
  }], rpcUrl);
  const log = (logs || [])[(logs || []).length - 1];
  if (!log) return null;
  const event = decodeEventLog({ abi: OFFERING_ABI, data: log.data, topics: log.topics });
  return {
    buyer: normalizedBuyer,
    units: Number(event.args.units),
    cost: Number(event.args.cost),
    txHash: log.transactionHash,
  };
}

export async function createOffering({ provider, pact, owner, factoryAddress, rpcUrl, timeoutMs, pollMs } = {}) {
  const factory = factoryAddress
    || (typeof globalThis !== 'undefined' && globalThis.PACT_OFFERING_FACTORY_ADDRESS)
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
  const data = encodeFunctionData({
    abi: OFFERING_FACTORY_ABI,
    functionName: 'createOffering',
    args: [
      BASE_USDC_ADDRESS,
      BigInt(toUsdcBaseUnits(pact.raise.min)),
      BigInt(closeDate),
      BigInt(curve.priceStart),
      BigInt(curve.priceSlope),
      treasury,
      inputs.holderAccounts,
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
    transactionHash: txHash,
    closeDate,
    curve,
    holderAccounts: inputs.holderAccounts,
    holderAllocations: inputs.holderAllocations,
    offeringUnits: inputs.offeringUnits,
    ...created,
  };
}

// Full offering snapshot in one batched read. This shape is the canonical
// "offering state" used across the app and cached by the server.
export async function getOfferingState({ offeringAddress, buyer, rpcUrl } = {}) {
  const offering = getAddress(offeringAddress);
  const normalizedBuyer = buyer ? getAddress(buyer) : null;
  const fields = [
    'remainingUnits', 'unitsSold', 'minMet', 'state', 'raised', 'withdrawn', 'raiseMin',
    'closeDate', 'owner', 'treasury', 'liquidSplit', 'paymentToken', 'priceStart', 'priceSlope',
  ];
  const calls = fields.map(functionName => ({ address: offering, abi: OFFERING_ABI, functionName }));
  if (normalizedBuyer) calls.push({ address: offering, abi: OFFERING_ABI, functionName: 'deposits', args: [normalizedBuyer] });
  const values = await readMany(calls, rpcUrl);
  const [
    remainingUnits, unitsSold, minMet, state, raised, withdrawn, raiseMin, closeDate, owner, treasury,
    liquidSplit, paymentToken, priceStart, priceSlope, deposit,
  ] = values;
  const result = {
    remainingUnits: Number(remainingUnits),
    unitsSold: Number(unitsSold),
    minMet,
    state: Number(state),
    raised: Number(raised),
    withdrawn: Number(withdrawn),
    raiseMin: Number(raiseMin),
    closeDate: Number(closeDate),
    owner: getAddress(owner),
    treasury: getAddress(treasury),
    liquidSplit: getAddress(liquidSplit),
    paymentToken: getAddress(paymentToken),
    priceStart: Number(priceStart),
    priceSlope: Number(priceSlope),
  };
  if (normalizedBuyer) result.deposit = Number(deposit);
  return result;
}

async function sendOfferingFunction({ provider, from, offeringAddress, functionName, args = [], rpcUrl, timeoutMs, pollMs } = {}) {
  if (!provider) throw new Error('Wallet provider is required.');
  if (!from) throw new Error('Connected wallet is required.');
  const offering = getAddress(offeringAddress);
  await ensureBase(provider);
  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from: getAddress(from),
      to: offering,
      data: encodeFunctionData({ abi: OFFERING_ABI, functionName, args }),
      chainId: BASE_CHAIN_ID_HEX,
    }],
  });
  const receipt = await waitForReceipt(txHash, { provider, rpcUrl, timeoutMs, pollMs });
  assertNotReverted(receipt, 'Offering transaction reverted.');
  return { txHash, receipt };
}

export function withdrawOffering(options) {
  return sendOfferingFunction({ ...(options || {}), functionName: 'withdraw' });
}

export function closeAndWithdrawOffering(options) {
  return sendOfferingFunction({ ...(options || {}), functionName: 'closeAndWithdraw' });
}

export function markOfferingFailed(options) {
  return sendOfferingFunction({ ...(options || {}), functionName: 'markFailed' });
}

export function refundOffering(options) {
  return sendOfferingFunction({ ...(options || {}), functionName: 'refund' });
}

export function refundAllOffering(options) {
  const buyers = ((options && options.buyers) || []).map(getAddress);
  return sendOfferingFunction({ ...(options || {}), functionName: 'refundAll', args: [buyers] });
}

export async function quoteOfferingPurchase({ pact, amountUsd, rpcUrl } = {}) {
  if (!pact || !pact.offeringAddress) throw new Error('Offering contract is not available.');
  const [remainingUnits, unitsSold] = (await readMany([
    { address: getAddress(pact.offeringAddress), abi: OFFERING_ABI, functionName: 'remainingUnits' },
    { address: getAddress(pact.offeringAddress), abi: OFFERING_ABI, functionName: 'unitsSold' },
  ], rpcUrl)).map(Number);
  const curve = pact.curveParams || deriveOfferingCurve(pact);
  const budget = toUsdcBaseUnits(Number(amountUsd));
  const units = unitsForBudget(curve, unitsSold, remainingUnits, budget);
  if (units <= 0) throw new Error('Allocation is too small to buy one whole Liquid Split unit at the current curve price.');
  const cost = costForUnits(curve, unitsSold, units);
  const maxCost = Math.ceil(cost * 1.01);
  return { remainingUnits, unitsSold, units, cost, maxCost };
}

export async function buyOffering({ provider, pact, buyer, amountUsd, rpcUrl, timeoutMs, pollMs } = {}) {
  if (!provider) throw new Error('Wallet provider is required.');
  if (!buyer) throw new Error('Connected wallet is required.');
  if (!pact || !pact.offeringAddress) throw new Error('Offering contract is not available.');

  await ensureBase(provider);
  const normalizedBuyer = getAddress(buyer);
  const offering = getAddress(pact.offeringAddress);
  const paymentToken = getAddress(pact.paymentToken || BASE_USDC_ADDRESS);
  const quote = await quoteOfferingPurchase({ pact, amountUsd, rpcUrl });
  const allowance = await readContract({
    address: paymentToken,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [normalizedBuyer, offering],
    rpcUrl,
  });

  let approveTxHash = null;
  if (allowance < BigInt(quote.maxCost)) {
    approveTxHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{
        from: normalizedBuyer,
        to: paymentToken,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [offering, BigInt(quote.maxCost)],
        }),
        chainId: BASE_CHAIN_ID_HEX,
      }],
    });
    const approveReceipt = await waitForReceipt(approveTxHash, { provider, rpcUrl, timeoutMs, pollMs });
    assertNotReverted(approveReceipt, 'USDC approval reverted.');
  }

  const buyTxHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from: normalizedBuyer,
      to: offering,
      data: encodeFunctionData({
        abi: OFFERING_ABI,
        functionName: 'buy',
        args: [BigInt(quote.units), BigInt(quote.maxCost)],
      }),
      chainId: BASE_CHAIN_ID_HEX,
    }],
  });
  const buyReceipt = await waitForReceipt(buyTxHash, { provider, rpcUrl, timeoutMs, pollMs });
  assertNotReverted(buyReceipt, 'Offering purchase reverted.');
  let purchase = null;
  try {
    purchase = getOfferingPurchaseFromReceipt({
      receipt: buyReceipt,
      offeringAddress: offering,
      buyer: normalizedBuyer,
    });
  } catch (err) {}
  return {
    ...quote,
    ...(purchase ? { units: purchase.units, cost: purchase.cost } : {}),
    approveTxHash,
    buyTxHash,
  };
}
