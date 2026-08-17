// The one mount path every page entry uses: chrome, StrictMode, error
// boundary, provider stack. Kept apart from the component files so they stay
// pure component modules (Fast Refresh boundaries).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, StrictMode } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "#lib/chain/wagmi.ts";
import { injectChrome } from "#lib/ui/chrome.ts";

import { WalletButton } from "./wallet.tsx";

const queryClient = new QueryClient();

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
        <div className="paper px-10 py-12 sm:px-14 sm:py-16">
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
