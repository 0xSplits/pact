// Glue shared by every command group: the typed vars schema, the
// throw-to-error bridge for guardrail failures, and the generic call encoder.
import { z } from "incur";
import { OFFERING_ABI } from "splits-pact/generated/offering-contracts.ts";
import { encodeFunctionData } from "viem";
import type { Abi, Address } from "viem";

import type { PactContext } from "#pact/context.ts";
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
