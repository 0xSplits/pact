// The published CLI against the anvil chain from e2e-setup.ts: the bin is
// executed from the `npm pack` tarball so what ships is what is tested.
// Anvil's unlocked accounts play the human signer for unsigned-mode relays;
// their well-known private keys play the operator for key mode.
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
} from "viem";
import type { Address, Hex } from "viem";

import {
  e2eAccount,
  e2eFactory,
  rpc,
  RPC_URL,
  sendTx,
} from "#tests/e2e-setup.ts";

test.describe.configure({ timeout: 120_000 });

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// anvil's default mnemonic, indices matching e2eAccount(i).
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
];
const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const execFileAsync = promisify(execFile);

let bin: string;
let ledgerDir: string;

test.beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pact-cli-"));
  // prepack logs to stdout, so locate the tarball instead of parsing --json.
  execFileSync(
    "npm",
    ["pack", "-w", "packages/pact", "--pack-destination", dir],
    { cwd: root, stdio: "ignore" },
  );
  const tarball = fs.readdirSync(dir).find((name) => name.endsWith(".tgz"))!;
  execFileSync("tar", ["xzf", path.join(dir, tarball)], { cwd: dir });
  // Runtime dependencies (viem, the MCP server) stay external to the bundle;
  // the repo's node_modules stands in for a registry install.
  fs.symlinkSync(
    path.join(root, "node_modules"),
    path.join(dir, "package/node_modules"),
  );
  bin = path.join(dir, "package/dist/pact.js");
  ledgerDir = path.join(dir, "ledger");
  expect(fs.existsSync(path.join(dir, "package/skills/pact/SKILL.md"))).toBe(
    true,
  );
  expect(fs.existsSync(path.join(dir, "package/server.json"))).toBe(true);
});

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  PACT_RPC_URL: RPC_URL,
  PACT_FACTORY_ADDRESS: e2eFactory(),
  PACT_LEDGER_DIR: ledgerDir,
  NO_COLOR: "1",
  ...extra,
});

interface Run {
  code: number;
  data: any;
  stderr: string;
}

async function pact(
  args: string[],
  extra: Record<string, string> = {},
): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "node",
      [bin, ...args, "--format", "json"],
      {
        env: env(extra),
      },
    );
    return { code: 0, data: stdout.trim() ? JSON.parse(stdout) : null, stderr };
  } catch (error: any) {
    const stdout = String(error.stdout ?? "").trim();
    let data = null;
    try {
      data = stdout ? JSON.parse(stdout) : null;
    } catch {
      data = stdout;
    }
    return { code: error.code ?? 1, data, stderr: String(error.stderr ?? "") };
  }
}

const asKey = (index: number) => ({ PACT_PRIVATE_KEY: KEYS[index]! });

async function createOffering(raiseMin: string, key = 0): Promise<Address> {
  const owner = e2eAccount(key);
  const result = await pact(
    [
      "offering",
      "create",
      "--name",
      "E2E Raise",
      "--raise-min",
      raiseMin,
      "--floor",
      "100000",
      "--ceiling",
      "200000",
      "--public-units",
      "50",
      "--holders",
      `${owner}:900`,
      "--close-days",
      "1",
    ],
    asKey(key),
  );
  expect(result.code, result.stderr).toBe(0);
  expect(result.data.mode).toBe("sent");
  return getAddress(result.data.offering);
}

const readOffering = (offering: Address) => pact(["offering", "get", offering]);

// Relay unsigned transactions through anvil as `from` (unlocked account).
async function relay(
  from: Address,
  transactions: Array<{ to: Address; data: Hex }>,
) {
  for (const tx of transactions)
    await sendTx({ from, to: tx.to, data: tx.data });
}

