import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import {
  createPact,
  getPact,
  addAllocation,
  deleteAllocation,
  fundAllocation,
  syncOfferingState,
  syncCapTableState,
  listPacts,
  listPurchases,
} from '../server/pacts.js';
import { fetchLiquidSplitHoldersFromExplorer } from '../server/explorer.js';

function fixturePact() {
  return {
    projectName: 'Test PACT',
    raise: { min: 5000, max: 10000 },
    minimum: { deadlineDays: 30, refundIfUnmet: 'burn-tokens-for-full-purchase-amount' },
    maximum: { reclaimUnsoldBy: 'project-treasury' },
    maxDilutionPct: 20,
    proceedsAddress: '0x0000000000000000000000000000000000000001',
    issuerWallet: '0x0000000000000000000000000000000000000009',
    valuation: {
      effectiveCap: 50000,
      bandPct: 20,
      floor: 40000,
      ceiling: 60000,
      curve: 'linear-in-tokens',
    },
    totalTokens: 1000,
    holders: [],
    newMoney: { afterPct: 20, tokens: 200, delivery: 'bonding-curve' },
  };
}

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-api-'));
  const db = openDb(path.join(dir, 'test.sqlite'));
  try {
    fn(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('creates and reads a pact', () => {
  withDb(db => {
    const created = createPact(db, fixturePact());
    assert.equal(created.status, 201);
    assert.match(created.body.id, /^r/);
    assert.equal(created.body.allocations.length, 0);

    const read = getPact(db, created.body.id);
    assert.equal(read.status, 200);
    assert.equal(read.body.projectName, 'Test PACT');
  });
});

test('migrates a legacy raises table to pacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-migrate-'));
  const dbPath = path.join(dir, 'test.sqlite');
  try {
    let db = openDb(dbPath);
    db.exec('ALTER TABLE pacts RENAME TO raises');
    db.prepare('INSERT INTO raises (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('rlegacy', JSON.stringify({ id: 'rlegacy', projectName: 'Legacy' }), 1, 1);
    db.close();

    db = openDb(dbPath);
    const read = getPact(db, 'rlegacy');
    assert.equal(read.status, 200);
    assert.equal(read.body.projectName, 'Legacy');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('funds an allocation and records the purchase', () => {
  withDb(db => {
    const created = createPact(db, fixturePact());
    const pactId = created.body.id;

    const added = addAllocation(db, pactId, { name: 'Buyer One', amountUsd: 1500 });
    assert.equal(added.status, 201);
    assert.equal(added.body.allocation.status, 'allocated');

    const allocationId = added.body.allocation.id;
    const txHash = '0x' + '8'.repeat(64);
    const funded = fundAllocation(db, pactId, allocationId, { buyerWallet: '0x0000000000000000000000000000000000000008', txHash });
    assert.equal(funded.status, 200);
    assert.equal(funded.body.allocation.status, 'funded');
    assert.equal(funded.body.allocation.buyerWallet, '0x0000000000000000000000000000000000000008');
    assert.equal(funded.body.allocation.txHash, txHash);
    assert.ok(funded.body.allocation.fundedAt);

    const purchases = listPurchases(db, '0x0000000000000000000000000000000000000008');
    assert.equal(purchases.status, 200);
    assert.equal(purchases.body.purchases.length, 1);
    assert.equal(purchases.body.purchases[0].pactId, pactId);
    assert.equal(purchases.body.purchases[0].allocationId, allocationId);
    assert.equal(purchases.body.purchases[0].txHash, txHash);
  });
});

test('funded allocations are immutable; unfunded ones can be deleted', () => {
  withDb(db => {
    const created = createPact(db, fixturePact());
    const pactId = created.body.id;

    const funded = addAllocation(db, pactId, { name: 'Buyer One', amountUsd: 1500 });
    fundAllocation(db, pactId, funded.body.allocation.id, { buyerWallet: '0x0000000000000000000000000000000000000008' });
    const blocked = deleteAllocation(db, pactId, funded.body.allocation.id);
    assert.equal(blocked.status, 409);

    const pending = addAllocation(db, pactId, { name: 'Buyer Two', amountUsd: 500 });
    const deleted = deleteAllocation(db, pactId, pending.body.allocation.id);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.pact.allocations.some(a => a.id === pending.body.allocation.id), false);
    assert.equal(deleted.body.pact.allocations.some(a => a.id === funded.body.allocation.id), true);
  });
});

test('syncs offering contract state onto a pact', () => {
  withDb(db => {
    const input = fixturePact();
    input.chainId = 8453;
    input.offeringAddress = '0x0000000000000000000000000000000000001234';
    const created = createPact(db, input);

    const synced = syncOfferingState(db, created.body.id, {
      remainingUnits: 176,
      unitsSold: 24,
      minMet: false,
      state: 0,
      raised: 81234,
      withdrawn: 0,
    });

    assert.equal(synced.status, 200);
    assert.equal(synced.body.onchainOffering.unitsSold, 24);
    assert.equal(synced.body.onchainOffering.raised, 81234);
    assert.equal(synced.body.onchainOffering.minMet, false);

    const read = getPact(db, created.body.id);
    assert.equal(read.body.onchainOffering.offeringAddress, input.offeringAddress);
    assert.equal(read.body.onchainOffering.remainingUnits, 176);
  });
});

test('rejects incomplete offering state', () => {
  withDb(db => {
    const input = fixturePact();
    input.offeringAddress = '0x0000000000000000000000000000000000001234';
    const created = createPact(db, input);

    const synced = syncOfferingState(db, created.body.id, { remainingUnits: 176 });
    assert.equal(synced.status, 400);
  });
});

test('syncs cap table state onto a pact', () => {
  withDb(db => {
    const input = fixturePact();
    input.chainId = 8453;
    input.liquidSplitAddress = '0x0000000000000000000000000000000000001234';
    const created = createPact(db, input);

    const synced = syncCapTableState(db, created.body.id, {
      chainId: 8453,
      source: 'splits-explorer',
      holders: [
        { address: '0x0000000000000000000000000000000000000002', balance: 400 },
        { address: '0x0000000000000000000000000000000000007777', balance: 200 },
      ],
    });

    assert.equal(synced.status, 200);
    assert.equal(synced.body.onchainCapTable.holders.length, 2);
    assert.equal(synced.body.onchainCapTable.source, 'splits-explorer');

    const read = getPact(db, created.body.id);
    assert.equal(read.body.onchainCapTable.liquidSplitAddress, input.liquidSplitAddress);
    assert.equal(read.body.onchainCapTable.holders[1].balance, 200);
  });
});

test('lists pacts for issuer and treasury wallets', () => {
  withDb(db => {
    const first = createPact(db, fixturePact());
    const other = fixturePact();
    other.projectName = 'Other Issuer';
    other.issuerWallet = '0x0000000000000000000000000000000000000007';
    other.proceedsAddress = '0x0000000000000000000000000000000000000008';
    createPact(db, other);

    const listed = listPacts(db, '0x0000000000000000000000000000000000000009');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.pacts.length, 1);
    assert.equal(listed.body.pacts[0].id, first.body.id);
    assert.equal(listed.body.pacts[0].projectName, 'Test PACT');

    const treasuryListed = listPacts(db, '0x0000000000000000000000000000000000000001');
    assert.equal(treasuryListed.status, 200);
    assert.equal(treasuryListed.body.pacts.length, 1);
    assert.equal(treasuryListed.body.pacts[0].id, first.body.id);
  });
});

test('rejects invalid pacts and allocations', () => {
  withDb(db => {
    const badPact = createPact(db, {});
    assert.equal(badPact.status, 400);

    const created = createPact(db, fixturePact());
    const badAllocation = addAllocation(db, created.body.id, { name: '', amountUsd: 0 });
    assert.equal(badAllocation.status, 400);
  });
});

test('maps Splits Explorer Liquid Split holders', async () => {
  const split = '0x0000000000000000000000000000000000001234';
  const holder = '0x0000000000000000000000000000000000000002';
  const curve = '0xc6C8F6E4A73B2971C725359bb595Da1306FE5257';
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        data: {
          account: {
            __typename: 'LiquidSplit',
            holders: [
              { id: split.toLowerCase() + '-' + holder.toLowerCase(), ownership: '400000' },
              { id: split.toLowerCase() + '-' + curve.toLowerCase(), ownership: '200000' },
              { id: split.toLowerCase() + '-not-an-address', ownership: '1' },
              { id: split.toLowerCase() + '-0x0000000000000000000000000000000000000003', ownership: '0' },
            ],
          },
        },
      }),
    };
  };

  const result = await fetchLiquidSplitHoldersFromExplorer({ liquidSplitAddress: split, chainId: 8453 }, fetchImpl);

  assert.equal(result.status, 200);
  assert.equal(result.body.source, 'splits-explorer');
  assert.deepEqual(result.body.holders, [
    { address: holder.toLowerCase(), balance: 400 },
    { address: curve.toLowerCase(), balance: 200 },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).variables.accountId, split.toLowerCase());
});

