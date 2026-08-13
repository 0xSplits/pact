// Input shape checks shared across the browser modules.
export function isAddress(value: unknown): value is string {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}

export function isTxHash(value: unknown): value is string {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || '').trim());
}
