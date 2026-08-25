// The one mount path every page entry uses: chrome, StrictMode, error
// boundary, provider stack. Kept apart from the component files so they stay
// pure component modules (Fast Refresh boundaries).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, StrictMode } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";

import { WalletButton } from "#components/wallet.tsx";
import { wagmiConfig } from "#lib/chain/wagmi.ts";

const queryClient = new QueryClient();

// Shared page chrome: PACT wordmark home link on the left, wallet control on
// the right. Injected here so the HTML shells stay minimal.
function injectChrome() {
  // Home is served both as "/" and "/index.html"; treat either as already-home
  // so the wordmark is inert there rather than reloading the page.
  const onHome =
    location.pathname === "/" || location.pathname === "/index.html";
  const brand = document.createElement("a");
  brand.className = "top-brand";
  brand.href = "/";
  brand.textContent = "PACT";
  if (onHome) brand.dataset.inert = "true";
  brand.addEventListener("click", (event) => {
    if (onHome) event.preventDefault();
  });
  const controls = document.createElement("div");
  controls.className = "top-controls";
  controls.innerHTML =
    '<span id="walletMount" style="display:contents"></span>';
  document.body.prepend(brand);
  document.body.prepend(controls);
}

// Without a boundary a render throw unmounts the whole tree, leaving a blank
// page with the failure visible only in the console.
class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="paper px-10 py-12 sm:px-16 sm:py-16">
          <h1 className="text-2xl font-bold">Something went wrong</h1>
          <p className="mt-4 text-sm t-muted">{this.state.error.message}</p>
          <p className="mt-4 text-sm">
            Reload the page to try again. Onchain state is unaffected.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppProviders({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
        {createPortal(
          <WalletButton />,
          document.getElementById("walletMount")!,
        )}
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export function mountPage(app: ReactNode) {
  injectChrome();
  createRoot(document.getElementById("app")!).render(
    <StrictMode>
      <RootErrorBoundary>
        <AppProviders>{app}</AppProviders>
      </RootErrorBoundary>
    </StrictMode>,
  );
}
