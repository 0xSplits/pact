// Glue shared by every command group: the typed vars schema and common arg
// schemas.
import { BASE_USDC_ADDRESS } from "@splits/pact-core/chain/chain.ts";
import { z } from "incur";
import type { Address } from "viem";

import type { PactContext } from "#pact/context.ts";
import { address } from "#pact/format.ts";

// incur seeds vars by parsing `{}` before middleware runs; `.catch` lets that
// pass while the root middleware always sets the real context before any run.
export const VARS = z.object({
  pact: z.custom<PactContext>().catch(undefined as unknown as PactContext),
});

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
