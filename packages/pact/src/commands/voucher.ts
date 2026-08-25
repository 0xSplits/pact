// Issuer side of private allocations. Key mode signs the voucher in one
// step; unsigned mode splits it into `issue` (typed data + draft) and
// `complete` (verified signature + persisted link). The ledger file is the
// only record of an unclaimed link.
import { Cli, z } from "incur";
import { OFFERING_ABI } from "splits-pact/generated/offering-contracts.ts";
import {
  encodeVoucherFragment,
  listAllocationLedger,
  markAllocationLedgerRowRevoked,
  newAllocationKey,
  saveAllocationLedgerRow,
  voucherTypedData,
} from "splits-pact/lib/chain/voucher.ts";
import type {
  AllocationLedgerRow,
  Voucher,
} from "splits-pact/lib/chain/voucher.ts";
import { OG_SITE_ORIGIN } from "splits-pact/lib/og.ts";
import { buyLinkPath } from "splits-pact/lib/routes.ts";
import type { Address, Hex } from "viem";

import {
  EXAMPLE_OFFERING,
  OFFERING,
  offeringCall,
  VARS,
} from "#pact/commands/shared.ts";
import type { PactContext } from "#pact/context.ts";
import {
  bytes32,
  jsonSafe,
  parseUsdc,
  usdc,
  usdcAmount,
} from "#pact/format.ts";
import { readOffering } from "#pact/reads.ts";
import { runWrite, WRITE_OPTIONS, WRITE_OUTPUT } from "#pact/writes.ts";

interface Draft {
  offering: Address;
  chainId: number;
  voucher: Voucher & { amountCapUsdc: string };
  linkPrivateKey: Hex;
}
const encodeDraft = (draft: Draft) =>
  Buffer.from(JSON.stringify(draft)).toString("base64url");
const decodeDraft = (text: string): Draft =>
  JSON.parse(Buffer.from(text, "base64url").toString("utf8"));

function persistLink(
  ctx: Pick<PactContext, "ledger">,
  draft: Draft,
  ownerSig: Hex,
) {
  const fragment = encodeVoucherFragment({
    voucher: draft.voucher,
    ownerSig,
    linkPrivateKey: draft.linkPrivateKey,
  });
  const url = OG_SITE_ORIGIN + buyLinkPath(draft.offering, fragment);
  const row: AllocationLedgerRow = {
    allocationId: draft.voucher.allocationId,
    name: draft.voucher.buyerName,
    amountCapUsd: Number(usdc(BigInt(draft.voucher.amountCapUsdc))),
    link: url,
    createdAt: Date.now(),
  };
  saveAllocationLedgerRow(draft.offering, row, ctx.ledger);
  return {
    allocationId: row.allocationId,
    name: row.name,
    amountCap: usdc(BigInt(draft.voucher.amountCapUsdc)),
    link: url,
  };
}

const ISSUED = z.object({
  allocationId: z.string(),
  name: z.string(),
  amountCap: z.string(),
  link: z
    .string()
    .describe(
      "Share this claim link with the buyer; it is the only capability",
    ),
});

