// Tolerant parsing for client-supplied JSON values.
export function parseAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function parsePositiveInteger(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export function parseNonnegativeInteger(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
