// Glue shared by every command group: the typed vars schema, common arg
// schemas, and the generic call encoder.
import { z } from "incur";
import { OFFERING_ABI } from "splits-pact/generated/offering-contracts.ts";
import { BASE_USDC_ADDRESS } from "splits-pact/lib/chain/chain.ts";
import { encodeFunctionData } from "viem";
import type { Abi, Address } from "viem";

import type { PactContext } from "#pact/context.ts";
import { address } from "#pact/format.ts";
import type { Call } from "#pact/writes.ts";

// incur seeds vars by parsing `{}` before middleware runs; `.catch` lets that
// pass while the root middleware always sets the real context before any run.
export const VARS = z.object({
  pact: z.custom<PactContext>().catch(undefined as unknown as PactContext),
});

export function contractCall(
  to: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  description: string,
): Call {
  return {
    to,
    data: encodeFunctionData({ abi, functionName, args } as Parameters<
      typeof encodeFunctionData
    >[0]),
    description,
  };
}

export const offeringCall = (
  offering: Address,
  functionName: string,
  args: readonly unknown[] = [],
  description = `Offering.${functionName}(${args.map(String).join(", ")})`,
): Call =>
  contractCall(offering, OFFERING_ABI, functionName, args, description);

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

export const OFFERING = z.object({
  offering: address.describe("Offering address"),
});

// "usdc", "eth", or an ERC-20 address.
export const parseToken = (token: string): Address =>
  token === "usdc"
    ? BASE_USDC_ADDRESS
    : token === "eth"
      ? ZERO_ADDRESS
      : address.parse(token);

export const EXAMPLE_OFFERING = "0x1234567890abcdef1234567890abcdef12345678";
