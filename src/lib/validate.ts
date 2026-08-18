// Input shape checks shared across the browser modules. Non-strict on
// purpose: mixed-case input with a wrong EIP-55 checksum is accepted, matching
// the regex this replaced; strict rejection would be a UX-visible change.
import { isAddress as viemIsAddress } from "viem";
import type { Address } from "viem";

export function isAddress(value: unknown): value is Address {
  return (
    typeof value === "string" && viemIsAddress(value.trim(), { strict: false })
  );
}

// Case-insensitive address equality; false when either side is missing.
export const isSameAddress = (
  a: string | null | undefined,
  b: string | null | undefined,
): boolean => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
