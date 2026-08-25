import { Cli, z } from "incur";
import { OFFERING_FACTORY_ABI } from "splits-pact/generated/offering-contracts.ts";
import { deriveOfferingCurve } from "splits-pact/lib/chain/curve.ts";
import {
  buildOfferingFactoryInputs,
  TOTAL_LIQUID_SPLIT_UNITS,
} from "splits-pact/lib/chain/liquid-split.ts";
import { getAddress } from "viem";
import type { Address } from "viem";

import { contractCall, VARS } from "#pact/commands/shared.ts";
import { address, parseUsdc, units, usdc, usdcAmount } from "#pact/format.ts";
import {
  capTable,
  findFactoryChild,
  quote,
  readOffering,
  scanOfferings,
  scanPurchases,
  serializeOffering,
} from "#pact/reads.ts";
import { runWrite, WRITE_OPTIONS, WRITE_OUTPUT } from "#pact/writes.ts";

const OFFERING = z.object({ offering: address.describe("Offering address") });

// "0xabc…:600,0xdef…:150" → founder rows.
function parseHolders(
  text: string,
): Array<{ address: Address; tokens: number }> {
  return text
    .split(",")
    .filter(Boolean)
    .map((pair) => {
      const [holder, count] = pair.split(":");
      const tokens = Number(count);
      if (!holder || !Number.isInteger(tokens) || tokens <= 0)
        throw new Error(`holder entry "${pair}" must be <address>:<units>`);
      return { address: getAddress(holder.trim()), tokens };
    });
}

