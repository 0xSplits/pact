// Input shape checks shared across the browser modules.
import type { Address } from "viem";

export function isAddress(value: unknown): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

// Case-insensitive address equality; false when either side is missing.
export const isSameAddress = (
  a: string | null | undefined,
  b: string | null | undefined,
): boolean => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
