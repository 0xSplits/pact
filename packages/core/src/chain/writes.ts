// Transactions in calldata form. A `Call` is what both adapters send: the
// CLI simulates and relays it (or prints it unsigned), the app hands it to
// the wallet. Nothing here touches the chain; callers pass in the quote and
// allowance they read.
import { encodeFunctionData, erc20Abi } from "viem";
import type {
  Abi,
  Address,
  ContractFunctionArgs,
  ContractFunctionName,
  Hex,
} from "viem";

import { BASE_USDC_ADDRESS } from "#core/chain/chain.ts";
import type { OfferingRecord } from "#core/chain/reads.ts";
import { signClaim } from "#core/chain/voucher.ts";
import type { DecodedVoucherLink } from "#core/chain/voucher.ts";
import {
  OFFERING_ABI,
  PACT_TOKEN_ABI,
} from "#core/generated/offering-contracts.ts";

export interface Call {
  to: Address;
  data: Hex;
  value?: bigint;
  description: string;
  // True for the buy that follows an approve in the same sequence: simulated
  // alone the allowance is not there yet, so a bare TransferFromFailed from
  // USDC is the expected outcome.
  afterApprove?: boolean;
}

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

type OfferingWrite = ContractFunctionName<
  typeof OFFERING_ABI,
  "nonpayable" | "payable"
>;

export function offeringCall<name extends OfferingWrite>(
  offering: Address,
  functionName: name,
  args: ContractFunctionArgs<
    typeof OFFERING_ABI,
    "nonpayable" | "payable",
    name
  > = [] as never,
  description = `Offering.${functionName}(${(args as readonly unknown[]).map(String).join(", ")})`,
): Call {
  return contractCall(
    offering,
    OFFERING_ABI as Abi,
    functionName,
    args as readonly unknown[],
    description,
  );
}

export function pactTokenCall<
  name extends ContractFunctionName<
    typeof PACT_TOKEN_ABI,
    "nonpayable" | "payable"
  >,
>(
  pactToken: Address,
  functionName: name,
  args: ContractFunctionArgs<
    typeof PACT_TOKEN_ABI,
    "nonpayable" | "payable",
    name
  >,
  description = `PactToken.${functionName}(${(args as readonly unknown[]).map(String).join(", ")})`,
): Call {
  return contractCall(
    pactToken,
    PACT_TOKEN_ABI as Abi,
    functionName,
    args as readonly unknown[],
    description,
  );
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

// +1% headroom, ceil-divided so the buffer never rounds to zero. The app's
// slippage policy; the CLI defaults to the exact quote.
export const withSlippage = (cost: bigint): bigint =>
  (cost * 101n + 99n) / 100n;

export interface BuyPlanInput {
  // Proof the target is a factory child: only a factory scan yields one.
  record: OfferingRecord;
  units: number;
  // The live quote the caller obtained.
  cost: bigint;
  // Caller policy: the approve amount and the contract's slippage bound.
  maxCost: bigint;
  buyer: Address;
  buyerName?: string;
  // When supplied and >= maxCost, no approve call is planned.
  allowance?: bigint;
  // Private buy: the plan signs the claim with the link key.
  claim?: { voucher: DecodedVoucherLink; chainId: number };
}

// Invariants: the approve amount equals `maxCost`; the buy follows the approve
// and is marked `afterApprove`; the plan never inspects the chain. Async only
// for the claim signature. Throws when `cost` exceeds `maxCost` or, for a
// claim, the voucher's cap.
export async function planBuy({
  record,
  units,
  cost,
  maxCost,
  buyer,
  buyerName = "",
  allowance,
  claim,
}: BuyPlanInput): Promise<Call[]> {
  if (cost > maxCost)
    throw new Error(`Quote ${cost} exceeds the maximum cost ${maxCost}.`);
  const offering = record.offering;
  let buy: Call;
  if (claim) {
    const { voucher, ownerSig, linkPrivateKey } = claim.voucher;
    if (cost > voucher.amountCapUsdc)
      throw new Error(
        `Quote ${cost} exceeds the allocation cap ${voucher.amountCapUsdc}.`,
      );
    const claimSig = await signClaim({
      linkPrivateKey,
      offering,
      chainId: claim.chainId,
      allocationId: voucher.allocationId,
      buyer,
    });
    buy = offeringCall(
      offering,
      "buyPrivate",
      [
        {
          allocationId: voucher.allocationId,
          buyerName: voucher.buyerName,
          amountCapUsdc: voucher.amountCapUsdc,
          linkKey: voucher.linkKey,
        },
        ownerSig,
        claimSig,
        BigInt(units),
        maxCost,
      ],
      `Offering.buyPrivate(${voucher.allocationId}, ${units} units)`,
    );
  } else {
    buy = offeringCall(offering, "buyPublic", [
      BigInt(units),
      maxCost,
      buyerName,
    ]);
  }
  if (allowance != null && allowance >= maxCost) return [buy];
  return [approveCall(offering, maxCost), { ...buy, afterApprove: true }];
}
