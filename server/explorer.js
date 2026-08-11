// Splits Explorer GraphQL proxy for Liquid Split cap table reads.
import { isAddress } from '../src/lib/validate.js';
import { BASE_CHAIN_ID } from '../src/lib/chain.js';
import { TOTAL_LIQUID_SPLIT_UNITS } from '../src/lib/liquid-split.js';
import { parseAmount } from './parse.js';

// Explorer reports ownership in millionths; PACT counts whole Liquid Split units.
const EXPLORER_OWNERSHIP_SCALE = 1000000;

function apiKey() {
  return process.env.SPLITS_EXPLORER_API_KEY || '';
}

function graphqlUrl() {
  return process.env.SPLITS_EXPLORER_GRAPHQL_URL
    || (apiKey() ? 'https://api.splits.org/graphql' : 'https://api.splits.org/api/public/graphql');
}

function parseHolderAddress(holderId) {
  const address = String(holderId || '').split('-').pop();
  return isAddress(address) ? address : null;
}

function ownershipToUnits(ownership) {
  return parseAmount(ownership) / (EXPLORER_OWNERSHIP_SCALE / TOTAL_LIQUID_SPLIT_UNITS);
}

export async function fetchLiquidSplitHoldersFromExplorer(input = {}, fetchImpl = global.fetch) {
  const liquidSplitAddress = String(input.liquidSplitAddress || '').trim();
  const chainId = String(input.chainId || BASE_CHAIN_ID);
  if (!isAddress(liquidSplitAddress)) {
    return { status: 400, body: { error: 'Liquid Split address is required.' } };
  }
  if (typeof fetchImpl !== 'function') {
    return { status: 502, body: { error: 'Explorer fetch is unavailable.' } };
  }

  const query = `
    query PactLiquidSplitHolders($accountId: ID!, $chainId: String!) {
      account(id: $accountId, chainId: $chainId) {
        __typename
        ... on LiquidSplit {
          holders {
            id
            ownership
          }
        }
      }
    }
  `;

  let response;
  try {
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': new URL(graphqlUrl()).origin,
    };
    if (apiKey()) {
      headers.Authorization = 'Bearer ' + apiKey();
    }
    response = await fetchImpl(graphqlUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: {
          accountId: liquidSplitAddress.toLowerCase(),
          chainId,
        },
      }),
    });
  } catch (err) {
    return { status: 502, body: { error: 'Could not reach Splits Explorer.', detail: err.message } };
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { status: 502, body: { error: 'Splits Explorer request failed.', detail: body.error || response.statusText } };
  }
  if (Array.isArray(body.errors) && body.errors.length) {
    return { status: 502, body: { error: 'Splits Explorer returned an error.', detail: body.errors[0].message } };
  }

  const account = body.data && body.data.account;
  if (!account) return { status: 404, body: { error: 'Liquid Split was not found in Splits Explorer.' } };
  if (account.__typename && account.__typename !== 'LiquidSplit') {
    return { status: 400, body: { error: 'Account is not a Liquid Split.' } };
  }

  const holders = (account.holders || [])
    .map(holder => ({
      address: parseHolderAddress(holder.id),
      balance: ownershipToUnits(holder.ownership),
    }))
    .filter(holder => holder.address && holder.balance > 0)
    .sort((a, b) => a.address.toLowerCase() > b.address.toLowerCase() ? 1 : -1);

  return { status: 200, body: { holders, source: 'splits-explorer', chainId: Number(chainId) } };
}
