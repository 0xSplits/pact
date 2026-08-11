import { test, expect } from '@playwright/test';

const addr = n => '0x' + String(n).padStart(40, '0');
const baseUsdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const offeringFactory = addr(4321);
const offeringCreatedTopic = '0x567f4d806f68f82992bfe3f76eb29503778ab304a0f8701cfb09f6579239ad8c';
const transferSingleTopic = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const fakeLiquidSplit = addr(1234);
const fakeOffering = addr(7777);
const fakeExternalHolder = addr(55);

function uint256(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}

function encodedAddress(address) {
  return address.toLowerCase().slice(2).padStart(64, '0');
}

function topicAddress(address) {
  return '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
}

async function installWallet(context, account) {
  await context.addInitScript(({ walletAccount, factory, eventTopic, liquidSplit, offering, paymentToken, treasury }) => {
    const uint256 = n => BigInt(n).toString(16).padStart(64, '0');
    const encodedAddress = address => address.toLowerCase().slice(2).padStart(64, '0');
    const topicAddress = address => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
    const offeringEventData = () => '0x' + [
      encodedAddress(liquidSplit),
      encodedAddress(paymentToken),
      uint256(1_000_000),
      uint256(1_800_000_000),
      uint256(1),
      uint256(1),
    ].join('');
    let chainId = '0x1';
    let txCount = 0;
    const receipts = new Map();
    window.PACT_OFFERING_FACTORY_ADDRESS = factory;
    window.ethereum = {
      request: async ({ method, params }) => {
        const requests = JSON.parse(sessionStorage.getItem('mock-wallet-requests') || '[]');
        requests.push({ method, params });
        sessionStorage.setItem('mock-wallet-requests', JSON.stringify(requests));
        window.__walletRequests = requests;
        if (method === 'eth_requestAccounts') {
          localStorage.setItem('mock-wallet-connected', '1');
          return [walletAccount];
        }
        if (method === 'eth_accounts') return localStorage.getItem('mock-wallet-connected') === '1' ? [walletAccount] : [];
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_switchEthereumChain') {
          chainId = params[0].chainId;
          return null;
        }
        if (method === 'eth_sendTransaction') {
          const submittedTx = params[0];
          const hash = '0x' + String(++txCount).padStart(64, 'a');
          const logs = submittedTx.to && submittedTx.to.toLowerCase() === factory.toLowerCase()
            ? [{
              address: factory,
              data: offeringEventData(),
              topics: [eventTopic, topicAddress(walletAccount), topicAddress(submittedTx.from || walletAccount), topicAddress(offering)],
            }]
            : [];
          receipts.set(hash, { transactionHash: hash, status: '0x1', logs });
          return hash;
        }
        if (method === 'eth_call') {
          const call = params[0] || {};
          const data = (call.data || '').toLowerCase();
          const resultBySelector = {
            '0x8aeac989': uint256(150),
            '0x8e26532b': uint256(50),
            '0x7359687a': uint256(0),
            '0xc19d93fb': uint256(0),
            '0xf0ea4bfc': uint256(0),
            '0xc80ec522': uint256(0),
            '0x6335334c': uint256(1_000_000),
            '0x48d79b6d': uint256(Math.floor(Date.now() / 1000) + 2_592_000),
            '0x8da5cb5b': encodedAddress(walletAccount),
            '0x61d027b3': encodedAddress(treasury),
            '0xfc7e286d': uint256(0),
            '0xdd62ed3e': uint256(0),
          };
          return '0x' + (resultBySelector[data.slice(0, 10)] || uint256(0));
        }
        if (method === 'eth_getTransactionReceipt') {
          return receipts.get(params[0]) || null;
        }
        throw new Error('Unsupported wallet method: ' + method);
      },
      on: () => {},
    };
  }, {
    walletAccount: account,
    factory: offeringFactory,
    eventTopic: offeringCreatedTopic,
	    liquidSplit: fakeLiquidSplit,
	    offering: fakeOffering,
	    paymentToken: baseUsdc,
	    treasury: addr(1),
	  });
	}

