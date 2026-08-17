import type { Address } from "viem";
import { useAccount } from "wagmi";

// The connected account (or null), updating whenever the user connects,
// switches, or disconnects. Connection UI lives in components/wallet.tsx.
export function useWallet(): Address | null {
  return useAccount().address ?? null;
}
