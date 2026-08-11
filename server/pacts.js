// Domain operations over PACT records. Every function returns
// { status, body } so the HTTP layer and tests share one code path.
import { isAddress, isTxHash } from '../src/lib/validate.js';
import { canAccessPact } from '../src/lib/access.js';
import { BASE_CHAIN_ID } from '../src/lib/chain.js';
import { makeId, readPact, readAllPacts, writePact } from './db.js';
import { parseAmount, parsePositiveInteger, parseNonnegativeInteger } from './parse.js';

function validatePact(input) {
  const errors = [];
  if (!input || typeof input !== 'object') errors.push('PACT payload is required.');
  if (errors.length) return errors;
  if (!String(input.projectName || '').trim()) errors.push('Project name is required.');
  if (!(parseAmount(input.raise && input.raise.min) > 0)) errors.push('Minimum raise must be greater than 0.');
  if (!(parseAmount(input.raise && input.raise.max) > 0)) errors.push('Maximum raise must be greater than 0.');
  if (parseAmount(input.raise && input.raise.min) > parseAmount(input.raise && input.raise.max)) errors.push('Minimum cannot exceed maximum.');
  if (!(parseAmount(input.maxDilutionPct) > 0 && parseAmount(input.maxDilutionPct) < 100)) errors.push('Max dilution must be between 0 and 100.');
  if (!(parseAmount(input.totalTokens) > 0)) errors.push('Total tokens must be greater than 0.');
  if (!(parseAmount(input.minimum && input.minimum.deadlineDays) >= 1)) errors.push('Deadline must be at least 1 day.');
  if (!isAddress(input.issuerWallet)) errors.push('Issuer wallet is required.');
  return errors;
}

export function createPact(db, input) {
  const errors = validatePact(input);
  if (errors.length) return { status: 400, body: { error: errors[0], errors } };

  const now = Date.now();
  const pact = {
    ...input,
    id: makeId('r'),
    createdAt: now,
    updatedAt: now,
    allocations: [],
  };
  writePact(db, pact);
  return { status: 201, body: pact };
}

export function getPact(db, id) {
  const pact = readPact(db, id);
  if (!pact) return { status: 404, body: { error: 'PACT not found.' } };
  return { status: 200, body: pact };
}

function summarizePact(pact) {
  const fundedTotal = (pact.allocations || [])
    .filter(a => a.status === 'funded')
    .reduce((sum, a) => sum + parseAmount(a.amountUsd), 0);
  return {
    id: pact.id,
    projectName: pact.projectName,
    createdAt: pact.createdAt,
    raise: pact.raise,
    fundedTotal,
  };
}

function summarizePurchase(pact, allocation) {
  return {
    pactId: pact.id,
    allocationId: allocation.id,
    projectName: pact.projectName,
    amountUsd: allocation.amountUsd,
    fundedAt: allocation.fundedAt,
    txHash: allocation.txHash,
    tokensPurchased: allocation.tokensPurchased,
    purchaseCostUsdcBaseUnits: allocation.purchaseCostUsdcBaseUnits,
  };
}

export function listPacts(db, input = {}) {
  const wallet = String(typeof input === 'string' ? input : input.wallet || '').toLowerCase();
  if (!isAddress(wallet)) return { status: 400, body: { error: 'Wallet is required.' } };
  const pacts = readAllPacts(db)
    .filter(pact => canAccessPact(pact, wallet))
    .map(summarizePact);
  return { status: 200, body: { pacts } };
}

export function listPurchases(db, input = {}) {
  const wallet = String(typeof input === 'string' ? input : input.wallet || '').toLowerCase();
  if (!isAddress(wallet)) return { status: 400, body: { error: 'Wallet is required.' } };
  const purchases = readAllPacts(db)
    .flatMap(pact => (pact.allocations || [])
      .filter(allocation => allocation.status === 'funded' && String(allocation.buyerWallet || '').toLowerCase() === wallet)
      .map(allocation => summarizePurchase(pact, allocation)))
    .sort((a, b) => (b.fundedAt || 0) - (a.fundedAt || 0));
  return { status: 200, body: { purchases } };
}

export function addAllocation(db, pactId, input) {
  const pact = readPact(db, pactId);
  if (!pact) return { status: 404, body: { error: 'PACT not found.' } };

  const name = String(input && input.name || '').trim();
  const amountUsd = parseAmount(input && input.amountUsd);
  if (!name) return { status: 400, body: { error: 'Buyer name is required.' } };
  if (!(amountUsd > 0)) return { status: 400, body: { error: 'Allocation amount must be greater than 0.' } };

  const allocation = {
    id: makeId('a'),
    name,
    amountUsd,
    status: 'allocated',
    createdAt: Date.now(),
  };
  pact.allocations = Array.isArray(pact.allocations) ? pact.allocations : [];
  pact.allocations.push(allocation);
  writePact(db, pact);
  return { status: 201, body: { pact, allocation } };
}