async function installBaseRpcMock(context, baseRpcCalls) {
  await context.route(/https:\/\/mainnet\.base\.org\/?/, async route => {
    const body = route.request().postDataJSON();
    baseRpcCalls.push(body);
    const transferLog = (to, amount) => ({
      address: fakeLiquidSplit,
      topics: [transferSingleTopic, topicAddress(addr(9)), topicAddress(addr(0)), topicAddress(to)],
      data: '0x' + uint256(0) + uint256(amount),
    });
    if (body.method === 'eth_getLogs') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: [
            transferLog(addr(2), 400),
            transferLog(addr(3), 400),
            transferLog(fakeExternalHolder, 50),
            transferLog(fakeOffering, 150),
          ],
        }),
      });
    }
    if (body.method === 'eth_getTransactionReceipt') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { blockNumber: '0x123456' },
        }),
      });
    }
    if (body.method === 'eth_call') {
      const call = body.params[0] || {};
      const data = (call.data || '').toLowerCase();
      const resultBySelector = {
        '0x8aeac989': uint256(150),
        '0x8e26532b': uint256(50),
        '0x7359687a': uint256(0),
        '0xc19d93fb': uint256(0),
        '0xf0ea4bfc': uint256(0),
        '0xc80ec522': uint256(0),
        '0x6335334c': uint256(1_000_000),
        '0x48d79b6d': uint256(Math.floor(Date.now() / 1000) + 2_592_000),
        '0x8da5cb5b': encodedAddress(addr(9)),
        '0x61d027b3': encodedAddress(addr(1)),
        '0xfc7e286d': uint256(0),
        '0xdd62ed3e': uint256(0),
      };
      const result = resultBySelector[data.slice(0, 10)] || (() => {
        const account = data.length >= 138 ? '0x' + data.slice(34, 74) : '';
        const balances = {
          [addr(2).toLowerCase()]: 400,
          [addr(3).toLowerCase()]: 400,
          [fakeExternalHolder.toLowerCase()]: 50,
          [fakeOffering.toLowerCase()]: 150,
        };
        return uint256(balances[account.toLowerCase()] || 0);
      })();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' + result }),
      });
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' + uint256(0) }),
    });
  });
}

