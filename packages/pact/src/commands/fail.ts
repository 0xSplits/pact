import { Cli, z } from "incur";

import {
  EXAMPLE_OFFERING,
  OFFERING,
  offeringCall,
  VARS,
} from "#pact/commands/shared.ts";
import { address } from "#pact/format.ts";
import { findFactoryChild, scanPurchases } from "#pact/reads.ts";
import { runWrite, WRITE_OPTIONS, WRITE_OUTPUT } from "#pact/writes.ts";

export const fail = Cli.create("fail", {
  description:
    "The failure path: mark failed, refund buyers, sweep escrowed units back to the founders",
  vars: VARS,
})
  .command("mark", {
    description:
      "Mark the offering failed (anyone; close date passed with the minimum unmet)",
    args: OFFERING,
    options: WRITE_OPTIONS,
    output: WRITE_OUTPUT,
    destructive: true,
    examples: [{ args: { offering: EXAMPLE_OFFERING } }],
    run: (c) =>
      runWrite(c.var.pact, {
        offering: c.args.offering,
        calls: [offeringCall(c.args.offering, "markFailed")],
        options: c.options,
      }),
  })
  .command("refund", {
    description:
      "Reclaim the sender's USDC deposit after failure; their full unit balance returns to escrow",
    args: OFFERING,
    options: WRITE_OPTIONS,
    output: WRITE_OUTPUT,
    destructive: true,
    examples: [{ args: { offering: EXAMPLE_OFFERING } }],
    run: (c) =>
      runWrite(c.var.pact, {
        offering: c.args.offering,
        calls: [offeringCall(c.args.offering, "refund")],
        options: c.options,
      }),
  })
  .command("refund-all", {
    description:
      "Owner: push refunds to buyers (default: everyone who bought). Buyers missing units are skipped",
    args: OFFERING,
    options: WRITE_OPTIONS.extend({
      buyers: z
        .string()
        .optional()
        .describe("Comma-separated buyer addresses; defaults to every buyer"),
    }),
    output: WRITE_OUTPUT.extend({ buyers: z.array(z.string()) }),
    destructive: true,
    examples: [
      {
        args: { offering: EXAMPLE_OFFERING },
        description: "Refund every buyer",
      },
    ],
    async run(c) {
      const ctx = c.var.pact;
      let buyers: string[];
      if (c.options.buyers)
        buyers = c.options.buyers
          .split(",")
          .map((b) => address.parse(b.trim()));
      else {
        const record = await findFactoryChild(ctx, c.args.offering);
        if (!record)
          return c.error({
            code: "NOT_A_PACT_OFFERING",
            message: `${c.args.offering} was not created by the pinned factory`,
            exitCode: 1,
          });
        buyers = [
          ...new Set(
            (await scanPurchases(ctx, record.offering, record.blockNumber)).map(
              (p) => p.buyer,
            ),
          ),
        ];
      }
      const result = await runWrite(ctx, {
        offering: c.args.offering,
        calls: [
          offeringCall(
            c.args.offering,
            "refundAll",
            [buyers],
            `Offering.refundAll(${buyers.length} buyers)`,
          ),
        ],
        options: c.options,
      });
      return { ...result, buyers };
    },
  })
  .command("sweep", {
    description:
      "Return escrow-held units (unsold + reclaimed) to the treasury after failure (anyone)",
    args: OFFERING,
    options: WRITE_OPTIONS,
    output: WRITE_OUTPUT,
    destructive: true,
    examples: [{ args: { offering: EXAMPLE_OFFERING } }],
    run: (c) =>
      runWrite(c.var.pact, {
        offering: c.args.offering,
        calls: [offeringCall(c.args.offering, "sweepFailedUnits")],
        options: c.options,
      }),
  });