export function deleteAllocation(db, pactId, allocationId) {
  const pact = readPact(db, pactId);
  if (!pact) return { status: 404, body: { error: 'PACT not found.' } };
  const allocation = (pact.allocations || []).find(a => a.id === allocationId);
  if (!allocation) return { status: 404, body: { error: 'Allocation not found.' } };
  // A funded allocation records a settled onchain purchase, so it is immutable.
  if (allocation.status === 'funded') return { status: 409, body: { error: 'Funded allocations cannot be deleted.' } };
  pact.allocations = pact.allocations.filter(a => a.id !== allocationId);
  writePact(db, pact);
  return { status: 200, body: { pact } };
}

// Records a settled onchain purchase against an allocation. Funding is terminal:
// the contract is the source of truth for the purchase, and funded allocations
// are never reverted or deleted.
export function fundAllocation(db, pactId, allocationId, input = {}) {
  const pact = readPact(db, pactId);
  if (!pact) return { status: 404, body: { error: 'PACT not found.' } };
  if (!isAddress(input.buyerWallet)) return { status: 400, body: { error: 'Buyer wallet is required.' } };
  const allocation = (pact.allocations || []).find(a => a.id === allocationId);
  if (!allocation) return { status: 404, body: { error: 'Allocation not found.' } };
  allocation.status = 'funded';
  allocation.fundedAt = Date.now();
  allocation.buyerWallet = input.buyerWallet;
  if (isTxHash(input.txHash)) allocation.txHash = input.txHash;
  else delete allocation.txHash;
  const tokensPurchased = parsePositiveInteger(input.tokensPurchased);
  const purchaseCostUsdcBaseUnits = parsePositiveInteger(input.purchaseCostUsdcBaseUnits);
  if (tokensPurchased) allocation.tokensPurchased = tokensPurchased;
  else delete allocation.tokensPurchased;
  if (purchaseCostUsdcBaseUnits) allocation.purchaseCostUsdcBaseUnits = purchaseCostUsdcBaseUnits;
  else delete allocation.purchaseCostUsdcBaseUnits;
  writePact(db, pact);
  return { status: 200, body: { pact, allocation } };
}

// Caches the latest offering snapshot (the getOfferingState shape) so the
// status page can render before a fresh contract read completes.
export function syncOfferingState(db, pactId, input = {}) {
  const pact = readPact(db, pactId);
  if (!pact) return { status: 404, body: { error: 'PACT not found.' } };
  if (!isAddress(pact.offeringAddress)) return { status: 409, body: { error: 'PACT has no offering contract.' } };

  const required = {
    remainingUnits: parseNonnegativeInteger(input.remainingUnits),
    unitsSold: parseNonnegativeInteger(input.unitsSold),
    raised: parseNonnegativeInteger(input.raised),
    withdrawn: parseNonnegativeInteger(input.withdrawn),
    state: parseNonnegativeInteger(input.state),
  };
  if (Object.values(required).some(value => value == null) || required.state > 2) {
    return { status: 400, body: { error: 'Valid offering state is required.' } };
  }

  const optional = name => {
    const value = parseNonnegativeInteger(input[name]);
    return value == null ? undefined : value;
  };
  pact.onchainOffering = {
    syncedAt: Date.now(),
    offeringAddress: pact.offeringAddress,
    ...required,
    minMet: !!input.minMet,
    raiseMin: optional('raiseMin'),
    closeDate: optional('closeDate'),
    priceStart: optional('priceStart'),
    priceSlope: optional('priceSlope'),
    owner: isAddress(input.owner) ? input.owner : undefined,
    treasury: isAddress(input.treasury) ? input.treasury : undefined,
    liquidSplit: isAddress(input.liquidSplit) ? input.liquidSplit : undefined,
    paymentToken: isAddress(input.paymentToken) ? input.paymentToken : undefined,
  };
  writePact(db, pact);
  return { status: 200, body: { pact, onchainOffering: pact.onchainOffering } };
}

export function syncCapTableState(db, pactId, input = {}) {
  const pact = readPact(db, pactId);
  if (!pact) return { status: 404, body: { error: 'PACT not found.' } };
  if (!isAddress(pact.liquidSplitAddress)) return { status: 409, body: { error: 'PACT has no Liquid Split.' } };

  const holders = Array.isArray(input.holders) ? input.holders.map(holder => ({
    address: isAddress(holder && holder.address) ? holder.address : '',
    balance: parseAmount(holder && holder.balance),
  })).filter(holder => holder.address && holder.balance > 0) : [];
  if (!holders.length) return { status: 400, body: { error: 'Valid cap table holders are required.' } };

  pact.onchainCapTable = {
    syncedAt: Date.now(),
    liquidSplitAddress: pact.liquidSplitAddress,
    chainId: parseNonnegativeInteger(input.chainId) || pact.chainId || BASE_CHAIN_ID,
    source: String(input.source || 'onchain'),
    holders: holders.sort((a, b) => a.address.toLowerCase() > b.address.toLowerCase() ? 1 : -1),
  };
  writePact(db, pact);
  return { status: 200, body: { pact, onchainCapTable: pact.onchainCapTable } };
}
