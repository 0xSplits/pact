import assert from "node:assert/strict";

import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  recoverAddress,
} from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { test } from "vitest";

import { BASE_USDC_ADDRESS } from "#core/chain/chain.ts";
import type { OfferingRecord } from "#core/chain/reads.ts";
import { claimDigest } from "#core/chain/voucher.ts";
import {
  approveCall,
  contractCall,
  offeringCall,
  pactTokenCall,
  planBuy,
  withSlippage,
} from "#core/chain/writes.ts";
import {
  OFFERING_ABI,
  PACT_TOKEN_ABI,
} from "#core/generated/offering-contracts.ts";

const OFFERING = getAddress("0x" + "aa".repeat(20));
const PACT_TOKEN = getAddress("0x" + "bb".repeat(20));
const BUYER = getAddress("0x" + "dd".repeat(20));
const record: OfferingRecord = {
  offering: OFFERING,
  pactToken: PACT_TOKEN,
  issuer: BUYER,
  treasury: BUYER,
  projectName: "Acme",
  raiseMin: 0n,
  closeDate: 0,
  priceStart: 0n,
  priceSlope: 0n,
  publicUnits: 0,
  blockNumber: 1,
  transactionHash: ("0x" + "11".repeat(32)) as Hex,
  logIndex: 0,
};

const decodeOffering = (data: Hex) =>
  decodeFunctionData({ abi: OFFERING_ABI, data });

test("encoders produce calldata for the named function with a default description", () => {
  const call = offeringCall(OFFERING, "setPublicUnits", [12n]);
  assert.equal(call.to, OFFERING);
  assert.deepEqual(decodeOffering(call.data), {
    functionName: "setPublicUnits",
    args: [12n],
  });
  assert.equal(call.description, "Offering.setPublicUnits(12)");
  assert.equal(
    offeringCall(OFFERING, "withdraw").description,
    "Offering.withdraw()",
  );

  const distribute = pactTokenCall(PACT_TOKEN, "distributeFunds", [
    BASE_USDC_ADDRESS,
    [BUYER],
    BUYER,
  ]);
  assert.equal(distribute.to, PACT_TOKEN);
  assert.equal(
    decodeFunctionData({ abi: PACT_TOKEN_ABI, data: distribute.data })
      .functionName,
    "distributeFunds",
  );
  assert.deepEqual(
    contractCall(OFFERING, OFFERING_ABI, "refund", [], "custom"),
    { ...offeringCall(OFFERING, "refund"), description: "custom" },
  );
});

test("approveCall targets USDC with the exact amount", () => {
  const call = approveCall(OFFERING, 250n);
  assert.equal(call.to, BASE_USDC_ADDRESS);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: call.data }), {
    functionName: "approve",
    args: [OFFERING, 250n],
  });
});

test("withSlippage adds 1% and never rounds the buffer to zero", () => {
  assert.equal(withSlippage(10_000n), 10_100n);
  assert.equal(withSlippage(1n), 2n);
  assert.equal(withSlippage(0n), 0n);
});

test("planBuy: approve for maxCost then buyPublic marked afterApprove", async () => {
  const calls = await planBuy({
    record,
    units: 5,
    cost: 100n,
    maxCost: 101n,
    buyer: BUYER,
    buyerName: "Ada",
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], approveCall(OFFERING, 101n));
  assert.equal(calls[1]!.afterApprove, true);
  assert.deepEqual(decodeOffering(calls[1]!.data), {
    functionName: "buyPublic",
    args: [5n, 101n, "Ada"],
  });
});

test("planBuy omits the approve only when the allowance covers maxCost", async () => {
  const input = { record, units: 5, cost: 100n, maxCost: 101n, buyer: BUYER };
  assert.equal((await planBuy({ ...input, allowance: 101n })).length, 1);
  assert.equal((await planBuy({ ...input, allowance: 100n })).length, 2);
  assert.equal((await planBuy({ ...input, allowance: 0n })).length, 2);
});

test("planBuy rejects a quote above maxCost before planning anything", async () => {
  await assert.rejects(
    planBuy({ record, units: 5, cost: 102n, maxCost: 101n, buyer: BUYER }),
    /exceeds the maximum cost/,
  );
});

test("planBuy claim: signs the buyer with the link key and enforces the cap", async () => {
  const linkPrivateKey = ("0x" + "02".repeat(32)) as Hex;
  const linkKey = privateKeyToAccount(linkPrivateKey).address;
  const voucher = {
    allocationId: keccak256(linkKey),
    buyerName: "Golden Buyer",
    amountCapUsdc: 250n,
    linkKey,
  };
  const ownerSig = ("0x" + "ab".repeat(65)) as Hex;
  const claim = {
    voucher: { voucher, ownerSig, linkPrivateKey },
    chainId: 8453,
  };
  const calls = await planBuy({
    record,
    units: 3,
    cost: 200n,
    maxCost: 250n,
    buyer: BUYER,
    claim,
  });
  assert.equal(calls.length, 2);
  const decoded = decodeOffering(calls[1]!.data);
  assert.equal(decoded.functionName, "buyPrivate");
  const [v, sig, claimSig, units, maxCost] = decoded.args as [
    typeof voucher,
    Hex,
    Hex,
    bigint,
    bigint,
  ];
  assert.deepEqual(v, voucher);
  assert.equal(sig, ownerSig);
  assert.deepEqual([units, maxCost], [3n, 250n]);
  assert.equal(
    calls[1]!.description,
    `Offering.buyPrivate(${voucher.allocationId}, 3 units)`,
  );
  // The claim signature recovers to the link key over the buyer.
  const signer = await recoverAddress({
    hash: claimDigest({
      offering: OFFERING,
      chainId: 8453,
      allocationId: voucher.allocationId,
      buyer: BUYER as Address,
    }),
    signature: claimSig,
  });
  assert.equal(signer, linkKey);

  await assert.rejects(
    planBuy({
      record,
      units: 3,
      cost: 251n,
      maxCost: 300n,
      buyer: BUYER,
      claim,
    }),
    /exceeds the allocation cap/,
  );
});
