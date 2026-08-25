// The one path every write takes. Guardrails are not optional and not
// configurable: the target must be a child of the pinned factory, every
// transaction is eth_call-simulated before anything is signed, and a failed
// simulation aborts the whole sequence with the decoded revert. Without an
// operator key (or with --dry-run) the result is the unsigned transaction
// list for an external signer; with one, transactions are sent in order,
// each after one confirmation, and their decoded events come back.
import { Errors, z } from "incur";
import {
  OFFERING_ABI,
  OFFERING_FACTORY_ABI,
  PACT_TOKEN_ABI,
} from "splits-pact/generated/offering-contracts.ts";
import { BASE_USDC_ADDRESS } from "splits-pact/lib/chain/chain.ts";
import {
  decodeErrorResult,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  parseEventLogs,
} from "viem";
import type { Abi, Address, Hex } from "viem";

import type { PactContext } from "#pact/context.ts";
import { address, jsonSafe } from "#pact/format.ts";
import { findFactoryChild } from "#pact/reads.ts";

export interface Call {
  to: Address;
  data: Hex;
  value?: bigint;
  description: string;
  // True for the buy that follows an approve in the same sequence: in
  // unsigned mode the allowance is not there yet, so a bare
  // TransferFromFailed from USDC is the expected simulation outcome.
  afterApprove?: boolean;
}

export const WRITE_OPTIONS = z.object({
  dryRun: z
    .boolean()
    .default(false)
    .describe("Simulate and return the unsigned transactions without sending"),
  from: address
    .optional()
    .describe(
      "Sender for the simulation and unsigned transactions; required without PACT_PRIVATE_KEY",
    ),
});

const PREFLIGHT = z.object({
  description: z.string(),
  ok: z.boolean(),
  note: z.string().optional(),
});
export const WRITE_OUTPUT = z.object({
  mode: z.enum(["unsigned", "sent"]),
  chainId: z.number(),
  from: z.string(),
  preflight: z.array(PREFLIGHT),
  transactions: z
    .array(
      z.object({
        to: z.string(),
        data: z.string(),
        value: z.string(),
        chainId: z.number(),
        description: z.string(),
      }),
    )
    .optional()
    .describe("Unsigned mode: sign and send these in order"),
  sent: z
    .array(
      z.object({
        description: z.string(),
        hash: z.string(),
        blockNumber: z.number(),
        events: z.array(
          z.object({ name: z.string(), args: z.record(z.string(), z.any()) }),
        ),
      }),
    )
    .optional()
    .describe("Key mode: confirmed transactions with decoded events"),
});
export type WriteOutput = z.output<typeof WRITE_OUTPUT>;

// Thrown, not returned: a guardrail failure must surface as a non-zero exit
// even when a command spreads the write result into its own output.
export class WriteError extends Errors.IncurError {
  constructor(code: string, message: string) {
    super({ code, message, exitCode: 1 });
  }
}

const ALL_ABI: Abi = [
  ...OFFERING_ABI,
  ...OFFERING_FACTORY_ABI,
  ...PACT_TOKEN_ABI,
  ...erc20Abi,
  // Solady SafeTransferLib errors are library-level and absent from the ABIs.
  ...parseAbi([
    "error TransferFromFailed()",
    "error TransferFailed()",
    "error ETHTransferFailed()",
  ]),
];

export function describeRevert(error: unknown): string {
  let data: Hex | undefined;
  for (
    let e = error as { data?: unknown; cause?: unknown } | undefined;
    e;
    e = e.cause as typeof e
  ) {
    const d = e.data;
    if (typeof d === "string" && d.startsWith("0x") && d.length > 2) {
      data = d as Hex;
      break;
    }
    if (
      d &&
      typeof d === "object" &&
      typeof (d as { data?: unknown }).data === "string"
    ) {
      data = (d as { data: Hex }).data;
      break;
    }
  }
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi: ALL_ABI, data });
      return `${decoded.errorName}(${(decoded.args ?? []).map(String).join(", ")})`;
    } catch {
      return `revert ${data}`;
    }
  }
  const e = error as { shortMessage?: string; message?: string };
  return e.shortMessage ?? e.message ?? String(error);
}

