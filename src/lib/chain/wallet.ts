import { esc } from '../format.ts';
import { showToast } from '../ui/toast.ts';
import { buyPath, createPath, currentCreatePage, currentOfferingAddress, statusPath } from '../routes.ts';
import { listOfferings, listPurchases } from './offerings.ts';
import type { Eip1193Provider, OfferingRecord, Purchase } from './onchain.ts';

// EIP-6963 announcement payload (info is loosely typed on purpose — wallets
// vary in what they announce).
export interface ProviderDetail {
  info?: { uuid?: string; name?: string; icon?: string; rdns?: string };
  provider: Eip1193Provider;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
  interface WindowEventMap {
    'eip6963:announceProvider': CustomEvent<ProviderDetail>;
  }
}

interface ProviderEntry {
  id: string;
  info: NonNullable<ProviderDetail['info']>;
  provider: Eip1193Provider;
}

interface InitOptions {
  buttonId: string;
  onChange?: (account: string | null) => void;
  onError?: (err: unknown) => void;
}

const STORAGE_KEY = 'pact-wallet-disconnected';
const PROVIDER_KEY = 'pact-wallet-provider-id';
let account: string | null = null;
let button: HTMLElement | null = null;
let menu: HTMLElement | null = null;
let onChange: ((account: string | null) => void) | null = null;
let status = 'idle';
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let activeProvider: Eip1193Provider | null = null;
let pacts: OfferingRecord[] | null = null;
let purchases: Array<Purchase & { record: OfferingRecord }> | null = null;
const providers: ProviderEntry[] = [];

const short = (address: string | null | undefined) => address ? address.slice(0, 6) + '…' + address.slice(-4) : '';
const provider = (): Eip1193Provider | undefined => activeProvider || (providers[0] && providers[0].provider) || window.ethereum;
const providerName = (item: { info?: { name?: string } } | null | undefined) => item && item.info && item.info.name ? item.info.name : 'Browser wallet';
const selectedProviderId = () => localStorage.getItem(PROVIDER_KEY);

function addProvider(detail: ProviderDetail | null | undefined): void {
  if (!detail || !detail.provider) return;
  const id = detail.info && detail.info.uuid ? detail.info.uuid : providerName(detail) + '-' + providers.length;
  if (providers.some(item => item.id === id || item.provider === detail.provider)) return;
  providers.push({ id, info: detail.info || {}, provider: detail.provider });
  // When a provider was previously selected, only it may become active —
  // announcement order is arbitrary, and restoring from whichever wallet
  // announces first can surface an account the user never connected here.
  const stored = selectedProviderId();
  if (stored ? stored === id : !activeProvider) activeProvider = detail.provider;
  if (stored === id && localStorage.getItem(STORAGE_KEY) !== '1') restoreAccount();
  render();
}

function discoverProviders(): void {
  window.addEventListener('eip6963:announceProvider', event => addProvider(event.detail));
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  if (window.ethereum) addProvider({ info: { name: 'Browser wallet' }, provider: window.ethereum });
}

function setAccount(next: string | null | undefined): void {
  account = next || null;
  status = 'idle';
  closeMenu();
  render();
  if (onChange) onChange(account);
}

function setStatus(next: string): void {
  status = next;
  render();
  clearTimeout(statusTimer);
  if (next === 'error') {
    statusTimer = setTimeout(() => {
      status = 'idle';
      render();
    }, 2200);
  }
}

