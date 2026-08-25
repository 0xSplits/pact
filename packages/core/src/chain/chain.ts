// Base mainnet constants shared by the app and the CLI.
import { parseUnits } from "viem";

export const BASE_CHAIN_ID = 8453;

// Reads an e2e/manual override set on globalThis before any module loads
// (Playwright init script, console snippet): PACT_RPC_URL below and the
// factory overrides in the app's offerings.ts/onchain.ts. The one sanctioned
// way to peek at those globals.
export const globalOverride = (name: string): unknown =>
  (globalThis as Record<string, unknown>)[name];

// Points every read and receipt poll at a local anvil instead of public
// Base RPC; the app's wagmi.ts turns it into the transport.
export const PACT_RPC_OVERRIDE: string | undefined =
  (globalOverride("PACT_RPC_URL") as string | undefined) || undefined;

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
