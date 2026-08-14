// The shared wagmi config: connector discovery (EIP-6963 + injected),
// WalletConnect and Coinbase Wallet for extension-less buyers, and the app's
// RPC transport. Framework-free — onchain.ts drives transactions through
// wagmi/actions against this config; React only adds hooks on top.
//
// The chain object is viem's stock `base`, whose default RPC is the public
// one — wagmi uses chain metadata for wallet_addEthereumChain, so a keyed
// BASE_RPC_URL never enters a wallet; only our own transport uses it.
import { createConfig, http } from 'wagmi';
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors';
import { base } from 'viem/chains';
import { BASE_RPC_URL } from './chain.ts';

const walletConnectProjectId: string | undefined = import.meta.env?.VITE_WALLETCONNECT_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains: [base],
  connectors: [
    injected(),
    coinbaseWallet({ appName: 'PACT' }),
    ...(walletConnectProjectId ? [walletConnect({ projectId: walletConnectProjectId })] : []),
  ],
  transports: { [base.id]: http(BASE_RPC_URL) },
});
