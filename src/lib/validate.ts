// Input shape checks shared across the browser modules. Non-strict on
// purpose: EIP-55 checksum mistakes are accepted here (see
// docs/research/library-replacements.md for the strictness trade-off).
import { isHash, isAddress as viemIsAddress } from "viem";
import type { Address, Hex } from "viem";

export function isAddress(value: unknown): value is Address {
  return (
    typeof value === "string" && viemIsAddress(value.trim(), { strict: false })
  );
}

export function isTxHash(value: unknown): value is Hex {
  return typeof value === "string" && isHash(value.trim());
}

// Case-insensitive address equality; false when either side is missing.
export const isSameAddress = (
  a: string | null | undefined,
  b: string | null | undefined,
): boolean => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