test("config, create, quote, buy in both modes, vouchers, withdraw", async () => {
  const config = await pact(["config"]);
  expect(config.code).toBe(0);
  expect(config.data.chainId).toBe(8453);
  expect(getAddress(config.data.factory)).toBe(e2eFactory());
  expect(config.data.signingMode).toBe("unsigned");
  expect(getAddress((await pact(["config"], asKey(0))).data.signer)).toBe(
    getAddress(e2eAccount(0)),
  );

  const offering = await createOffering("100");
  const listed = await pact(["offering", "list"]);
  expect(
    listed.data.offerings.map((o: any) => getAddress(o.offering)),
  ).toContain(offering);

  // floor 100k → 100 USDC first unit; slope (100k/1000)/100 offered = 1 USDC.
  const quote = await pact(["offering", "quote", offering, "2"]);
  expect(quote.data.cost).toBe("201");
  expect(quote.data.availablePublicUnits).toBe(50);

  // Key mode: approve + buy sent in order, decoded events returned.
  const bought = await pact(
    ["buy", "public", offering, "2", "--name", "Ada", "--max-cost", "201"],
    asKey(1),
  );
  expect(bought.code, bought.stderr).toBe(0);
  expect(bought.data.mode).toBe("sent");
  expect(bought.data.sent).toHaveLength(2);
  expect(bought.data.sent[1].events.map((e: any) => e.name)).toContain(
    "Bought",
  );
  let state = await readOffering(offering);
  expect(state.data.unitsSold).toBe(2);
  expect(state.data.minMet).toBe(true);
  expect(state.data.raised).toBe("201");

  // Unsigned mode: the same buy as transactions a wallet signs; relayed via anvil.
  const buyerB = e2eAccount(2);
  const unsigned = await pact([
    "buy",
    "public",
    offering,
    "1",
    "--from",
    buyerB,
  ]);
  expect(unsigned.code, unsigned.stderr).toBe(0);
  expect(unsigned.data.mode).toBe("unsigned");
  expect(unsigned.data.transactions).toHaveLength(2);
  expect(unsigned.data.preflight.every((p: any) => p.ok)).toBe(true);
  const approve = decodeFunctionData({
    abi: erc20Abi,
    data: unsigned.data.transactions[0].data,
  });
  expect(approve.args).toEqual([offering, 102_000_000n]);
  await relay(buyerB, unsigned.data.transactions);
  state = await readOffering(offering);
  expect(state.data.unitsSold).toBe(3);

  // Key-mode voucher: owner signs, buyer C claims with their key.
  const issued = await pact(
    ["voucher", "issue", offering, "--name", "Cy", "--cap", "500"],
    asKey(0),
  );
  expect(issued.code, issued.stderr).toBe(0);
  expect(issued.data.mode).toBe("signed");
  expect(issued.data.link).toMatch(
    /^https:\/\/pact\.splits\.org\/buy\?offering=0x/,
  );
  const claimed = await pact(
    ["buy", "private", issued.data.link, "1"],
    asKey(4),
  );
  expect(claimed.code, claimed.stderr).toBe(0);
  expect(claimed.data.mode).toBe("sent");
  const vouchers = await pact(["voucher", "list", offering]);
  expect(vouchers.data.allocations).toHaveLength(1);
  expect(vouchers.data.allocations[0].consumed).toBe(true);
  expect(
    fs.existsSync(
      path.join(ledgerDir, "8453", offering.toLowerCase() + ".json"),
    ),
  ).toBe(true);

  // Unsigned voucher: typed data signed by the owner's wallet, then completed.
  const draft = await pact([
    "voucher",
    "issue",
    offering,
    "--name",
    "Dee",
    "--cap",
    "500",
  ]);
  expect(draft.data.mode).toBe("unsigned");
  const signature: Hex = await rpc("eth_signTypedData_v4", [
    e2eAccount(0),
    JSON.stringify({
      ...draft.data.typedData,
      types: {
        ...draft.data.typedData.types,
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
    }),
  ]);
  const completed = await pact([
    "voucher",
    "complete",
    draft.data.draft,
    signature,
  ]);
  expect(completed.code, completed.stderr).toBe(0);
  const privateUnsigned = await pact([
    "buy",
    "private",
    completed.data.link,
    "1",
    "--from",
    buyerB,
  ]);
  expect(privateUnsigned.code, privateUnsigned.stderr).toBe(0);
  expect(privateUnsigned.data.transactions).toHaveLength(2);
  await relay(buyerB, privateUnsigned.data.transactions);
  expect(
    (await pact(["voucher", "get", offering, completed.data.allocationId])).data
      .consumed,
  ).toBe(true);

  // Withdraw is permissionless once the minimum is met and always pays treasury.
  const withdrawn = await pact(["funds", "withdraw", offering], asKey(2));
  expect(withdrawn.code, withdrawn.stderr).toBe(0);
  expect(withdrawn.data.sent[0].events.map((e: any) => e.name)).toContain(
    "Withdrawn",
  );
  state = await readOffering(offering);
  expect(state.data.withdrawn).toBe(state.data.raised);

  const table = await pact(["offering", "cap-table", offering]);
  expect(table.data.purchases).toHaveLength(4);
  expect(
    table.data.holders.find(
      (h: any) => getAddress(h.holder) === getAddress(e2eAccount(1)),
    ).units,
  ).toBe(2);
});

test("failure path: mark, refund, sweep", async () => {
  const offering = await createOffering("5000");
  expect((await pact(["buy", "public", offering, "1"], asKey(1))).code).toBe(0);
  const buyerB = e2eAccount(2);
  const unsignedBuy = await pact([
    "buy",
    "public",
    offering,
    "1",
    "--from",
    buyerB,
  ]);
  await relay(buyerB, unsignedBuy.data.transactions);
  const snapshot = await rpc("evm_snapshot");
  try {
    await rpc("evm_increaseTime", [2 * 86400]);
    await rpc("evm_mine");
    const marked = await pact(["fail", "mark", offering], asKey(2));
    expect(marked.code, marked.stderr).toBe(0);
    expect((await readOffering(offering)).data.phase).toBe("failed");
    const refunded = await pact(["fail", "refund", offering], asKey(1));
    expect(refunded.code, refunded.stderr).toBe(0);
    expect(refunded.data.sent[0].events.map((e: any) => e.name)).toContain(
      "RefundPaid",
    );
    const unsignedRefund = await pact([
      "fail",
      "refund",
      offering,
      "--from",
      buyerB,
    ]);
    expect(unsignedRefund.code, unsignedRefund.stderr).toBe(0);
    expect(unsignedRefund.data.mode).toBe("unsigned");
    await relay(buyerB, unsignedRefund.data.transactions);
    expect((await readOffering(offering)).data.raised).toBe("0");
    const swept = await pact(["fail", "sweep", offering], asKey(2));
    expect(swept.code, swept.stderr).toBe(0);
    expect((await readOffering(offering)).data.remainingUnits).toBe(0);
  } finally {
    await rpc("evm_revert", [snapshot]);
  }
});

test("guardrails: foreign address, chain pin, failing preflight", async () => {
  const offering = await createOffering("100");
  const buyerB = e2eAccount(2);

  // Not a factory child: refused before the USDC approve is even simulated.
  const stranger = getAddress("0x00000000000000000000000000000000000000ee");
  const foreign = await pact([
    "buy",
    "public",
    stranger,
    "1",
    "--from",
    buyerB,
  ]);
  expect(foreign.code).not.toBe(0);
  expect(foreign.stderr + JSON.stringify(foreign.data)).toMatch(
    /NOT_A_PACT_OFFERING/,
  );
  const allowance: Hex = await rpc("eth_call", [
    {
      to: BASE_USDC,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "allowance",
        args: [buyerB, stranger],
      }),
    },
    "latest",
  ]);
  expect(BigInt(allowance)).toBe(0n);

  // Chain pin: the RPC says 8453, the operator expected 1.
  const mismatch = await pact(["config"], { PACT_CHAIN_ID: "1" });
  expect(mismatch.code).not.toBe(0);
  expect(mismatch.stderr + JSON.stringify(mismatch.data)).toMatch(
    /CHAIN_MISMATCH/,
  );

  // Failing preflight: a non-owner closing reverts in simulation; nothing sent.
  const before = await readOffering(offering);
  const close = await pact(["funds", "close", offering], asKey(1));
  expect(close.code).not.toBe(0);
  expect(close.stderr + JSON.stringify(close.data)).toMatch(
    /PREFLIGHT_FAILED|Unauthorized/,
  );
  expect((await readOffering(offering)).data.state).toBe(before.data.state);
});

test("mcp stdio: tools/list exposes the table and offering_get reads", async () => {
  const offering = await createOffering("100");
  const server = spawn("node", [bin, "--mcp"], {
    env: env(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const pending = new Map<number, (message: any) => void>();
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id != null) pending.get(message.id)?.(message);
    }
  });
  server.stderr.on("data", (chunk) =>
    console.log("mcp stderr:", String(chunk)),
  );
  let nextId = 1;
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      server.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  try {
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pact-e2e", version: "0" },
    });
    server.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    const tools = await request("tools/list");
    const names = tools.result.tools.map((t: any) => t.name);
    expect(names).toHaveLength(26);
    expect(names).toContain("offering_get");
    expect(names).toContain("buy_public");
    const read = await request("tools/call", {
      name: "offering_get",
      arguments: { offering },
    });
    expect(read.result.isError).toBeFalsy();
    const text = read.result.content.map((c: any) => c.text).join("\n");
    expect(text.toLowerCase()).toContain(offering.toLowerCase());
  } finally {
    server.kill();
  }
});
