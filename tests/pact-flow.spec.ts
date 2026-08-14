// Anvil-backed browser flow: real transactions against the throwaway chain
// booted by e2e-setup.ts. The injected wallet is a thin EIP-1193 passthrough
// to anvil's unlocked accounts — anvil signs and sends everything, including
// the EIP-712 voucher signatures, so the private-claim scenario exercises the
// real Solidity verifier (second coverage of the golden-vector boundary).
import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { encodeFunctionData, getAddress } from 'viem';
import type { Address } from 'viem';
import { OFFERING_FACTORY_ABI } from '../src/generated/offering-contracts.ts';
import { RPC_URL, e2eAccounts, e2eFactory, sendTx } from './e2e-setup.ts';

test.describe.configure({ timeout: 60_000 });

// wagmi surfaces checksummed addresses regardless of the mock's casing.
const short = (address: string) => getAddress(address).slice(0, 6) + '…' + getAddress(address).slice(-4);

async function installWallet(context: BrowserContext, account: string) {
  await context.addInitScript(({ rpcUrl, factory, account }) => {
    const w = window as any;
    w.PACT_RPC_URL = rpcUrl;
    w.PACT_OFFERING_FACTORY_ADDRESS = factory;
    w.PACT_FACTORY_DEPLOY_BLOCK = 0;
    const rpc = async (method: string, params: unknown) => {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }),
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error.message);
      return body.result;
    };
    w.ethereum = {
      request: async ({ method, params }: { method: string; params?: any }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        if (method === 'eth_signTypedData_v4') {
          const [address, typedData] = params;
          return rpc(method, [address, typeof typedData === 'string' ? JSON.parse(typedData) : typedData]);
        }
        return rpc(method, params);
      },
      on: () => {},
      removeListener: () => {},
    };
  }, { rpcUrl: RPC_URL, factory: e2eFactory(), account });
}

// wagmi never auto-connects a wallet the user hasn't chosen, so each fresh
// context connects once through the picker (the mock is the generic injected
// provider); reloads within a context then restore automatically.
async function connectWallet(page: Page, account: string, connectorName = 'Injected') {
  await page.locator('#walletToggle').click();
  await page.getByRole('button', { name: connectorName, exact: true }).click();
  await expect(page.locator('#walletToggle')).toContainText(short(account));
}

// Seeds an offering straight through the factory: scenarios that aren't about
// the create flow start from a fresh contract without driving the create page.
async function seedOffering({ projectName, publicUnits }: { projectName: string; publicUnits: number }): Promise<Address> {
  const [deployer, , , holder] = e2eAccounts();
  const factory = e2eFactory();
  const receipt = await sendTx({
    from: deployer,
    to: factory,
    data: encodeFunctionData({
      abi: OFFERING_FACTORY_ABI,
      functionName: 'createOffering',
      args: [
        projectName,
        100_000_000n, // $100 minimum
        BigInt(Math.floor(Date.now() / 1000) + 7 * 86400),
        1_000_000n, // $1 first unit
        1000n, // +$0.001 per unit sold
        BigInt(publicUnits),
        deployer,
        [holder],
        [800],
        200,
      ],
    }),
  });
  const created = receipt.logs.find(log => log.address.toLowerCase() === factory.toLowerCase())!;
  return getAddress('0x' + created.topics[3].slice(26));
}

