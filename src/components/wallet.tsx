// The wallet button + menu in the fixed top-right chrome. Connection state
// lives in wagmi; this component renders it into the same #walletToggle /
// .wallet-menu markup the CSS and e2e selectors already target. mount.tsx
// portals <WalletButton /> into every page.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import type { Connector } from "wagmi";

import { loadWalletRecords } from "#lib/chain/offerings.ts";
import { shortAddr } from "#lib/format.ts";
import {
  buyPath,
  createPath,
  currentBuyPage,
  currentCreatePage,
  currentOfferingAddress,
  currentStatusPage,
  statusPath,
} from "#lib/routes.ts";
import { showToast } from "#lib/ui/toast.ts";
import { isSameAddress } from "#lib/validate.ts";

import { CheckIcon } from "./ui.tsx";

// The Splits Connect extension, keyed by its EIP-6963 rdns: pinned first when
// installed, offered as a Chrome Web Store link when not.
const SPLITS_CONNECT_ID = "org.splits.teams.connect";
const SPLITS_CONNECT_STORE_URL =
  "https://chromewebstore.google.com/detail/splits/ghfacfafnbcgkielpaeifdpoggfeakif";

// EIP-6963-announced wallets appear as their own connectors (id = rdns), so
// the generic window.ethereum fallback is redundant next to them — and dead
// weight when no injected provider exists at all.
function visibleConnectors(connectors: readonly Connector[]): Connector[] {
  const announced = connectors.some(
    (c) => c.type === "injected" && c.id !== "injected",
  );
  return connectors
    .filter(
      (c) =>
        c.id !== "injected" ||
        (!announced && !!(window as { ethereum?: unknown }).ethereum),
    )
    .sort(
      (a, b) =>
        Number(b.id === SPLITS_CONNECT_ID) - Number(a.id === SPLITS_CONNECT_ID),
    );
}

function MenuCheck({ active }: { active: boolean }) {
  if (!active)
    return <span className="wallet-menu-check" aria-hidden="true"></span>;
  return (
    <span className="wallet-menu-check active" aria-label="Selected">
      <CheckIcon />
    </span>
  );
}

function WalletRecordGroups() {
  const account = useAccount().address ?? null;
  const { data } = useQuery({
    queryKey: ["wallet-records", account ? account.toLowerCase() : null],
    enabled: !!account,
    queryFn: async () => {
      const { pacts, purchases } = await loadWalletRecords(account!);
      // One menu row per offering, however many purchases it holds.
      return {
        pacts,
        purchases: Array.from(
          new Map(
            purchases.map((purchase) => [
              purchase.offering.toLowerCase(),
              purchase,
            ]),
          ).values(),
        ),
      };
    },
  });
  const pacts = data ? data.pacts : null;
  const purchases = data ? data.purchases : null;

  const activeOffering = String(currentOfferingAddress() || "").toLowerCase();
  const viewingIssuance = currentStatusPage();
  const viewingPurchase = currentBuyPage();
  return (
    <>
      <div className="wallet-menu-group">
        <div className="wallet-menu-label">Your issuances</div>
        {!pacts && <div className="wallet-menu-note">Loading issuances…</div>}
        {pacts && !pacts.length && (
          <div className="wallet-menu-note">No issuances yet</div>
        )}
        {pacts &&
          pacts.map((pact) => (
            <a key={pact.offering} href={statusPath(pact.offering)}>
              <span>{pact.projectName || "Untitled issuance"}</span>
              <MenuCheck
                active={
                  viewingIssuance &&
                  isSameAddress(pact.offering, activeOffering)
                }
              />
            </a>
          ))}
        {!currentCreatePage() && (
          <a href={createPath()} className="wallet-menu-action">
            + New issuance
          </a>
        )}
      </div>
      {(!purchases || purchases.length > 0) && (
        <div className="wallet-menu-group">
          <div className="wallet-menu-label">Your purchases</div>
          {!purchases && (
            <div className="wallet-menu-note">Loading purchases…</div>
          )}
          {purchases &&
            purchases.map((purchase) => (
              <a key={purchase.offering} href={buyPath(purchase.offering)}>
                <span>
                  {(purchase.record && purchase.record.projectName) ||
                    "Untitled purchase"}
                </span>
                <MenuCheck
                  active={
                    viewingPurchase &&
                    isSameAddress(purchase.offering, activeOffering)
                  }
                />
              </a>
            ))}
        </div>
      )}
    </>
  );
}

export function WalletButton() {
  const account = useAccount().address ?? null;
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
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
    } catch {
      setError("Wallet rejected");
      showToast("Could not connect wallet.");
    }
  }

  function handleToggle() {
    setOpen((current) => !current);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(account!);
      setOpen(false);
      showToast("Address copied");
    } catch {
      showToast("Could not copy address");
    }
  }

  const label = account
    ? shortAddr(account)
    : isPending
      ? "Connecting…"
      : error
        ? error
        : "Connect wallet";
  const title = account
    ? "Connected wallet: " + account
    : isPending
      ? "Waiting for wallet approval"
      : error
        ? "Wallet connection was not approved"
        : "Connect wallet";
  const stateClass = account
    ? " connected"
    : isPending
      ? " connecting"
      : error
        ? " error"
        : "";

  return (
    <span ref={containerRef} style={{ display: "contents" }}>
      <button
        id="walletToggle"
        className={"wallet-toggle" + stateClass}
        type="button"
        title={title}
        aria-label={account ? "Wallet " + shortAddr(account) : label}
        onClick={handleToggle}
      >
        {label}
      </button>
      <div className={"wallet-menu" + (open ? " show" : "")} role="menu">
        {open && !account && (
          <>
            {options.map((connector) => (
              <button
                key={connector.uid}
                type="button"
                onClick={() => handleConnect(connector)}
              >
                {connector.name}
              </button>
            ))}
            {!options.some((c) => c.id === SPLITS_CONNECT_ID) && (
              <a
                href={SPLITS_CONNECT_STORE_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => setOpen(false)}
              >
                Splits
              </a>
            )}
          </>
        )}
        {open && account && (
          <>
            <div className="wallet-menu-group">
              <div className="wallet-menu-label">Options</div>
              <button type="button" onClick={handleCopy}>
                Copy address
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  disconnect();
                }}
              >
                Disconnect
              </button>
            </div>
            <WalletRecordGroups />
          </>
        )}
      </div>
    </span>
  );
}
