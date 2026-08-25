// Boundary conversions: USDC is a human decimal string on both sides of the
// CLI, units are plain integers, and anything else bigint becomes a string
// so incur can serialize it.
import { z } from "incur";
import { USDC_DECIMALS } from "splits-pact/lib/chain/chain.ts";
import { isAddress } from "splits-pact/lib/validate.ts";
import { formatUnits, getAddress, parseUnits } from "viem";
import type { Address } from "viem";

export const usdc = (base: bigint): string => formatUnits(base, USDC_DECIMALS);
export const parseUsdc = (amount: string): bigint =>
  parseUnits(amount, USDC_DECIMALS);

export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]),
    );
  return value;
}

export const address = z
  .string()
  .refine(isAddress, "must be a 0x-prefixed 20-byte address")
  .transform((value): Address => getAddress(value));

export const units = z.coerce
  .number()
  .int()
  .min(0)
  .max(1000)
  .describe("Whole cap-table units (1000 = 100%)");

export const usdcAmount = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, "USDC amount as a decimal string, e.g. 250.50");

export const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex value");
