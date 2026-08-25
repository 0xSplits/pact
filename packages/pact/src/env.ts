// Configuration is env only, declared as an incur env schema so every
// variable shows up in `--help` and `--schema`.
import { BASE_CHAIN_ID } from "@splits/pact-core/chain/chain.ts";
import { z } from "incur";

export const ENV = z.object({
  PACT_RPC_URL: z
    .string()
    .default("https://mainnet.base.org")
    .describe("JSON-RPC endpoint; defaults to the public Base RPC"),
  PACT_CHAIN_ID: z.coerce
    .number()
    .int()
    .default(BASE_CHAIN_ID)
    .describe("Expected chain id; the CLI refuses to run if the RPC disagrees"),
  PACT_FACTORY_ADDRESS: z
    .string()
    .optional()
    .describe(
      "OfferingFactory address; defaults to the pinned Base deployment",
    ),
  PACT_FACTORY_DEPLOY_BLOCK: z.coerce
    .number()
    .int()
    .optional()
    .describe(
      "Lower bound for OfferingCreated scans; defaults to the pin's block, or 0 when the factory is overridden",
    ),
  PACT_PRIVATE_KEY: z
    .string()
    .optional()
    .describe(
      "Operator key (0x-hex). When set, writes are signed and sent; otherwise they return unsigned transactions",
    ),
  PACT_LEDGER_DIR: z
    .string()
    .optional()
    .describe("Voucher ledger directory; defaults to ~/.pact/ledger"),
});

export type Env = z.output<typeof ENV>;
