import test from 'node:test';
import assert from 'node:assert/strict';
import { atomicBatchSupported, sendBatchedCalls } from './onchain.ts';

const BASE = '0x2105';
const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;

// Fake EIP-1193 provider serving canned responses per method, recording calls.
function fakeProvider(responses: Record<string, any | ((params: any) => any)>) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  return {
    calls,
    request: async ({ method, params }: { method: string; params?: any }) => {
      calls.push({ method, params });
      if (!(method in responses)) throw new Error('unknown method ' + method);
      const value = responses[method];
      return typeof value === 'function' ? value(params) : value;
    },
  };
}

test('atomicBatchSupported accepts supported and ready, rejects the rest', async () => {
  for (const [status, expected] of [['supported', true], ['ready', true], ['unsupported', false]] as const) {
    const provider = fakeProvider({ wallet_getCapabilities: { [BASE]: { atomic: { status } } } });
    assert.equal(await atomicBatchSupported(provider, ACCOUNT), expected, status);
  }
  assert.equal(await atomicBatchSupported(fakeProvider({}), ACCOUNT), false, 'method missing');
  assert.equal(await atomicBatchSupported(fakeProvider({ wallet_getCapabilities: {} }), ACCOUNT), false, 'no chain entry');
});

test('sendBatchedCalls returns the final receipt once confirmed', async () => {
  const receipt = { status: '0x1', transactionHash: '0xbeef', blockNumber: '0x1', logs: [] };
  let polls = 0;
  const provider = fakeProvider({
    wallet_sendCalls: { id: 'batch-1' },
    wallet_getCallsStatus: () => (++polls < 2 ? { status: 100 } : { status: 200, receipts: [receipt] }),
  });
  const result = await sendBatchedCalls({ provider, from: ACCOUNT, calls: [{ to: ACCOUNT, data: '0x' }], pollMs: 1 });
  assert.deepEqual(result, receipt);
  const sent = provider.calls.find(c => c.method === 'wallet_sendCalls')!.params as any[];
  assert.equal(sent[0].atomicRequired, true);
  assert.equal(sent[0].chainId, BASE);
});

test('sendBatchedCalls throws on a failed batch status', async () => {
  const provider = fakeProvider({
    wallet_sendCalls: 'batch-2', // v1 wallets return the bare id string
    wallet_getCallsStatus: { status: 400 },
  });
  await assert.rejects(
    sendBatchedCalls({ provider, from: ACCOUNT, calls: [{ to: ACCOUNT, data: '0x' }], pollMs: 1 }),
    /failed/,
  );
});
