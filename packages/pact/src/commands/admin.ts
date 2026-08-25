import { Cli, z } from "incur";

import { offeringCall, VARS } from "#pact/commands/shared.ts";
import { address, units } from "#pact/format.ts";
import { runWrite, WRITE_OPTIONS, WRITE_OUTPUT } from "#pact/writes.ts";

const OFFERING = z.object({ offering: address });

export const admin = Cli.create("admin", {
  description: "Owner settings: tranche cap, treasury, ownership",
  vars: VARS,
})
  .command("set-public-units", {
    description:
      "Owner: move supply between tranches by changing the public cap",
    args: OFFERING.extend({ units: units.describe("New public cap") }),
    options: WRITE_OPTIONS,
    output: WRITE_OUTPUT,
    destructive: true,
    run: (c) =>
      runWrite(c.var.pact, {
        offering: c.args.offering,
        calls: [
          offeringCall(c.args.offering, "setPublicUnits", [
            BigInt(c.args.units),
          ]),
        ],
        options: c.options,
      }),
  })
  .command("set-treasury", {
    description: "Owner: change where proceeds and unsold units go",
    args: OFFERING.extend({ treasury: address }),
    options: WRITE_OPTIONS,
    output: WRITE_OUTPUT,
    destructive: true,
    run: (c) =>
      runWrite(c.var.pact, {
        offering: c.args.offering,
        calls: [
          offeringCall(c.args.offering, "setTreasury", [c.args.treasury]),
        ],
        options: c.options,
      }),
  })
  .command("transfer-ownership", {
    description:
      "Owner: hand the offering to a new owner immediately. Every unclaimed voucher link stops verifying",
    args: OFFERING.extend({ newOwner: address }),
    options: WRITE_OPTIONS,
    output: WRITE_OUTPUT,
    destructive: true,
    run: (c) =>
      runWrite(c.var.pact, {
        offering: c.args.offering,
        calls: [
          offeringCall(c.args.offering, "transferOwnership", [c.args.newOwner]),
        ],
        options: c.options,
      }),
  })
  .command("accept-ownership", {
    description:
      "Two-step handover: without --pending, the sender requests ownership (requestOwnershipHandover); with it, the current owner completes that request",
    args: OFFERING,
    options: WRITE_OPTIONS.extend({
      pending: address
        .optional()
        .describe("The requester to hand over to (owner side)"),
    }),
    output: WRITE_OUTPUT,
    destructive: true,
    run: (c) =>
      runWrite(c.var.pact, {
        offering: c.args.offering,
        calls: [
          c.options.pending
            ? offeringCall(c.args.offering, "completeOwnershipHandover", [
                c.options.pending,
              ])
            : offeringCall(c.args.offering, "requestOwnershipHandover"),
        ],
        options: c.options,
      }),
  });