export const approveCall = (offering: Address, amount: bigint): Call => ({
  to: BASE_USDC_ADDRESS,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [offering, amount],
  }),
  description: `USDC.approve(${offering}, ${amount})`,
});

export interface WriteRequest {
  // The offering the sequence targets; verified against the factory scan
  // before anything else happens. Omit for the factory itself.
  offering?: Address;
  calls: Call[];
  options: z.output<typeof WRITE_OPTIONS>;
}

export async function assertFactoryChild(
  ctx: PactContext,
  offering: Address,
): Promise<void> {
  if (!(await findFactoryChild(ctx, offering)))
    throw new WriteError(
      "NOT_A_PACT_OFFERING",
      `${offering} was not created by factory ${ctx.factory} on chain ${ctx.chainId}; refusing to touch it`,
    );
}

export async function runWrite(
  ctx: PactContext,
  { offering, calls, options }: WriteRequest,
): Promise<WriteOutput> {
  if (offering) await assertFactoryChild(ctx, offering);
  const from = ctx.account?.address ?? options.from;
  if (!from)
    throw new WriteError(
      "NO_SENDER",
      "Set PACT_PRIVATE_KEY to send, or pass --from <address> to simulate and get unsigned transactions",
    );
  const sendMode = !!ctx.account && !!ctx.sender && !options.dryRun;

  const preflight: z.output<typeof PREFLIGHT>[] = [];
  const simulate = async (call: Call) => {
    try {
      await ctx.client.call({
        account: from,
        to: call.to,
        data: call.data,
        value: call.value ?? 0n,
      });
      preflight.push({ description: call.description, ok: true });
    } catch (error) {
      const revert = describeRevert(error);
      if (!sendMode && call.afterApprove && revert === "TransferFromFailed()") {
        preflight.push({
          description: call.description,
          ok: true,
          note: "USDC allowance is granted by the preceding approve; simulated without it",
        });
        return;
      }
      preflight.push({
        description: call.description,
        ok: false,
        note: revert,
      });
      throw new WriteError(
        "PREFLIGHT_FAILED",
        `${call.description} would revert: ${revert}. Nothing was sent.`,
      );
    }
  };

  if (!sendMode) {
    for (const call of calls) await simulate(call);
    return {
      mode: "unsigned",
      chainId: ctx.chainId,
      from,
      preflight,
      transactions: calls.map((call) => ({
        to: call.to,
        data: call.data,
        value: String(call.value ?? 0n),
        chainId: ctx.chainId,
        description: call.description,
      })),
    };
  }

  const sent: NonNullable<WriteOutput["sent"]> = [];
  for (const call of calls) {
    try {
      await simulate(call);
    } catch (error) {
      if (error instanceof WriteError && sent.length)
        error.message = error.message.replace(
          "Nothing was sent.",
          `Already sent: ${sent.map((s) => s.hash).join(", ")}.`,
        );
      throw error;
    }
    const hash = await ctx.sender!.sendTransaction({
      to: call.to,
      data: call.data,
      value: call.value ?? 0n,
    });
    const receipt = await ctx.client.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });
    if (receipt.status !== "success")
      throw new WriteError(
        "REVERTED",
        `${call.description} reverted onchain: ${hash}`,
      );
    sent.push({
      description: call.description,
      hash,
      blockNumber: Number(receipt.blockNumber),
      events: parseEventLogs({ abi: ALL_ABI, logs: receipt.logs }).map(
        (log) => ({
          name: log.eventName,
          args: jsonSafe(log.args ?? {}) as Record<string, unknown>,
        }),
      ),
    });
  }
  return { mode: "sent", chainId: ctx.chainId, from, preflight, sent };
}