function render(): void {
  if (!button) return;
  button.classList.remove('connected', 'error', 'connecting');
  if (account) {
    button.textContent = short(account);
    button.classList.add('connected');
    button.title = 'Connected wallet: ' + account;
    button.setAttribute('aria-label', 'Wallet ' + short(account));
  } else if (status === 'connecting') {
    button.textContent = 'Connecting…';
    button.classList.add('connecting');
    button.title = 'Waiting for wallet approval';
    button.setAttribute('aria-label', 'Connecting wallet');
  } else if (status === 'error') {
    button.textContent = provider() ? 'Wallet rejected' : 'No wallet found';
    button.classList.add('error');
    button.title = provider() ? 'Wallet connection was not approved' : 'Install or enable an Ethereum wallet extension';
    button.setAttribute('aria-label', button.textContent || '');
  } else {
    button.textContent = 'Connect wallet';
    button.title = provider() ? 'Connect wallet' : 'No wallet provider found';
    button.setAttribute('aria-label', 'Connect wallet');
  }
}

function closeMenu(): void {
  if (menu) menu.classList.remove('show');
}

function renderPactMenu(): string {
  if (!pacts) return '<div class="wallet-menu-note">Loading issuances…</div>';
  const activeOffering = String(currentOfferingAddress() || '').toLowerCase();
  const activeMark = '<span class="wallet-menu-check active" aria-label="Selected"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></span>';
  const inactiveMark = '<span class="wallet-menu-check" aria-hidden="true"></span>';
  const rows = pacts.length
    ? pacts.map(pact => `<a href="${statusPath(pact.offering)}"><span>${esc(pact.projectName) || 'Untitled issuance'}</span>${pact.offering.toLowerCase() === activeOffering ? activeMark : inactiveMark}</a>`).join('')
    : '<div class="wallet-menu-note">No issuances yet</div>';
  const newLink = currentCreatePage() ? '' : `<a href="${createPath()}" class="wallet-menu-action">+ New issuance</a>`;
  return `<div class="wallet-menu-group"><div class="wallet-menu-label">Your issuances</div>${rows}${newLink}</div>`;
}

function renderPurchaseMenu(): string {
  if (!purchases) return '<div class="wallet-menu-group"><div class="wallet-menu-label">Your purchases</div><div class="wallet-menu-note">Loading purchases…</div></div>';
  const activeOffering = String(currentOfferingAddress() || '').toLowerCase();
  const activeMark = '<span class="wallet-menu-check active" aria-label="Selected"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></span>';
  const inactiveMark = '<span class="wallet-menu-check" aria-hidden="true"></span>';
  if (!purchases.length) return '';
  const rows = purchases.map(purchase => {
    const name = purchase.record && purchase.record.projectName;
    return `<a href="${buyPath(purchase.offering)}"><span>${esc(name) || 'Untitled purchase'}</span>${purchase.offering.toLowerCase() === activeOffering ? activeMark : inactiveMark}</a>`;
  }).join('');
  return `<div class="wallet-menu-group"><div class="wallet-menu-label">Your purchases</div>${rows}</div>`;
}

function renderMenu(): void {
  if (!menu) return;
  if (account) {
    menu.innerHTML = '<div class="wallet-menu-group"><div class="wallet-menu-label">Options</div><button type="button" data-wallet-action="copy-address">Copy address</button><button type="button" data-wallet-action="disconnect">Disconnect</button></div>' + renderPactMenu() + renderPurchaseMenu();
    return;
  }
  menu.innerHTML = '';
  for (const item of providers) {
    const option = document.createElement('button');
    option.type = 'button';
    option.setAttribute('data-wallet-id', item.id);
    option.textContent = providerName(item);
    menu.appendChild(option);
  }
}

async function loadWalletRecords(): Promise<void> {
  if (!account) {
    pacts = [];
    purchases = [];
    return;
  }
  pacts = null;
  purchases = null;
  renderMenu();
  try {
    const offerings = await listOfferings();
    const wallet = String(account).toLowerCase();
    pacts = offerings.filter(r => r.issuer.toLowerCase() === wallet || r.treasury.toLowerCase() === wallet);
    purchases = await listPurchases({ wallet: account, offerings });
  } catch (err) {
    pacts = pacts || [];
    purchases = purchases || [];
  }
  renderMenu();
}

