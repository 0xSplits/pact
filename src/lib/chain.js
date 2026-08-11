// Base mainnet constants shared by the browser modules and the server.
export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_ID_HEX = '0x2105';
export const BASE_RPC_URL = 'https://mainnet.base.org';
export const BASE_CHAIN_PARAMS = {
  chainId: BASE_CHAIN_ID_HEX,
  chainName: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: [BASE_RPC_URL],
  blockExplorerUrls: ['https://basescan.org'],
};

export const LIQUID_SPLIT_FACTORY_ADDRESS = '0xdEcd8B99b7F763e16141450DAa5EA414B7994831';
export const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_SCALE = 1000000;

export function toUsdcBaseUnits(dollars) {
  const n = Number(dollars);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n * USDC_SCALE);
}
