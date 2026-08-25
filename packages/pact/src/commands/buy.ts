import { Cli, z } from "incur";
import { OFFERING_ABI } from "splits-pact/generated/offering-contracts.ts";
import { BASE_USDC_ADDRESS } from "splits-pact/lib/chain/chain.ts";
import {
  decodeVoucherFragment,
  signClaim,
} from "splits-pact/lib/chain/voucher.ts";
import { erc20Abi } from "viem";
import type { Address } from "viem";

import { EXAMPLE_OFFERING, offeringCall, VARS } from "#pact/commands/shared.ts";
import type { PactContext } from "#pact/context.ts";
import { address, parseUsdc, units, usdc, usdcAmount } from "#pact/format.ts";
import { quote } from "#pact/reads.ts";
import {
  approveCall,
  assertFactoryChild,
  runWrite,
  WRITE_OPTIONS,
  WRITE_OUTPUT,
  WriteError,
} from "#pact/writes.ts";

const BUY_OPTIONS = WRITE_OPTIONS.extend({
  maxCost: usdcAmount
    .optional()
    .describe(
      "Slippage bound in USDC; defaults to the exact quote at send time",
    ),
  name: z
    .string()
    .default("")
    .describe(
      "Buyer name emitted onchain (public, permanent); empty to stay anonymous",
    ),
});

const BUY_OUTPUT = WRITE_OUTPUT.extend({
  units: z.number(),
  cost: z
    .string()
    .describe(
      "Quoted USDC cost; the approve is for --max-cost, which defaults to this",
    ),
});

// The unsigned-mode preflight cannot see the allowance the approve will grant,
// so a missing USDC balance would hide behind the same TransferFromFailed.
async function assertUsdcBalance(
  ctx: PactContext,
  from: Address,
  cost: bigint,
) {
  const balance = await ctx.client.readContract({
    address: BASE_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [from],
  });
  if (balance < cost)
    throw new WriteError(
      "INSUFFICIENT_USDC",
      `${from} holds ${usdc(balance)} USDC, below the ${usdc(cost)} quote; nothing sent`,
    );
}

// Claim links are passed whole: https://pact.splits.org/buy?offering=0x…#<fragment>.
// A bare fragment needs --offering.
function parseClaimLink(link: string, fallbackOffering?: string) {
  const hashIndex = link.indexOf("#");
  const fragment = hashIndex >= 0 ? link.slice(hashIndex + 1) : link;
  let offering = fallbackOffering;
  if (hashIndex >= 0 && link.includes("?")) {
    try {
      offering = new URL(link).searchParams.get("offering") ?? offering;
    } catch {
      // Not an absolute URL; the fragment alone still decodes.
    }
  }
  return { fragment, offering };
}

