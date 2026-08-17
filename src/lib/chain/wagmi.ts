// The shared wagmi config: connector discovery (EIP-6963 + injected),
// WalletConnect for extension-less buyers when configured, and the app's
// RPC transport. Only detected wallets ever reach the menu — the Splits
// Connect extension announces itself over EIP-6963 like any other. Framework-free — onchain.ts drives reads and transactions
// through wagmi/actions against this config; React only adds hooks on top.
//
// The chain object is viem's stock `base`, whose default RPC is the public
// one — wagmi uses chain metadata for wallet_addEthereumChain, so a keyed
// Alchemy URL never enters a wallet; only our own transport uses it. The
// PACT_RPC_OVERRIDE (e2e) bypasses the fallback entirely so tests always
// talk to their anvil.
import { base } from "viem/chains";
import { createConfig, fallback, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";

import { ALCHEMY_RPC_URL, PACT_RPC_OVERRIDE } from "#lib/chain/chain.ts";

const walletConnectProjectId: string | undefined = import.meta.env
  ?.VITE_WALLETCONNECT_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains: [base],
  connectors: [
    injected(),
    ...(walletConnectProjectId
      ? [walletConnect({ projectId: walletConnectProjectId })]
      : []),
  ],
  transports: {
    [base.id]: PACT_RPC_OVERRIDE
      ? http(PACT_RPC_OVERRIDE)
      : ALCHEMY_RPC_URL
        ? fallback([http(ALCHEMY_RPC_URL), http()])
        : http(),
  },
});
