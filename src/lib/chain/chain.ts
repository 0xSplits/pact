// Base mainnet constants shared across the browser modules.
// `PACT_RPC_URL` is the e2e/manual override hook: set it on globalThis before
// any module loads (Playwright init script, console snippet) to point every
// read and receipt poll at a local anvil instead of public Base RPC.
// `VITE_ALCHEMY_API_KEY` is the build-time Alchemy key (domain-restrict it,
// it ships in the bundle); absent both, the rate-limited public RPC keeps
// zero-setup dev working. Optional-chained because node:test runs this file
// where import.meta.env doesn't exist. wagmi.ts turns this resolution into
// the app transport: override wins outright, otherwise Alchemy with the
// chain's public RPC as fallback.
export const BASE_CHAIN_ID = 8453;
export const PACT_RPC_OVERRIDE: string | undefined =
  (globalThis as Record<string, any>).PACT_RPC_URL || undefined;
const ALCHEMY_API_KEY = import.meta.env?.VITE_ALCHEMY_API_KEY;
export const ALCHEMY_RPC_URL: string | undefined =
  ALCHEMY_API_KEY ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : undefined;

export const LIQUID_SPLIT_FACTORY_ADDRESS = '0xdEcd8B99b7F763e16141450DAa5EA414B7994831';
export const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
export const USDC_SCALE = 1000000;

export function toUsdcBaseUnits(dollars: number | string): number {
  const n = Number(dollars);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n * USDC_SCALE);
}