export const offering = Cli.create("offering", {
  description: "Create, inspect, and list offerings",
  vars: VARS,
})
  .command("get", {
    description:
      "Live state of one offering: lifecycle, curve, tranches, proceeds",
    args: OFFERING,
    output: z.record(z.string(), z.any()),
    mcp: { annotations: { readOnlyHint: true } },
    examples: [
      { args: { offering: "0x1234567890abcdef1234567890abcdef12345678" } },
    ],
    async run(c) {
      const state = await readOffering(c.var.pact.client, c.args.offering);
      return c.ok(serializeOffering(state), {
        cta: {
          commands: [
            {
              command: `offering quote ${c.args.offering} 10`,
              description: "Price 10 units",
            },
            {
              command: `offering cap-table ${c.args.offering}`,
              description: "Who holds what",
            },
          ],
        },
      });
    },
  })
  .command("list", {
    description:
      "Every offering the pinned factory created (OfferingCreated scan)",
    output: z.object({ offerings: z.array(z.record(z.string(), z.any())) }),
    mcp: { annotations: { readOnlyHint: true } },
    async run(c) {
      const offerings = await scanOfferings(c.var.pact);
      return c.ok(
        { offerings },
        {
          cta: {
            commands: offerings.slice(0, 3).map((o) => ({
              command: `offering get ${o.offering}`,
              description: o.projectName,
            })),
          },
        },
      );
    },
  })
  .command("quote", {
    description: "Cost of buying units from the current curve position",
    args: OFFERING.extend({ units: units.min(1).describe("Units to price") }),
    output: z.object({
      units: z.number(),
      cost: z.string().describe("USDC"),
      unitsSold: z.number(),
      availablePublicUnits: z.number(),
      availablePrivateUnits: z.number(),
      phase: z.string(),
    }),
    mcp: { annotations: { readOnlyHint: true } },
    async run(c) {
      const state = serializeOffering(
        await readOffering(c.var.pact.client, c.args.offering),
      );
      const cost = await quote(
        c.var.pact.client,
        c.args.offering,
        c.args.units,
      );
      return c.ok(
        {
          units: c.args.units,
          cost: usdc(cost),
          unitsSold: state.unitsSold,
          availablePublicUnits: state.availablePublicUnits,
          availablePrivateUnits: state.availablePrivateUnits,
          phase: state.phase,
        },
        {
          cta: {
            commands: [
              {
                command: `buy public ${c.args.offering} ${c.args.units} --max-cost ${usdc(cost)}`,
                description: "Buy at this quote",
              },
            ],
          },
        },
      );
    },
  })
  .command("cap-table", {
    description:
      "Current holders of the offering's PactToken, plus its purchases",
    args: OFFERING,
    output: z.object({
      pactToken: z.string(),
      holders: z.array(z.record(z.string(), z.any())),
      purchases: z.array(z.record(z.string(), z.any())),
    }),
    mcp: { annotations: { readOnlyHint: true } },
    async run(c) {
      const record = await findFactoryChild(c.var.pact, c.args.offering);
      if (!record)
        return c.error({
          code: "NOT_A_PACT_OFFERING",
          message: `${c.args.offering} was not created by the pinned factory`,
        });
      const [holders, purchases] = await Promise.all([
        capTable(
          c.var.pact,
          record.pactToken,
          record.offering,
          record.blockNumber,
        ),
        scanPurchases(c.var.pact, record.offering, record.blockNumber),
      ]);
      return { pactToken: record.pactToken, holders, purchases };
    },
  })
  .command("create", {
    description:
      "Deploy a new Offering + PactToken pair through the factory. Founders keep the units not offered; the rest is escrowed for sale along the curve",
    options: WRITE_OPTIONS.extend({
      name: z.string().min(1).describe("Project name (stored onchain)"),
      raiseMin: usdcAmount.describe(
        "Minimum raise in USDC; unmet by the close date means refunds",
      ),
      closeDays: z.coerce
        .number()
        .int()
        .min(1)
        .default(30)
        .describe("Days until the close date"),
      floor: usdcAmount.describe(
        "Valuation (USD) at which the first unit sells",
      ),
      ceiling: usdcAmount.describe(
        "Valuation (USD) at which the last offered unit sells",
      ),
      publicUnits: units.describe("Units buyable without a voucher"),
      holders: z
        .string()
        .describe(
          "Founder allocations as <address>:<units>,…; the remainder up to 1000 is offered",
        ),
      treasury: address
        .optional()
        .describe("Receives proceeds; defaults to --owner"),
      owner: address
        .optional()
        .describe("Administers and signs vouchers; defaults to the signer"),
    }),
    output: WRITE_OUTPUT.extend({
      offering: z.string().optional(),
      pactToken: z.string().optional(),
      curve: z.object({ priceStart: z.string(), priceSlope: z.string() }),
      offeringUnits: z.number(),
    }),
    destructive: true,
    examples: [
      {
        options: {
          name: "Acme",
          raiseMin: "5000",
          floor: "1000000",
          ceiling: "2000000",
          publicUnits: 50,
          holders: "0x1234567890abcdef1234567890abcdef12345678:900",
        },
        description:
          "Offer 100 units (10%) between a $1M and $2M valuation, half of it public",
      },
    ],
    async run(c) {
      const ctx = c.var.pact;
      const owner = c.options.owner ?? ctx.account?.address ?? c.options.from;
      if (!owner)
        return c.error({
          code: "NO_OWNER",
          message: "Pass --owner, or set PACT_PRIVATE_KEY / --from",
        });
      const treasury = c.options.treasury ?? owner;
      const holders = parseHolders(c.options.holders);
      const offeringUnits =
        TOTAL_LIQUID_SPLIT_UNITS -
        holders.reduce((sum, h) => sum + h.tokens, 0);
      const inputs = buildOfferingFactoryInputs({
        holders,
        newMoney: { tokens: offeringUnits },
      });
      const curve = deriveOfferingCurve({
        valuation: {
          floor: Number(c.options.floor),
          ceiling: Number(c.options.ceiling),
        },
        newMoney: { tokens: offeringUnits },
      });
      if (!curve)
        return c.error({
          code: "BAD_CURVE",
          message:
            "floor must be > 0, ceiling >= floor, and at least one unit offered",
        });
      if (c.options.publicUnits > offeringUnits)
        return c.error({
          code: "BAD_TRANCHE",
          message: `publicUnits exceeds the ${offeringUnits} offered units`,
        });
      const closeDate = BigInt(
        Math.floor(Date.now() / 1000) + c.options.closeDays * 86400,
      );
      const call = contractCall(
        ctx.factory,
        OFFERING_FACTORY_ABI,
        "createOffering",
        [
          c.options.name,
          parseUsdc(c.options.raiseMin),
          closeDate,
          curve.priceStart,
          curve.priceSlope,
          BigInt(c.options.publicUnits),
          treasury,
          owner,
          inputs.holderAccounts,
          inputs.holderAllocations,
          inputs.offeringUnits,
        ],
        `OfferingFactory.createOffering("${c.options.name}")`,
      );
      const result = await runWrite(ctx, { calls: [call], options: c.options });
      const created = result.sent?.[0]?.events.find(
        (e) => e.name === "OfferingCreated",
      );
      const base = {
        ...result,
        curve: {
          priceStart: usdc(curve.priceStart),
          priceSlope: usdc(curve.priceSlope),
        },
        offeringUnits,
      };
      if (!created) return base;
      const offeringAddress = String(created.args.offering);
      return c.ok(
        {
          ...base,
          offering: offeringAddress,
          pactToken: String(created.args.pactToken),
        },
        {
          cta: {
            commands: [
              {
                command: `offering get ${offeringAddress}`,
                description: "Read the new offering",
              },
            ],
          },
        },
      );
    },
  });
