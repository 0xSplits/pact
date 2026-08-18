// Base mainnet constants shared across the browser modules.
// `PACT_RPC_URL` is the e2e/manual override hook: set it on globalThis before
// any module loads (Playwright init script, console snippet) to point every
// read and receipt poll at a local anvil instead of public Base RPC.
// `VITE_ALCHEMY_API_KEY` is the build-time Alchemy key (domain-restrict it,
// it ships in the bundle); absent both, the rate-limited public RPC keeps
// zero-setup dev working. Optional-chained so the module also loads outside
// Vite (bare node, test runners) where import.meta.env may not exist.
// wagmi.ts turns this resolution into
// the app transport: override wins outright, otherwise Alchemy with the
// chain's public RPC as fallback.
import { parseUnits } from "viem";

export const BASE_CHAIN_ID = 8453;

// Reads an e2e/manual override set on globalThis before any module loads
// (Playwright init script, console snippet). The one sanctioned way to peek
// at those globals — see PACT_RPC_URL above and the factory overrides in
// offerings.ts/onchain.ts.
export const globalOverride = (name: string): unknown =>
  (globalThis as Record<string, unknown>)[name];

export const PACT_RPC_OVERRIDE: string | undefined =
  (globalOverride("PACT_RPC_URL") as string | undefined) || undefined;
const ALCHEMY_API_KEY = import.meta.env?.VITE_ALCHEMY_API_KEY;
export const ALCHEMY_RPC_URL: string | undefined = ALCHEMY_API_KEY
  ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
  : undefined;

export const BASE_USDC_ADDRESS =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const USDC_DECIMALS = 6;

// Dollar input → USDC base units, exactly. `toFixed` first: it rounds away
// float noise (0.29*1e6 is 289999.99…) and never emits scientific notation,
// so parseUnits sees a plain decimal string and the math stays in bigint.
export function toUsdcBaseUnits(dollars: number | string): bigint {
  const n = Number(dollars);
  if (!Number.isFinite(n) || n < 0) return 0n;
  return parseUnits(n.toFixed(USDC_DECIMALS), USDC_DECIMALS);
}