test('issuer can create a PACT and buyer can purchase from another browser context', async ({ browser }) => {
  const issuer = await browser.newContext();
  await installWallet(issuer, addr(9));
  const baseRpcCalls = [];
  await installBaseRpcMock(issuer, baseRpcCalls);
  await issuer.route('**/api/liquid-splits/*/holders*', async route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        holders: [
          { address: addr(2), balance: 400 },
          { address: addr(3), balance: 400 },
          { address: fakeExternalHolder, balance: 50 },
          { address: fakeOffering, balance: 150 },
        ],
        source: 'splits-explorer',
        chainId: 8453,
      }),
    });
  });
  const page = await issuer.newPage();

  await page.goto('/create');
  await expect(page.locator('#createBtn')).toHaveText('Sign and create issuance');
  await expect(page.locator('#createBtn')).toBeDisabled();

  // leaving a required field empty flags it, and min > max flags both raise fields
  await page.locator('#proceeds').focus();
  await page.locator('#proceeds').blur();
  await expect(page.locator('#proceeds')).toHaveClass(/error/);
  await page.locator('#raiseMin').fill('20,000');
  await page.locator('#raiseMin').blur();
  await expect(page.locator('#raiseMin')).toHaveClass(/error/);
  await expect(page.locator('#raiseMax')).toHaveClass(/error/);
  await page.locator('#raiseMax').hover();
  await expect(page.locator('.err-tip')).toHaveClass(/show/);
  await page.locator('#raiseMin').fill('5,000');
  await page.locator('#raiseMin').blur();
  await expect(page.locator('#raiseMin')).not.toHaveClass(/error/);
  await expect(page.locator('#raiseMax')).not.toHaveClass(/error/);
  await expect(page.locator('.err-tip')).not.toHaveClass(/show/);

  await page.locator('#projectName').fill('Cross Context PACT');
  await page.locator('#proceeds').fill(addr(1));
  await page.locator('input[data-k="name"]').nth(0).fill(addr(2));
  await page.locator('input[data-k="name"]').nth(1).fill(addr(3));
  await expect(page.locator('#createBtn')).toBeDisabled();
  await expect(page.locator('#createTip')).toContainText('Connect wallet to create issuance');
  await page.locator('#walletToggle').click();
  await expect(page.locator('#walletToggle')).toContainText('0x0000...0009');
  await expect(page.locator('#createBtn')).toHaveText('Sign and create issuance');
  await expect(page.locator('#createBtn')).toBeEnabled();
  await page.locator('#createBtn').click();
  await expect(page).toHaveURL(/\/pacts\/r/);
  await expect(page.getByRole('heading', { name: 'Cross Context PACT' })).toBeVisible();
  await expect(page.locator('a[href*="basescan.org/address/0x0000000000000000000000000000000000000001"]')).toContainText('0x0000…0001');
  await expect(page.getByRole('term').filter({ hasText: 'Liquid Split' })).toHaveCount(0);
  await expect(page.locator('.font-bold', { hasText: 'Cap table' })).toBeVisible();
  const capTable = page.locator('table').last();
  const capRows = capTable.locator('tbody').getByRole('row');
  await expect(capRows.nth(0)).toContainText('0x0000…0002');
  await expect(capRows.nth(0)).toContainText('40.0%');
  await expect(capRows.nth(2)).toContainText('0x0000…0055');
  await expect(capRows.nth(2)).toContainText('5.0%');
  await expect(capRows.last()).toContainText('PACT offering: 0x0000…7777');
  await expect(capRows.last().locator('a')).toHaveAttribute('href', /basescan\.org\/address\/0x0000000000000000000000000000000000007777/i);
  await expect(capRows.last()).toContainText('15.0%');
  await expect(capTable.locator('tfoot')).toContainText('Total');
  await expect(capTable.locator('tfoot')).toContainText('1,000');
  await expect(capTable.locator('tfoot')).toContainText('100.0%');
  await expect(capTable.locator('tfoot')).toContainText('Verify this cap table by viewing the Split');
  await expect(capTable.locator('tfoot a[href*="explorer.splits.org/accounts/"]')).toHaveAttribute('href', /explorer\.splits\.org\/accounts\/0x0000000000000000000000000000000000001234\/\?chainId=8453/i);
  expect(baseRpcCalls.some(call => call.method === 'eth_getLogs')).toBe(false);
  await expect(page.getByRole('term').filter({ hasText: 'Available' })).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: '150 tokens' })).toBeVisible();
  await expect(page.locator('.font-bold', { hasText: '$0' })).toBeVisible();
  const walletRequests = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mock-wallet-requests') || '[]'));
  expect(walletRequests.some(r => r.method === 'wallet_switchEthereumChain' && r.params[0].chainId === '0x2105')).toBe(true);
  const sentTx = walletRequests.find(r => r.method === 'eth_sendTransaction').params[0];
  expect(sentTx.to).toBe(offeringFactory);
  expect(sentTx.chainId).toBe('0x2105');
  expect(sentTx.data.startsWith('0x48ff656c')).toBe(true);
  await expect(page.locator('#walletToggle')).toContainText('0x0000...0009');
  await page.locator('#walletToggle').click();
  await expect(page.locator('.wallet-menu')).toContainText('Your issuances');
  await expect(page.locator('.wallet-menu')).toContainText('Cross Context PACT');
  await expect(page.locator('.wallet-menu')).toContainText('New issuance');
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  await page.getByRole('heading', { name: 'Cross Context PACT' }).click();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your PACTs' })).toBeVisible();
  await expect(page.locator('a[href*="/pacts/"]', { hasText: 'Cross Context PACT' }).first()).toHaveAttribute('href', /\/pacts\/r/);
  await page.goBack();

  await page.getByRole('button', { name: '+ New allocation' }).click();
  await page.locator('#allocName').fill('Buyer One');
  await page.locator('#allocAmount').fill('1,500');
  await page.getByRole('button', { name: 'Generate link' }).click();
  await expect(page.locator('[data-act="copy"]')).toBeVisible();
  const buyLink = await page.evaluate(() => {
    const id = document.querySelector('[data-act="copy"]').dataset.id;
    return new URL(location.pathname + '/allocations/' + id, location.href).href;
  });
  expect(buyLink).toMatch(/\/pacts\/r.*\/allocations\/a/);

  const buyer = await browser.newContext();
  await installWallet(buyer, addr(8));
  await installBaseRpcMock(buyer, baseRpcCalls);
  const buyerPage = await buyer.newPage();
  await buyerPage.goto(buyLink);
  await expect(buyerPage).toHaveURL(/\/pacts\/r.*\/allocations\/a/);
  await expect(buyerPage.getByRole('heading', { name: 'Cross Context PACT' })).toBeVisible();
  await expect(buyerPage.getByText('Allocation details')).toBeVisible();
  await expect(buyerPage.getByText('Connect a wallet before purchasing this offering.')).toBeVisible();
  await buyerPage.locator('#walletToggle').click();
  await expect(buyerPage.locator('#walletToggle')).toContainText('0x0000...0008');
  await buyerPage.getByRole('button', { name: 'Purchase Cross Context PACT' }).click();
  await expect(buyerPage.getByText('Purchased', { exact: true })).toBeVisible();
  await expect(buyerPage.locator('a[href*="basescan.org/tx/"]')).toHaveAttribute('href', /basescan\.org\/tx\/0x[a-f0-9]{64}/i);
  await buyerPage.locator('#walletToggle').click();
  await expect(buyerPage.locator('.wallet-menu')).toContainText('Your purchases');
  await expect(buyerPage.locator('.wallet-menu')).toContainText('Cross Context PACT');
  await expect(buyerPage.locator('.wallet-menu a[href*="/pacts/"]').first()).toHaveAttribute('href', /\/pacts\/r.*\/allocations\/a/);
  await buyerPage.getByRole('heading', { name: 'Cross Context PACT' }).click();
  await buyerPage.goto('/');
  await expect(buyerPage.getByRole('heading', { name: 'Your PACTs' })).toBeVisible();
  await expect(buyerPage.locator('a[href*="/pacts/"]', { hasText: 'Cross Context PACT' }).first()).toHaveAttribute('href', /\/pacts\/r.*\/allocations\/a/);
  const statusUrl = await page.evaluate(() => location.pathname);
  await buyerPage.goto(statusUrl);
  await expect(buyerPage).toHaveURL(/\/pacts\/r/);
  await expect(buyerPage.getByRole('heading', { name: 'PACT offering' })).toBeVisible();
  await expect(buyerPage.getByText('Connect with the treasury or creator wallet to manage the offering.')).toBeVisible();
  await expect(buyerPage.locator('.alloc-table')).toHaveCount(0);

  await page.reload();
  await expect(page.getByText('Purchased 32 tokens')).toBeVisible();
  const allocationRows = page.locator('.alloc-table tbody tr');
  await expect(allocationRows.first().getByRole('button', { name: 'Copy link' })).toBeVisible();
  await expect(allocationRows.first().getByRole('button', { name: 'Delete' })).toHaveCount(0);

  await issuer.close();
  await buyer.close();
});

