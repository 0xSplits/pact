// Builds the OfferingFactory holder inputs from a PACT's cap table.
// Framework-free so the node test runner can exercise it directly.
import { isAddress } from './validate.js';

// Splits' default Liquid Split is exactly 1,000 units, where each unit is 0.1%.
export const TOTAL_LIQUID_SPLIT_UNITS = 1000;

function checksumOrLower(address, getAddress) {
  const trimmed = String(address || '').trim();
  if (!isAddress(trimmed)) throw new Error('Invalid address: ' + trimmed);
  return getAddress ? getAddress(trimmed) : trimmed.toLowerCase();
}

// Returns { holderAccounts, holderAllocations, offeringUnits } for
// OfferingFactory.createOffering. The factory mints ERC-1155 balances
// directly, so duplicate holders are merged before the call.
export function buildOfferingFactoryInputs(pact, options = {}) {
  if (!pact || typeof pact !== 'object') throw new Error('PACT is required.');
  const getAddress = options.getAddress;

  const offeringUnits = Number(pact.newMoney && pact.newMoney.tokens);
  if (!Number.isInteger(offeringUnits) || offeringUnits <= 0) {
    throw new Error('Offering units must be a positive whole number.');
  }

  const merged = new Map();
  (pact.holders || []).forEach(holder => {
    const normalized = checksumOrLower(holder.address, getAddress);
    const units = Number(holder.tokens);
    if (!Number.isInteger(units) || units < 0) {
      throw new Error('Liquid Split allocations must be whole token units.');
    }
    if (units === 0) return;
    const key = normalized.toLowerCase();
    const existing = merged.get(key);
    merged.set(key, {
      address: existing ? existing.address : normalized,
      units: (existing ? existing.units : 0) + units,
    });
  });

  const rows = Array.from(merged.values()).sort((a, b) =>
    a.address.toLowerCase() > b.address.toLowerCase() ? 1 : -1
  );
  const total = rows.reduce((sum, row) => sum + row.units, 0) + offeringUnits;
  if (total !== TOTAL_LIQUID_SPLIT_UNITS) {
    throw new Error('Offering factory allocations must total 1,000 token units.');
  }
  if (!rows.length) {
    throw new Error('Liquid Split requires at least one holder besides the offering.');
  }

  return {
    holderAccounts: rows.map(row => row.address),
    holderAllocations: rows.map(row => row.units),
    offeringUnits,
  };
}