test('rejects invalid Liquid Split holder lookups', async () => {
  const result = await fetchLiquidSplitHoldersFromExplorer({ liquidSplitAddress: 'nope' }, async () => {
    throw new Error('should not fetch');
  });
  assert.equal(result.status, 400);
});

test('uses Splits Explorer API key when configured', async () => {
  const originalKey = process.env.SPLITS_EXPLORER_API_KEY;
  const originalUrl = process.env.SPLITS_EXPLORER_GRAPHQL_URL;
  delete process.env.SPLITS_EXPLORER_GRAPHQL_URL;
  process.env.SPLITS_EXPLORER_API_KEY = 'test-key';

  try {
    let call;
    const fetchImpl = async (url, options) => {
      call = { url, options };
      return {
        ok: true,
        json: async () => ({
          data: {
            account: {
              __typename: 'LiquidSplit',
              holders: [],
            },
          },
        }),
      };
    };

    const result = await fetchLiquidSplitHoldersFromExplorer({
      liquidSplitAddress: '0x0000000000000000000000000000000000001234',
    }, fetchImpl);

    assert.equal(result.status, 200);
    assert.equal(call.url, 'https://api.splits.org/graphql');
    assert.equal(call.options.headers.Authorization, 'Bearer test-key');
  } finally {
    if (originalKey == null) delete process.env.SPLITS_EXPLORER_API_KEY;
    else process.env.SPLITS_EXPLORER_API_KEY = originalKey;
    if (originalUrl == null) delete process.env.SPLITS_EXPLORER_GRAPHQL_URL;
    else process.env.SPLITS_EXPLORER_GRAPHQL_URL = originalUrl;
  }
});
