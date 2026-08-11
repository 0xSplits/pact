// Shared display formatting helpers for the buy and status pages.
export function fmtMoney(n) {
  const value = Number(n) || 0;
  const hasCents = Math.abs(value - Math.round(value)) > 0.000001 || (value > 0 && value < 1);
  return '$' + value.toLocaleString('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

export const fmtDollars = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtPct = n => (Number(n) || 0).toFixed(1) + '%';
export const fmtTokens = n => Math.round(n).toLocaleString('en-US');
export const fmtPrice = p => '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
export const usdcBaseUnitsToDollars = n => Number(n || 0) / 1000000;
export const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const shortAddr = a => a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : (a || '');
export const basescanTx = hash => 'https://basescan.org/tx/' + encodeURIComponent(hash);
export const basescanAddress = address => 'https://basescan.org/address/' + encodeURIComponent(address);