test('issuer creates a PACT through the UI and lands on its status page', async ({ browser }) => {
  const [issuer, , , holderA, holderB] = e2eAccounts();
  const context = await browser.newContext();
  await installWallet(context, issuer);
  const page = await context.newPage();

  await page.goto('/create');
  await connectWallet(page, issuer);

  // leaving a required field empty flags it, and min > max flags both raise fields
  await page.locator('#proceeds').focus();
  await page.locator('#proceeds').blur();
  await expect(page.locator('#proceeds')).toHaveClass(/error/);
  await page.locator('#raiseMin').fill('20,000');
  await page.locator('#raiseMin').blur();
  await expect(page.locator('#raiseMin')).toHaveClass(/error/);
  await expect(page.locator('#raiseMax')).toHaveClass(/error/);
  await page.locator('#raiseMin').fill('5,000');
  await page.locator('#raiseMin').blur();
  await expect(page.locator('#raiseMin')).not.toHaveClass(/error/);
  await expect(page.locator('#raiseMax')).not.toHaveClass(/error/);

  await page.locator('#projectName').fill('Anvil Test PACT');
  await page.locator('#proceeds').fill(issuer);
  await page.locator('input[data-k="name"]').nth(0).fill(holderA);
  await page.locator('input[data-k="name"]').nth(1).fill(holderB);
  await expect(page.locator('#createBtn')).toBeEnabled();
  await page.locator('#createBtn').click();

  // Real OfferingCreated: decoded from the receipt, cache seeded, redirected.
  await expect(page).toHaveURL(/\/status\?offering=0x[0-9a-fA-F]{40}/, { timeout: 30_000 });
  const offering = new URL(page.url()).searchParams.get('offering')!;
  await expect(page.getByRole('heading', { name: 'Anvil Test PACT' })).toBeVisible();
  const cached = await page.evaluate(
    factory => JSON.parse(localStorage.getItem('pact:offerings:' + factory.toLowerCase()) || 'null'),
    e2eFactory(),
  );
  expect(cached.items.map((item: { offering: string }) => item.offering.toLowerCase())).toContain(offering.toLowerCase());

  // Live contract state: 20% dilution of 1000 units, none public by default.
  await expect(page.getByRole('definition').filter({ hasText: '200 tokens, 0 public' })).toBeVisible();

  // With no public tranche, the public-buy affordances stay hidden.
  await expect(page.getByText('Public buy link')).toHaveCount(0);
  await expect(page.getByText('No purchases yet. Create a private allocation using the row below.')).toBeVisible();

  // Cap table read from PactToken transfer logs + balance reads.
  const capTable = page.locator('table').last();
  const capRows = capTable.locator('tbody').getByRole('row');
  await expect(capRows.nth(0)).toContainText('40.0%');
  await expect(capRows.nth(1)).toContainText('40.0%');
  await expect(capRows.last()).toContainText('PACT offering');
  await expect(capRows.last()).toContainText('20.0%');
  await expect(capTable.locator('tfoot')).toContainText('1,000');
  await expect(capTable.locator('tfoot')).toContainText('100.0%');

  // The issuer wallet manages the offering: allocations table is present.
  await expect(page.locator('button[data-act="open-add"]')).toBeVisible();
  await context.close();
});

