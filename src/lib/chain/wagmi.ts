// The shared wagmi config: connector discovery (EIP-6963 + injected),
// WalletConnect and Coinbase Wallet for extension-less buyers, and the app's
// RPC transport. Framework-free — onchain.ts drives reads and transactions
// through wagmi/actions against this config; React only adds hooks on top.
//
// The chain object is viem's stock `base`, whose default RPC is the public
// one — wagmi uses chain metadata for wallet_addEthereumChain, so a keyed
// Alchemy URL never enters a wallet; only our own transport uses it. The
// PACT_RPC_OVERRIDE (e2e) bypasses the fallback entirely so tests always
// talk to their anvil.
import { createConfig, fallback, http } from 'wagmi';
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors';
import { base } from 'viem/chains';
import { ALCHEMY_RPC_URL, PACT_RPC_OVERRIDE } from './chain.ts';

const walletConnectProjectId: string | undefined = import.meta.env?.VITE_WALLETCONNECT_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains: [base],
  connectors: [
    injected(),
    coinbaseWallet({ appName: 'PACT' }),
    ...(walletConnectProjectId ? [walletConnect({ projectId: walletConnectProjectId })] : []),
  ],
  transports: {
    [base.id]: PACT_RPC_OVERRIDE
      ? http(PACT_RPC_OVERRIDE)
      : ALCHEMY_RPC_URL
        ? fallback([http(ALCHEMY_RPC_URL), http()])
        : http(),
  },
});
