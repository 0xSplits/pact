import { useAccount } from 'wagmi';

// The connected account (or null), updating whenever the user connects,
// switches, or disconnects. Connection UI lives in components/wallet.tsx.
export function useWallet(): string | null {
  return useAccount().address ?? null;
}