export const buy = Cli.create("buy", {
  description:
    "Buy units: approve exact USDC, then buyPublic or claim a private allocation",
  vars: VARS,
})
  .command("public", {
    description:
      "Buy from the public tranche. Two transactions: USDC.approve(offering, cost) then buyPublic",
    args: z.object({
      offering: address,
      units: units.min(1).describe("Units to buy"),
    }),
    options: BUY_OPTIONS,
    output: BUY_OUTPUT,
    destructive: true,
    examples: [
      {
        args: {
          offering: EXAMPLE_OFFERING,
          units: 5,
        },
        options: { maxCost: "1250" },
      },
    ],
    async run(c) {
      const ctx = c.var.pact;
      // ponytail: runWrite scans again; one extra filtered getLogs beats a
      // confusing read failure on a foreign address.
      await assertFactoryChild(ctx, c.args.offering);
      const cost = await quote(ctx.client, c.args.offering, c.args.units);
      const maxCost = c.options.maxCost ? parseUsdc(c.options.maxCost) : cost;
      if (cost > maxCost)
        return c.error({
          code: "QUOTE_ABOVE_MAX",
          message: `Quote ${usdc(cost)} USDC exceeds --max-cost ${usdc(maxCost)}; nothing sent`,
          exitCode: 1,
        });
      const from = ctx.account?.address ?? c.options.from;
      if (from) await assertUsdcBalance(ctx, from, maxCost);
      const result = await runWrite(ctx, {
        offering: c.args.offering,
        calls: [
          approveCall(c.args.offering, maxCost),
          {
            ...offeringCall(c.args.offering, "buyPublic", [
              BigInt(c.args.units),
              maxCost,
              c.options.name,
            ]),
            afterApprove: true,
          },
        ],
        options: c.options,
      });
      return c.ok(
        { ...result, units: c.args.units, cost: usdc(cost) },
        {
          cta: {
            commands: [
              {
                command: `offering get ${c.args.offering}`,
                description: "Confirm the new curve position",
              },
            ],
          },
        },
      );
    },
  })
  .command("private", {
    description:
      "Claim a private allocation link. The link key in the fragment signs the buyer; then USDC.approve + buyPrivate",
    args: z.object({
      link: z
        .string()
        .describe(
          "The whole claim link (or just its #fragment with --offering)",
        ),
      units: units
        .min(1)
        .describe("Units to buy; cost must fit the allocation's USDC cap"),
    }),
    options: BUY_OPTIONS.extend({
      offering: address
        .optional()
        .describe("Offering address when passing a bare fragment"),
    }),
    output: BUY_OUTPUT.extend({
      allocationId: z.string(),
      amountCap: z.string(),
    }),
    destructive: true,
    examples: [
      {
        args: {
          link: "https://pact.splits.org/buy?offering=0x…#<fragment>",
          units: 3,
        },
        description: "Claim 3 units with the link the issuer shared",
      },
    ],
    async run(c) {
      const ctx = c.var.pact;
      const { fragment, offering } = parseClaimLink(
        c.args.link,
        c.options.offering,
      );
      if (!offering)
        return c.error({
          code: "NO_OFFERING",
          message: "The link carries no ?offering=; pass --offering",
        });
      const offeringAddress = address.parse(offering);
      await assertFactoryChild(ctx, offeringAddress);
      const decoded = decodeVoucherFragment(fragment);
      const buyer = ctx.account?.address ?? c.options.from;
      if (!buyer)
        return c.error({
          code: "NO_SENDER",
          message:
            "Set PACT_PRIVATE_KEY, or --from <buyer> for the unsigned claim",
        });
      const consumed = await ctx.client.readContract({
        address: offeringAddress,
        abi: OFFERING_ABI,
        functionName: "allocationConsumed",
        args: [decoded.voucher.allocationId],
      });
      if (consumed)
        return c.error({
          code: "ALLOCATION_CONSUMED",
          message: "This allocation was already claimed or cancelled",
          exitCode: 1,
        });
      const cost = await quote(ctx.client, offeringAddress, c.args.units);
      if (cost > decoded.voucher.amountCapUsdc)
        return c.error({
          code: "ABOVE_ALLOCATION_CAP",
          message: `Quote ${usdc(cost)} USDC exceeds the allocation cap ${usdc(decoded.voucher.amountCapUsdc)}`,
          exitCode: 1,
        });
      const maxCost = c.options.maxCost ? parseUsdc(c.options.maxCost) : cost;
      if (cost > maxCost)
        return c.error({
          code: "QUOTE_ABOVE_MAX",
          message: `Quote ${usdc(cost)} USDC exceeds --max-cost`,
          exitCode: 1,
        });
      const claimSig = await signClaim({
        linkPrivateKey: decoded.linkPrivateKey,
        offering: offeringAddress,
        chainId: ctx.chainId,
        allocationId: decoded.voucher.allocationId,
        buyer,
      });
      const voucher = {
        allocationId: decoded.voucher.allocationId,
        buyerName: decoded.voucher.buyerName,
        amountCapUsdc: decoded.voucher.amountCapUsdc,
        linkKey: decoded.voucher.linkKey,
      };
      await assertUsdcBalance(ctx, buyer, maxCost);
      const result = await runWrite(ctx, {
        offering: offeringAddress,
        calls: [
          approveCall(offeringAddress, maxCost),
          {
            ...offeringCall(
              offeringAddress,
              "buyPrivate",
              [
                voucher,
                decoded.ownerSig,
                claimSig,
                BigInt(c.args.units),
                maxCost,
              ],
              `Offering.buyPrivate(${voucher.allocationId}, ${c.args.units} units)`,
            ),
            afterApprove: true,
          },
        ],
        options: c.options,
      });
      return c.ok(
        {
          ...result,
          units: c.args.units,
          cost: usdc(cost),
          allocationId: voucher.allocationId,
          amountCap: usdc(voucher.amountCapUsdc),
        },
        {
          cta: {
            commands: [
              {
                command: `offering get ${offeringAddress}`,
                description: "Confirm the claim landed",
              },
            ],
          },
        },
      );
    },
  });
