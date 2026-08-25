import { Cli, z } from "incur";
import { PACT_TOKEN_ABI } from "splits-pact/generated/offering-contracts.ts";
import { BASE_USDC_ADDRESS } from "splits-pact/lib/chain/chain.ts";

import {
  contractCall,
  offeringCall,
  VARS,
  ZERO_ADDRESS,
} from "#pact/commands/shared.ts";
import { address } from "#pact/format.ts";
import { capTable, findFactoryChild } from "#pact/reads.ts";
import { runWrite, WRITE_OPTIONS, WRITE_OUTPUT } from "#pact/writes.ts";

const OFFERING = z.object({ offering: address });

export const funds = Cli.create("funds", {
  description:
    "Move proceeds: withdraw, close, distribute revenue, skim excess USDC, rescue strays",
  vars: VARS,
})
  .command("withdraw", {
    description:
      "Send claimable proceeds to the treasury (permissionless once the minimum is met)",
    args: OFFERING,
    options: WRITE_OPTIONS,
    output: WRITE_OUTPUT,
    destructive: true,
    run: (c) =>
      runWrite(c.var.pact, {
        offering: c.args.offering,
        calls: [offeringCall(c.args.offering, "withdraw")],
        options: c.options,
      }),
  })
  .command("close", {
    description:
      "Owner: end the sale, withdraw remaining proceeds, return unsold units to the treasury (closeAndWithdraw)",
    args: OFFERING,
    options: WRITE_OPTIONS,
    output: WRITE_OUTPUT,
    destructive: true,
    run: (c) =>
      runWrite(c.var.pact, {
        offering: c.args.offering,
        calls: [offeringCall(c.args.offering, "closeAndWithdraw")],
        options: c.options,
      }),
  })
  .command("distribute", {
    description:
      "Distribute revenue held by the PactToken to every holder (blocked while Funding)",
    args: OFFERING,
    options: WRITE_OPTIONS.extend({
      token: z
        .string()
        .default("usdc")
        .describe("ERC-20 address, 'usdc', or 'eth'"),
      distributor: address
        .optional()
        .describe(
          "Receives the distributor fee, if any; defaults to the sender",
        ),
    }),
    output: WRITE_OUTPUT.extend({ accounts: z.array(z.string()) }),
    destructive: true,
    async run(c) {
      const ctx = c.var.pact;
      const record = await findFactoryChild(ctx, c.args.offering);
      if (!record)
        return c.error({
          code: "NOT_A_PACT_OFFERING",
          message: `${c.args.offering} was not created by the pinned factory`,
          exitCode: 1,
        });
      const token =
        c.options.token === "usdc"
          ? BASE_USDC_ADDRESS
          : c.options.token === "eth"
            ? ZERO_ADDRESS
            : address.parse(c.options.token);
      const holders = await capTable(
        ctx,
        record.pactToken,
        record.offering,
        record.blockNumber,
      );
      // LiquidSplit requires every current holder, ascending, no duplicates.
      const accounts = holders
        .map((h) => h.holder)
        .sort((a, b) => (a.toLowerCase() > b.toLowerCase() ? 1 : -1));
      const distributor =
        c.options.distributor ??
        ctx.account?.address ??
        c.options.from ??
        ZERO_ADDRESS;
      const result = await runWrite(ctx, {
        offering: c.args.offering,
        calls: [
          contractCall(
            record.pactToken,
            PACT_TOKEN_ABI,
            "distributeFunds",
            [token, accounts, distributor],
            `PactToken.distributeFunds(${token}, ${accounts.length} holders)`,
          ),
        ],
        options: c.options,
      });
      return { ...result, accounts };
    },
  })
  .command("skim", {
    description:
      "Owner: sweep USDC above buyer liability (e.g. split revenue pushed to the escrow) to the treasury",
    args: OFFERING,
    options: WRITE_OPTIONS,
    output: WRITE_OUTPUT,
    destructive: true,
    run: (c) =>
      runWrite(c.var.pact, {
        offering: c.args.offering,
        calls: [offeringCall(c.args.offering, "sweepExcessUsdc")],
        options: c.options,
      }),
  })
  .command("rescue", {
    description:
      "Owner: recover a stray token (or ETH with --token eth) from the escrow",
    args: OFFERING,
    options: WRITE_OPTIONS.extend({
      token: z.string().describe("ERC-20 address or 'eth'"),
      to: address.describe("Recipient"),
    }),
    output: WRITE_OUTPUT,
    destructive: true,
    run: (c) => {
      const token =
        c.options.token === "eth"
          ? ZERO_ADDRESS
          : address.parse(c.options.token);
      return runWrite(c.var.pact, {
        offering: c.args.offering,
        calls: [offeringCall(c.args.offering, "rescue", [token, c.options.to])],
        options: c.options,
      });
    },
  });