test('buyer purchases from the public tranche with real transactions', async ({ browser }) => {
  const [, buyer] = e2eAccounts();
  const offering = await seedOffering({ projectName: 'Public Round', publicUnits: 100 });

  const context = await browser.newContext();
  await installWallet(context, buyer);
  const page = await context.newPage();
  await page.goto('/buy?offering=' + offering);

  await expect(page.getByRole('heading', { name: 'Public Round' })).toBeVisible();
  await connectWallet(page, buyer);
  await expect(page.getByRole('definition').filter({ hasText: '100 tokens' })).toBeVisible();
  await page.getByPlaceholder('0.00').fill('60');
  await page.getByPlaceholder('Optional, public').fill('Alice');
  await page.locator('button[data-act="pay"]').click();

  // USDC approve + buyPublic, both mined on anvil; $60 buys 58 units on this curve.
  await expect(page.getByText('Purchased', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('58 tokens')).toBeVisible();
  await expect(page.locator('a[href*="basescan.org/tx/"]')).toHaveAttribute('href', /basescan\.org\/tx\/0x[a-f0-9]{64}/i);
  await context.close();
});

test('private allocation link claims across two browser contexts', async ({ browser }) => {
  const [issuer, , buyer] = e2eAccounts();
  const offering = await seedOffering({ projectName: 'Private Round', publicUnits: 0 });

  const issuerContext = await browser.newContext();
  await installWallet(issuerContext, issuer);
  const issuerPage = await issuerContext.newPage();
  await issuerPage.goto('/status?offering=' + offering);
  await expect(issuerPage.getByRole('heading', { name: 'Private Round' })).toBeVisible();
  await connectWallet(issuerPage, issuer);

  // Owner signs the voucher (EIP-712 via anvil); the link is the capability.
  await issuerPage.locator('button[data-act="open-add"]').click();
  await issuerPage.locator('#allocName').fill('Buyer One');
  await issuerPage.locator('#allocAmount').fill('50');
  await issuerPage.getByRole('button', { name: 'Generate link' }).click();
  const allocationRow = issuerPage.locator('tr', { hasText: 'Buyer One' });
  await expect(allocationRow.getByText('Allocated')).toBeVisible({ timeout: 15_000 });
  const link: string = await issuerPage.evaluate(
    offering => JSON.parse(localStorage.getItem('pact:allocations:' + offering.toLowerCase())!)[0].link,
    offering,
  );
  expect(link).toMatch(/\/buy\?offering=0x[0-9a-fA-F]{40}#./);

  const buyerContext = await browser.newContext();
  await installWallet(buyerContext, buyer);
  const buyerPage = await buyerContext.newPage();
  await buyerPage.goto(link);
  await expect(buyerPage.getByRole('heading', { name: 'Private Round | Buyer One' })).toBeVisible();
  await connectWallet(buyerPage, buyer);
  await expect(buyerPage.getByText('Allocation details')).toBeVisible();
  await buyerPage.locator('button[data-act="pay"]').click();

  // buyPrivate verifies the owner + link-key signatures onchain; $50 caps at 48 units.
  await expect(buyerPage.getByText('Purchased', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(buyerPage.getByText('48 tokens')).toBeVisible();

  // The claim came from the Bought event, so the issuer sees it after reload.
  await issuerPage.reload();
  const fundedRow = issuerPage.locator('tr', { hasText: 'Buyer One' });
  await expect(fundedRow.getByText('Purchased')).toBeVisible({ timeout: 15_000 });
  await expect(fundedRow.getByText('Allocated')).toHaveCount(0);
  await issuerContext.close();
  await buyerContext.close();
});

test('wallet menu only offers detected wallets plus the Splits store link', async ({ page }) => {
  await page.goto('/');
  await page.locator('#walletToggle').click();
  const menu = page.locator('.wallet-menu');
  await expect(menu.getByRole('link', { name: 'Splits', exact: true })).toBeVisible();
  await expect(menu.getByRole('button')).toHaveCount(0);
});

test('dark palette applies when the system prefers dark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(11, 12, 15)');
});

test('wallet picker can choose among multiple announced providers', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(({ accounts, rpcUrl, factory }) => {
    const w = window as any;
    w.PACT_RPC_URL = rpcUrl;
    w.PACT_OFFERING_FACTORY_ADDRESS = factory;
    w.PACT_FACTORY_DEPLOY_BLOCK = 0;
    const makeProvider = (account: string, key: string, shouldReject: boolean) => ({
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') {
          if (shouldReject) throw new Error('Rejected by default wallet');
          localStorage.setItem(key, '1');
          return [account];
        }
        if (method === 'eth_accounts') return localStorage.getItem(key) === '1' ? [account] : [];
        if (method === 'eth_chainId') return '0x2105';
        throw new Error('Unsupported wallet method: ' + method);
      },
      on: () => {},
      removeListener: () => {},
    });
    const first = makeProvider(accounts.first, 'mock-default-connected', true);
    const second = makeProvider(accounts.second, 'mock-second-connected', false);
    w.ethereum = first;
    // wagmi keys EIP-6963 connectors by rdns, so the announcements carry one.
    window.addEventListener('eip6963:requestProvider', () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'default-wallet', rdns: 'test.default', name: 'Default Wallet' }, provider: first },
      }));
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'second-wallet', rdns: 'test.second', name: 'Second Wallet' }, provider: second },
      }));
    });
  }, { accounts: { first: e2eAccounts()[5], second: e2eAccounts()[6] }, rpcUrl: RPC_URL, factory: e2eFactory() });

  const page = await context.newPage();
  await page.goto('/');
  await page.locator('#walletToggle').click();
  await expect(page.getByRole('button', { name: 'Default Wallet' })).toBeVisible();
  await page.getByRole('button', { name: 'Second Wallet' }).click();
  await expect(page.locator('#walletToggle')).toContainText(short(e2eAccounts()[6]));
  await page.reload();
  await expect(page.locator('#walletToggle')).toContainText(short(e2eAccounts()[6]));
  await context.close();
});