export const voucher = Cli.create("voucher", {
  description: "Issue, complete, inspect, and cancel private allocation links",
  vars: VARS,
})
  .command("issue", {
    description:
      "Create a private allocation. Key mode signs and returns the claim link; unsigned mode returns the EIP-712 typed data plus a draft for `voucher complete`",
    args: OFFERING,
    options: z.object({
      name: z
        .string()
        .min(1)
        .describe("Buyer's display name (emitted onchain at claim)"),
      cap: usdcAmount.describe("Maximum USDC the allocation may spend"),
    }),
    output: z.union([
      ISSUED.extend({ mode: z.literal("signed") }),
      z.object({
        mode: z.literal("unsigned"),
        owner: z.string(),
        typedData: z
          .record(z.string(), z.any())
          .describe("Sign with eth_signTypedData_v4 as the owner"),
        draft: z.string(),
      }),
    ]),
    destructive: true,
    examples: [
      {
        args: { offering: EXAMPLE_OFFERING },
        options: { name: "Ada", cap: "2500" },
      },
    ],
    async run(c) {
      const ctx = c.var.pact;
      const state = await readOffering(ctx.client, c.args.offering);
      const key = newAllocationKey();
      const draft: Draft = {
        offering: state.offering,
        chainId: ctx.chainId,
        voucher: {
          allocationId: key.allocationId,
          buyerName: c.options.name,
          amountCapUsdc: parseUsdc(c.options.cap).toString(),
          linkKey: key.linkKey,
        },
        linkPrivateKey: key.linkPrivateKey,
      };
      const typedData = voucherTypedData({
        offering: state.offering,
        chainId: ctx.chainId,
        voucher: draft.voucher,
      });
      if (ctx.account) {
        if (ctx.account.address.toLowerCase() !== state.owner.toLowerCase())
          return c.error({
            code: "NOT_OWNER",
            message: `Signer ${ctx.account.address} is not the owner ${state.owner}`,
            exitCode: 1,
          });
        const ownerSig = await ctx.account.signTypedData(typedData);
        return {
          mode: "signed" as const,
          ...persistLink(ctx, draft, ownerSig),
        };
      }
      const encoded = encodeDraft(draft);
      return c.ok(
        {
          mode: "unsigned" as const,
          owner: state.owner,
          typedData: jsonSafe(typedData) as Record<string, unknown>,
          draft: encoded,
        },
        {
          cta: {
            commands: [
              {
                command: `voucher complete ${encoded} <signature>`,
                description: "Finish with the owner's signature",
              },
            ],
          },
        },
      );
    },
  })
  .command("complete", {
    description:
      "Unsigned mode: verify the owner's signature over a draft and persist the claim link",
    args: z.object({
      draft: z.string().describe("The draft from `voucher issue`"),
      signature: z
        .string()
        .regex(/^0x[0-9a-fA-F]+$/)
        .describe("Owner signature over the typed data (EOA or ERC-1271)"),
    }),
    output: ISSUED,
    destructive: true,
    examples: [{ args: { draft: "<draft>", signature: "0x…" } }],
    async run(c) {
      const ctx = c.var.pact;
      const draft = decodeDraft(c.args.draft);
      if (draft.chainId !== ctx.chainId)
        return c.error({
          code: "CHAIN_MISMATCH",
          message: `Draft is for chain ${draft.chainId}`,
          exitCode: 1,
        });
      const state = await readOffering(ctx.client, draft.offering);
      const valid = await ctx.client.verifyTypedData({
        address: state.owner,
        signature: c.args.signature as Hex,
        ...voucherTypedData({
          offering: state.offering,
          chainId: ctx.chainId,
          voucher: draft.voucher,
        }),
      });
      if (!valid)
        return c.error({
          code: "INVALID_SIGNATURE",
          message: `Signature does not verify for owner ${state.owner}`,
          exitCode: 1,
        });
      return persistLink(ctx, draft, c.args.signature as Hex);
    },
  })
  .command("get", {
    description:
      "One allocation: onchain consumed flag plus the ledger row if this machine issued it",
    args: OFFERING.extend({ allocationId: bytes32 }),
    output: z.object({
      allocationId: z.string(),
      consumed: z.boolean(),
      ledger: z.record(z.string(), z.any()).nullable(),
    }),
    mcp: { annotations: { readOnlyHint: true } },
    examples: [
      {
        args: {
          offering: EXAMPLE_OFFERING,
          allocationId: "0x" + "ab".repeat(32),
        },
      },
    ],
    async run(c) {
      const consumed = await c.var.pact.client.readContract({
        address: c.args.offering,
        abi: OFFERING_ABI,
        functionName: "allocationConsumed",
        args: [c.args.allocationId as Hex],
      });
      const ledger = listAllocationLedger(
        c.args.offering,
        c.var.pact.ledger,
      ).find(
        (row) =>
          row.allocationId.toLowerCase() === c.args.allocationId.toLowerCase(),
      );
      return {
        allocationId: c.args.allocationId,
        consumed,
        ledger: ledger ?? null,
      };
    },
  })
  .command("list", {
    description:
      "Allocations this machine issued for an offering, with their onchain consumed flag",
    args: OFFERING,
    output: z.object({
      ledgerFile: z.string(),
      allocations: z.array(z.record(z.string(), z.any())),
    }),
    mcp: { annotations: { readOnlyHint: true } },
    examples: [{ args: { offering: EXAMPLE_OFFERING } }],
    async run(c) {
      const ctx = c.var.pact;
      const rows = listAllocationLedger(c.args.offering, ctx.ledger);
      const consumed = await Promise.all(
        rows.map((row) =>
          ctx.client.readContract({
            address: c.args.offering,
            abi: OFFERING_ABI,
            functionName: "allocationConsumed",
            args: [row.allocationId],
          }),
        ),
      );
      return {
        ledgerFile: `${ctx.ledgerDir}/${ctx.chainId}/${c.args.offering.toLowerCase()}.json`,
        allocations: rows.map((row, i) => ({ ...row, consumed: consumed[i] })),
      };
    },
  })
  .command("cancel", {
    description:
      "Owner: revoke an unclaimed allocation onchain (cancelAllocation). The ledger row is marked revoked only in key mode; after an unsigned relay, `voucher list` still shows the onchain consumed flag",
    args: OFFERING.extend({ allocationId: bytes32 }),
    options: WRITE_OPTIONS,
    output: WRITE_OUTPUT,
    destructive: true,
    examples: [
      {
        args: {
          offering: EXAMPLE_OFFERING,
          allocationId: "0x" + "ab".repeat(32),
        },
      },
    ],
    async run(c) {
      const ctx = c.var.pact;
      const result = await runWrite(ctx, {
        offering: c.args.offering,
        calls: [
          offeringCall(c.args.offering, "cancelAllocation", [
            c.args.allocationId as Hex,
          ]),
        ],
        options: c.options,
      });
      if (result.mode === "sent")
        markAllocationLedgerRowRevoked(
          c.args.offering,
          c.args.allocationId as Hex,
          Date.now(),
          ctx.ledger,
        );
      return result;
    },
  });
