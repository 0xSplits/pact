// Base mainnet constants shared across the browser modules.
// `PACT_RPC_URL` is the e2e/manual override hook: set it on globalThis before
// any module loads (Playwright init script, console snippet) to point every
// read and receipt poll at a local anvil instead of public Base RPC.
// `VITE_ALCHEMY_API_KEY` is the build-time Alchemy key (domain-restrict it,
// it ships in the bundle); absent both, the rate-limited public RPC keeps
// zero-setup dev working. Optional-chained because node:test runs this file
// where import.meta.env doesn't exist.
export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_ID_HEX = '0x2105';
const ALCHEMY_API_KEY = import.meta.env?.VITE_ALCHEMY_API_KEY;
export const BASE_RPC_URL: string =
  (globalThis as Record<string, any>).PACT_RPC_URL ||
  (ALCHEMY_API_KEY ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : 'https://mainnet.base.org');
// Sent to wallets via wallet_addEthereumChain — always the public RPC, never
// BASE_RPC_URL, so a keyed provider URL is never registered into a wallet.
export const BASE_CHAIN_PARAMS = {
  chainId: BASE_CHAIN_ID_HEX,
  chainName: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://mainnet.base.org'],
  blockExplorerUrls: ['https://basescan.org'],
};

export const LIQUID_SPLIT_FACTORY_ADDRESS = '0xdEcd8B99b7F763e16141450DAa5EA414B7994831';
export const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_SCALE = 1000000;

export function toUsdcBaseUnits(dollars: number | string): number {
  const n = Number(dollars);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n * USDC_SCALE);
}
