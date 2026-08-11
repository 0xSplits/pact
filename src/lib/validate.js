// Input shape checks shared by the browser modules and the server.
export function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}

export function isTxHash(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || '').trim());
}