test('wallet button shows a visible error when no provider is available', async ({ page }) => {
  await page.goto('/');
  await page.locator('#walletToggle').click();
  await expect(page.locator('#walletToggle')).toContainText('No wallet found');
});

test('settings menu exposes style options', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  const menu = page.locator('.settings-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Style');
  await expect(menu).toContainText('Clarity');
  await expect(menu).toContainText('Cipher');
  await expect(menu).toContainText('Chambers');
});

test('wallet picker can choose among multiple announced providers', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(accounts => {
    const makeProvider = (account, key, shouldReject) => ({
      request: async ({ method }) => {
        if (method === 'eth_requestAccounts') {
          if (shouldReject) throw new Error('Rejected by default wallet');
          localStorage.setItem(key, '1');
          return [account];
        }
        if (method === 'eth_accounts') return localStorage.getItem(key) === '1' ? [account] : [];
        throw new Error('Unsupported wallet method: ' + method);
      },
      on: () => {},
    });
    const first = makeProvider(accounts.first, 'mock-default-connected', true);
    const second = makeProvider(accounts.second, 'mock-second-connected', false);
    window.ethereum = first;
    window.addEventListener('eip6963:requestProvider', () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'default-wallet', name: 'Default Wallet' }, provider: first },
      }));
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'second-wallet', name: 'Second Wallet' }, provider: second },
      }));
    });
  }, { first: addr(7), second: addr(6) });

  const page = await context.newPage();
  await page.goto('/');
  await page.locator('#walletToggle').click();
  await expect(page.getByRole('button', { name: 'Default Wallet' })).toBeVisible();
  await page.getByRole('button', { name: 'Second Wallet' }).click();
  await expect(page.locator('#walletToggle')).toContainText('0x0000...0006');
  await page.reload();
  await expect(page.locator('#walletToggle')).toContainText('0x0000...0006');
  await context.close();
});