function toggleMenu(): void {
  if (!menu) return;
  renderMenu();
  menu.classList.toggle('show');
  if (account && menu.classList.contains('show')) loadWalletRecords();
}

async function copyAddress(): Promise<void> {
  if (!account) return;
  try {
    await navigator.clipboard.writeText(account);
    closeMenu();
    showToast('Address copied');
  } catch (err) {
    showToast('Could not copy address');
  }
}

async function prompt(): Promise<string | null> {
  if (account) return account;
  if (providers.length > 1) {
    toggleMenu();
    return null;
  }
  try {
    return await connect();
  } catch (err) {
    setStatus('error');
    throw err;
  }
}

async function restoreAccount(): Promise<void> {
  if (!provider() || localStorage.getItem(STORAGE_KEY) === '1') return;
  try {
    const accounts = await provider()!.request({ method: 'eth_accounts' });
    if (accounts && accounts[0]) setAccount(accounts[0]);
  } catch (err) {}
}

async function connect(nextProvider?: Eip1193Provider, providerId?: string): Promise<string | null> {
  if (nextProvider) activeProvider = nextProvider;
  if (!provider()) throw new Error('No wallet provider found.');
  setStatus('connecting');
  const accounts = await provider()!.request({ method: 'eth_requestAccounts' });
  localStorage.removeItem(STORAGE_KEY);
  const id = providerId || (providers.find(item => item.provider === provider()) || { id: undefined }).id;
  if (id) localStorage.setItem(PROVIDER_KEY, id);
  setAccount(accounts && accounts[0]);
  return account;
}

function disconnect(): void {
  localStorage.setItem(STORAGE_KEY, '1');
  setAccount(null);
}

async function init(options: InitOptions): Promise<string | null> {
  button = document.getElementById(options.buttonId);
  menu = document.createElement('div');
  menu.className = 'wallet-menu';
  menu.setAttribute('role', 'menu');
  button && button.insertAdjacentElement('afterend', menu);
  onChange = options.onChange || null;
  discoverProviders();
  render();

  if (button) {
    button.addEventListener('click', async () => {
      if (account) {
        toggleMenu();
        return;
      }
      if (providers.length > 1) {
        toggleMenu();
        return;
      }
      try {
        await connect();
      } catch (err) {
        setStatus('error');
        if (options.onError) options.onError(err);
      }
    });
  }

  if (menu) {
    menu.addEventListener('click', async e => {
      const target = e.target as HTMLElement;
      if (target.dataset.walletAction === 'copy-address') {
        await copyAddress();
        return;
      }
      if (target.dataset.walletAction === 'disconnect') {
        closeMenu();
        disconnect();
        return;
      }
      const item = providers.find(p => p.id === target.dataset.walletId);
      if (!item) return;
      closeMenu();
      try {
        await connect(item.provider, item.id);
      } catch (err) {
        setStatus('error');
        if (options.onError) options.onError(err);
      }
    });
  }

  document.addEventListener('click', e => {
    if (!menu || !button) return;
    if (button.contains(e.target as Node) || menu.contains(e.target as Node)) return;
    closeMenu();
  });

  if (provider()) {
    provider()!.on && provider()!.on!('accountsChanged', (accounts: string[]) => {
      if (!accounts || !accounts.length) {
        disconnect();
      } else if (localStorage.getItem(STORAGE_KEY) !== '1') {
        setAccount(accounts[0]);
      }
    });

    // With a stored provider selection, restoration waits for that provider's
    // EIP-6963 announcement (handled in addProvider) instead of asking
    // whichever provider happens to be active right now.
    if (!selectedProviderId() && localStorage.getItem(STORAGE_KEY) !== '1') {
      await restoreAccount();
    }
  }

  return account;
}

export const PactWallet = {
  init,
  connect,
  disconnect,
  prompt,
  get account() { return account; },
  get provider() { return provider(); },
  short,
};
