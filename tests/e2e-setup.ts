// Playwright global setup: boots a throwaway anvil with Base's chain id, then
// prepares the chain the app expects — MockUSDC etched at the Base USDC
// address `Offering` hardcodes, MockSplitMain + OfferingFactory deployed, and
// the buyer accounts funded. Bytecode comes from the forge test artifacts
// (contracts/out), so the mocks are exactly the ones the Solidity suite runs
// against; `npm run build:contracts` must have been run after contract edits.
//
// Also exports the node-side RPC helpers the spec uses to seed offerings.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { FullConfig } from '@playwright/test';
import { encodeDeployData, encodeFunctionData, getAddress } from 'viem';
import type { Abi, Address, Hex } from 'viem';

export const RPC_URL = 'http://127.0.0.1:8545';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function rpc(method: string, params: unknown[] = []): Promise<any> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

interface TxReceipt {
  status: string;
  contractAddress: string | null;
  logs: Array<{ address: string; topics: Hex[]; data: Hex }>;
}

export async function sendTx(tx: { from: string; to?: string; data: Hex }): Promise<TxReceipt> {
  const hash = await rpc('eth_sendTransaction', [tx]);
  for (let i = 0; i < 200; i++) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error('Transaction reverted: ' + JSON.stringify(tx).slice(0, 200));
      return receipt;
    }
    await sleep(50);
  }
  throw new Error('Timed out waiting for anvil receipt.');
}

export const e2eFactory = (): Address => process.env.PACT_E2E_FACTORY as Address;
export const e2eAccounts = (): Address[] => JSON.parse(process.env.PACT_E2E_ACCOUNTS!);

export default async function globalSetup(_config: FullConfig) {
  const artifact = (relative: string) =>
    JSON.parse(readFileSync(new URL('../contracts/out/' + relative, import.meta.url), 'utf8'));

  const anvil = spawn('anvil', ['--chain-id', '8453', '--port', '8545', '--silent'], { stdio: 'ignore' });
  const anvilExit = new Promise<never>((_, reject) => {
    anvil.on('exit', code => reject(new Error(`anvil exited with code ${code} — is Foundry installed and port 8545 free?`)));
  });
  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        await rpc('eth_chainId');
        return;
      } catch {
        await sleep(100);
      }
    }
    throw new Error('anvil did not become ready on ' + RPC_URL);
  })();
  await Promise.race([ready, anvilExit]);

  const accounts: Address[] = await rpc('eth_accounts');
  const [deployer, buyerA, buyerB] = accounts;

  const usdc = artifact('Offering.t.sol/MockUSDC.json');
  await rpc('anvil_setCode', [BASE_USDC, usdc.deployedBytecode.object]);

  const splitMain = artifact('Offering.t.sol/MockSplitMain.json');
  const splitMainAddress = (await sendTx({ from: deployer, data: splitMain.bytecode.object })).contractAddress!;

  const factoryArtifact = artifact('OfferingFactory.sol/OfferingFactory.json');
  const factoryAddress = (await sendTx({
    from: deployer,
    data: encodeDeployData({
      abi: factoryArtifact.abi as Abi,
      bytecode: factoryArtifact.bytecode.object,
      args: [getAddress(splitMainAddress)],
    }),
  })).contractAddress!;

  const mintAbi = [{
    type: 'function', name: 'mint', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [],
  }] as const;
  for (const buyer of [buyerA, buyerB]) {
    await sendTx({
      from: deployer,
      to: BASE_USDC,
      data: encodeFunctionData({ abi: mintAbi, functionName: 'mint', args: [buyer, 1_000_000_000_000n] }),
    });
  }

  process.env.PACT_E2E_FACTORY = getAddress(factoryAddress);
  process.env.PACT_E2E_ACCOUNTS = JSON.stringify(accounts);
  process.env.PACT_E2E_ANVIL_PID = String(anvil.pid);
}
