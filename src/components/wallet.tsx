// The wallet button + menu in the fixed top-right chrome, plus the provider
// stack every page mounts. Connection state lives in wagmi; this component
// renders it into the same #walletToggle / .wallet-menu markup the CSS and
// e2e selectors already target.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { WagmiProvider, useAccount, useConnect, useDisconnect } from 'wagmi';
import type { Connector } from 'wagmi';
import { wagmiConfig } from '../lib/chain/wagmi.ts';
import { listOfferings, listPurchases } from '../lib/chain/offerings.ts';
import type { OfferingRecord, Purchase } from '../lib/chain/onchain.ts';
import {
  buyPath, createPath, currentBuyPage, currentCreatePage,
  currentOfferingAddress, currentStatusPage, statusPath,
} from '../lib/routes.ts';
import { showToast } from '../lib/ui/toast.ts';

const queryClient = new QueryClient();

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
        {createPortal(<WalletButton />, document.getElementById('walletMount')!)}
      </QueryClientProvider>
    </WagmiProvider>
  );
}

const short = (address: string) => address.slice(0, 6) + '…' + address.slice(-4);

// EIP-6963-announced wallets appear as their own connectors (id = rdns), so
// the generic window.ethereum fallback is redundant next to them — and dead
// weight when no injected provider exists at all.
function visibleConnectors(connectors: readonly Connector[]): Connector[] {
  const announced = connectors.some(c => c.type === 'injected' && c.id !== 'injected');
  return connectors.filter(c =>
    c.id !== 'injected' || (!announced && !!(window as { ethereum?: unknown }).ethereum));
}

function MenuCheck({ active }: { active: boolean }) {
  if (!active) return <span className="wallet-menu-check" aria-hidden="true"></span>;
  return (
    <span className="wallet-menu-check active" aria-label="Selected">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>
    </span>
  );
}

function WalletRecordGroups() {
  const account = useAccount().address ?? null;
  const { data } = useQuery({
    queryKey: ['wallet-records', account ? account.toLowerCase() : null],
    enabled: !!account,
    queryFn: async () => {
      try {
        const offerings = await listOfferings();
        const wallet = String(account).toLowerCase();
        const mine = offerings.filter(r => r.issuer.toLowerCase() === wallet || r.treasury.toLowerCase() === wallet);
        const bought = await listPurchases({ wallet: account!, offerings });
        const purchases = Array.from(new Map(
          bought.map(purchase => [purchase.offering.toLowerCase(), purchase]),
        ).values());
        return { pacts: mine, purchases };
      } catch (err) {
        // Scan failures degrade to empty groups rather than a stuck loader.
        return { pacts: [] as OfferingRecord[], purchases: [] as Array<Purchase & { record: OfferingRecord }> };
      }
    },
  });
  const pacts = data ? data.pacts : null;
  const purchases = data ? data.purchases : null;

  const activeOffering = String(currentOfferingAddress() || '').toLowerCase();
  const viewingIssuance = currentStatusPage();
  const viewingPurchase = currentBuyPage();
  return (
    <>
      <div className="wallet-menu-group">
        <div className="wallet-menu-label">Your issuances</div>
        {!pacts && <div className="wallet-menu-note">Loading issuances…</div>}
        {pacts && !pacts.length && <div className="wallet-menu-note">No issuances yet</div>}
        {pacts && pacts.map(pact => (
          <a key={pact.offering} href={statusPath(pact.offering)}>
            <span>{pact.projectName || 'Untitled issuance'}</span>
            <MenuCheck active={viewingIssuance && pact.offering.toLowerCase() === activeOffering} />
          </a>
        ))}
        {!currentCreatePage() && <a href={createPath()} className="wallet-menu-action">+ New issuance</a>}
      </div>
      {(!purchases || purchases.length > 0) && (
        <div className="wallet-menu-group">
          <div className="wallet-menu-label">Your purchases</div>
          {!purchases && <div className="wallet-menu-note">Loading purchases…</div>}
          {purchases && purchases.map(purchase => (
            <a key={purchase.offering} href={buyPath(purchase.offering)}>
              <span>{(purchase.record && purchase.record.projectName) || 'Untitled purchase'}</span>
              <MenuCheck active={viewingPurchase && purchase.offering.toLowerCase() === activeOffering} />
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function WalletButton() {
  const account = useAccount().address ?? null;
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 2200);
    return () => clearTimeout(timer);
  }, [error]);

  const options = visibleConnectors(connectors);

  async function handleConnect(connector: Connector) {
    setOpen(false);
    try {
      await connectAsync({ connector });
    } catch (err) {
      setError('Wallet rejected');
      showToast('Could not connect wallet.');
    }
  }

  function handleToggle() {
    if (account) {
      setOpen(current => !current);
      return;
    }
    if (!options.length) {
      setError('No wallet found');
      return;
    }
    setOpen(current => !current);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(account!);
      setOpen(false);
      showToast('Address copied');
    } catch (err) {
      showToast('Could not copy address');
    }
  }

  const label = account ? short(account)
    : isPending ? 'Connecting…'
    : error ? error
    : 'Connect wallet';
  const title = account ? 'Connected wallet: ' + account
    : isPending ? 'Waiting for wallet approval'
    : error === 'No wallet found' ? 'Install or enable an Ethereum wallet extension'
    : error ? 'Wallet connection was not approved'
    : 'Connect wallet';
  const stateClass = account ? ' connected' : isPending ? ' connecting' : error ? ' error' : '';

  return (
    <span ref={containerRef} style={{ display: 'contents' }}>
      <button id="walletToggle" className={'wallet-toggle' + stateClass} type="button" title={title}
        aria-label={account ? 'Wallet ' + short(account) : label} onClick={handleToggle}>
        {label}
      </button>
      <div className={'wallet-menu' + (open ? ' show' : '')} role="menu">
        {open && !account && options.map(connector => (
          <button key={connector.uid} type="button" onClick={() => handleConnect(connector)}>
            {connector.name}
          </button>
        ))}
        {open && account && (
          <>
            <div className="wallet-menu-group">
              <div className="wallet-menu-label">Options</div>
              <button type="button" onClick={handleCopy}>Copy address</button>
              <button type="button" onClick={() => { setOpen(false); disconnect(); }}>Disconnect</button>
            </div>
            <WalletRecordGroups />
          </>
        )}
      </div>
    </span>
  );
}
