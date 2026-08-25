// The command table over a fake chain: guardrails, both signing modes, and
// the unsigned output shape an external signer consumes.
import assert from "node:assert/strict";

import {
  OFFERING_ABI,
  OFFERING_FACTORY_ABI,
} from "splits-pact/generated/offering-contracts.ts";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  erc20Abi,
  getAddress,
} from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { test } from "vitest";

import { createCli } from "#pact/cli.ts";
import type { PactContext } from "#pact/context.ts";
import { describeRevert } from "#pact/writes.ts";

const FACTORY = getAddress("0x00000000000000000000000000000000000000fa");
const OFFERING = getAddress("0x00000000000000000000000000000000000000aa");
const PACT_TOKEN = getAddress("0x00000000000000000000000000000000000000bb");
const OWNER = getAddress("0x00000000000000000000000000000000000000cc");
const BUYER = getAddress("0x00000000000000000000000000000000000000dd");
const STRANGER = getAddress("0x00000000000000000000000000000000000000ee");
// anvil account 0
const KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const createdLog = (offering: Address) => ({
  address: FACTORY,
  blockNumber: 5n,
  transactionHash: "0x" + "11".repeat(32),
  logIndex: 0,
  blockHash: "0x" + "22".repeat(32),
  transactionIndex: 0,
  removed: false,
  topics: encodeEventTopics({
    abi: OFFERING_FACTORY_ABI,
    eventName: "OfferingCreated",
    args: { issuer: OWNER, treasury: OWNER, offering },
  }),
  data: encodeAbiParameters(
    [
      { type: "address" },
      { type: "string" },
      { type: "uint256" },
      { type: "uint64" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [
      PACT_TOKEN,
      "Acme",
      5_000_000_000n,
      2_000_000_000n,
      10_000_000n,
      1_000_000n,
      50n,
    ],
  ),
});

const OFFERING_VIEWS: Record<string, unknown> = {
  pactToken: PACT_TOKEN,
  owner: OWNER,
  treasury: OWNER,
  factory: FACTORY,
  state: 0,
  minMet: false,
  raiseMin: 5_000_000_000n,
  raised: 0n,
  withdrawn: 0n,
  closeDate: 2_000_000_000n,
  priceStart: 10_000_000n,
  priceSlope: 1_000_000n,
  unitsSold: 0n,
  remainingUnits: 100n,
  publicUnits: 50n,
  publicUnitsSold: 0n,
  quote: 21_000_000n,
  allocationConsumed: false,
};

interface Fake {
  ctx: PactContext;
  calls: Array<{ to: Address; data: Hex }>;
  sent: Array<{ to: Address; data: Hex }>;
}

function fake({
  chainId = 8453,
  key = false,
  revert,
}: {
  chainId?: number;
  key?: boolean;
  revert?: (to: Address, fn: string) => Hex | undefined;
} = {}): Fake {
  const calls: Fake["calls"] = [];
  const sent: Fake["sent"] = [];
  const functionOf = (to: Address, data: Hex) =>
    decodeFunctionData({ abi: to === OFFERING ? OFFERING_ABI : erc20Abi, data })
      .functionName;
  const ledger = new Map<string, string>();
  const account = key ? privateKeyToAccount(KEY) : null;
  const ctx: PactContext = {
    chainId: 8453,
    rpcUrl: "fake",
    factory: FACTORY,
    deployBlock: 0,
    ledgerDir: "/dev/null",
    ledger: {
      getItem: (k) => ledger.get(k) ?? null,
      setItem: (k, v) => void ledger.set(k, v),
    },
    account,
    sender: account
      ? {
          sendTransaction: async (tx) => (
            sent.push(tx),
            ("0x" + String(sent.length).padStart(64, "0")) as Hex
          ),
        }
      : null,
    client: {
      getChainId: async () => chainId,
      getBlockNumber: async () => 10n,
      readContract: async ({ functionName }: { functionName: string }) =>
        OFFERING_VIEWS[functionName],
      getLogs: async (request: { args?: { offering?: Address } }) =>
        !request.args?.offering || request.args.offering === OFFERING
          ? [createdLog(OFFERING)]
          : [],
      call: async ({ to, data }: { to: Address; data: Hex }) => {
        calls.push({ to, data });
        const fn = functionOf(to, data);
        const allowanceMissing =
          fn.startsWith("buy") && !sent.some((s) => s.to !== OFFERING);
        const revertData =
          revert?.(to, fn) ??
          (allowanceMissing
            ? encodeErrorResult({
                abi: [
                  { type: "error", name: "TransferFromFailed", inputs: [] },
                ],
                errorName: "TransferFromFailed",
              })
            : undefined);
        if (revertData)
          throw Object.assign(new Error("execution reverted"), {
            data: revertData,
          });
        return { data: "0x" };
      },
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({
        status: "success",
        blockNumber: 7n,
        logs: [],
        transactionHash: hash,
      }),
      verifyTypedData: async () => true,
    } as unknown as PactContext["client"],
  };
  return { ctx, calls, sent };
}

async function run(fakeChain: Fake, argv: string[]) {
  let out = "";
  let code: number | undefined;
  await createCli({ connect: () => fakeChain.ctx }).serve(
    [...argv, "--format", "json"],
    {
      env: {},
      stdout: (s) => void (out += s),
      exit: (c) => void (code = c),
    },
  );
  return { code: code ?? 0, data: out.trim() ? JSON.parse(out) : null };
}

test("config reports the signing mode", async () => {
  const { data } = await run(fake(), ["config"]);
  assert.equal(data.chainId, 8453);
  assert.equal(data.signingMode, "unsigned");
  assert.equal(
    (await run(fake({ key: true }), ["config"])).data.signer,
    privateKeyToAccount(KEY).address,
  );
});

test("chain-id mismatch refuses every command before touching the chain", async () => {
  const chain = fake({ chainId: 1 });
  const { code } = await run(chain, ["offering", "get", OFFERING]);
  assert.notEqual(code, 0);
  assert.equal(chain.calls.length, 0);
});

test("offering get and quote render USDC as decimal strings", async () => {
  const { data } = await run(fake(), ["offering", "get", OFFERING]);
  assert.equal(data.raiseMin, "5000");
  assert.equal(data.phase, "live");
  assert.equal(data.availablePublicUnits, 50);
  const quoted = (await run(fake(), ["offering", "quote", OFFERING, "2"])).data;
  assert.equal(quoted.cost, "21");
});

test("unsigned buy returns approve + buy after simulating both", async () => {
  const chain = fake();
  const { code, data } = await run(chain, [
    "buy",
    "public",
    OFFERING,
    "2",
    "--from",
    BUYER,
  ]);
  assert.equal(code, 0);
  assert.equal(data.mode, "unsigned");
  assert.equal(data.transactions.length, 2);
  assert.equal(
    data.transactions[0].to,
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  );
  const approve = decodeFunctionData({
    abi: erc20Abi,
    data: data.transactions[0].data,
  });
  assert.deepEqual(approve.args, [OFFERING, 21_000_000n]);
  assert.equal(data.transactions[1].to, OFFERING);
  assert.equal(data.preflight.length, 2);
  assert.ok(data.preflight.every((p: { ok: boolean }) => p.ok));
  assert.match(data.preflight[1].note, /allowance/);
});

test("a non-factory address is refused before any simulation or approve", async () => {
  const chain = fake();
  const { code } = await run(chain, [
    "buy",
    "public",
    STRANGER,
    "1",
    "--from",
    BUYER,
  ]);
  assert.notEqual(code, 0);
  assert.equal(chain.calls.length, 0);
});

test("unsigned writes need --from", async () => {
  const { code } = await run(fake(), ["funds", "withdraw", OFFERING]);
  assert.notEqual(code, 0);
});

test("a failing preflight aborts with the decoded revert and sends nothing", async () => {
  const chain = fake({
    key: true,
    revert: (_to, fn) =>
      fn === "buyPublic"
        ? encodeErrorResult({ abi: OFFERING_ABI, errorName: "Slippage" })
        : undefined,
  });
  const { code } = await run(chain, ["buy", "public", OFFERING, "2"]);
  assert.notEqual(code, 0);
  // The approve was sent (it simulated fine); the buy never was.
  assert.equal(chain.sent.length, 1);
  assert.equal(chain.sent[0]?.to, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
});

test("--max-cost below the quote stops before the factory scan", async () => {
  const chain = fake({ key: true });
  const { code } = await run(chain, [
    "buy",
    "public",
    OFFERING,
    "2",
    "--max-cost",
    "20",
  ]);
  assert.notEqual(code, 0);
  assert.equal(chain.sent.length, 0);
});

test("key mode sends in order and --dry-run downgrades to unsigned", async () => {
  const chain = fake({ key: true });
  const { data } = await run(chain, [
    "buy",
    "public",
    OFFERING,
    "2",
    "--name",
    "Ada",
  ]);
  assert.equal(data.mode, "sent");
  assert.equal(data.sent.length, 2);
  assert.equal(chain.sent.length, 2);
  const dry = fake({ key: true });
  const result = await run(dry, ["funds", "withdraw", OFFERING, "--dry-run"]);
  assert.equal(result.data.mode, "unsigned");
  assert.equal(dry.sent.length, 0);
});

test("voucher issue signs in key mode and round-trips through buy private", async () => {
  const issuer = fake({ key: true });
  (OFFERING_VIEWS as Record<string, unknown>).owner =
    privateKeyToAccount(KEY).address;
  try {
    const issued = (
      await run(issuer, [
        "voucher",
        "issue",
        OFFERING,
        "--name",
        "Ada",
        "--cap",
        "100",
      ])
    ).data;
    assert.equal(issued.mode, "signed");
    assert.match(
      issued.link,
      /^https:\/\/pact\.splits\.org\/buy\?offering=0x[0-9a-fA-F]{40}#/,
    );
    const listed = (await run(issuer, ["voucher", "list", OFFERING])).data;
    assert.equal(listed.allocations.length, 1);
    assert.equal(listed.allocations[0].consumed, false);

    const claim = (
      await run(fake(), ["buy", "private", issued.link, "2", "--from", BUYER])
    ).data;
    assert.equal(claim.mode, "unsigned");
    assert.equal(claim.allocationId, issued.allocationId);
    const buy = decodeFunctionData({
      abi: OFFERING_ABI,
      data: claim.transactions[1].data,
    });
    assert.equal(buy.functionName, "buyPrivate");
  } finally {
    (OFFERING_VIEWS as Record<string, unknown>).owner = OWNER;
  }
});

test("voucher issue without a key returns typed data and a completable draft", async () => {
  const chain = fake();
  const issued = (
    await run(chain, [
      "voucher",
      "issue",
      OFFERING,
      "--name",
      "Ada",
      "--cap",
      "100",
    ])
  ).data;
  assert.equal(issued.mode, "unsigned");
  assert.equal(issued.typedData.primaryType, "Voucher");
  const completed = (
    await run(chain, [
      "voucher",
      "complete",
      issued.draft,
      "0x" + "ab".repeat(65),
    ])
  ).data;
  assert.match(completed.link, /#/);
});

test("describeRevert decodes custom errors and falls back to the message", () => {
  const data = encodeErrorResult({
    abi: OFFERING_ABI,
    errorName: "PublicReservationExceeded",
    args: [3n],
  });
  assert.equal(
    describeRevert({ cause: { data } }),
    "PublicReservationExceeded(3)",
  );
  assert.equal(describeRevert(new Error("boom")), "boom");
});
