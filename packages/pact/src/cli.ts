// The one command table, served three ways by incur: argv CLI, MCP stdio
// via --mcp, and generated skill files via `skills add`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BASE_USDC_ADDRESS } from "@splits/pact-core/chain/chain.ts";
import { Cli, z } from "incur";

import { admin } from "#pact/commands/admin.ts";
import { buy } from "#pact/commands/buy.ts";
import { fail } from "#pact/commands/fail.ts";
import { funds } from "#pact/commands/funds.ts";
import { offering } from "#pact/commands/offering.ts";
import { VARS } from "#pact/commands/shared.ts";
import { voucher } from "#pact/commands/voucher.ts";
import { connect as defaultConnect } from "#pact/context.ts";
import type { PactContext } from "#pact/context.ts";
import { ENV } from "#pact/env.ts";
import type { Env } from "#pact/env.ts";

// src/ and dist/ both sit one level below the package root.
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export const version: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

export function createCli({
  connect = defaultConnect,
}: { connect?: (env: Env) => PactContext } = {}) {
  return Cli.create("pact", {
    description:
      "PACT: raise small onchain rounds by selling cap-table units along a bonding curve, in USDC on Base",
    version,
    env: ENV,
    vars: VARS,
    hint: "Writes return unsigned transactions unless PACT_PRIVATE_KEY is set; `pact config --help` lists every variable. Pass --format json when relaying transactions to a signer.",
    update: false,
    mcp: {
      name: "pact",
      title: "PACT",
      instructions:
        "Tools mirror the pact CLI. Reads are free; writes simulate first and return unsigned transactions unless the server was started with PACT_PRIVATE_KEY. Always offering_quote before buy_public.",
      tools: { discovery: "direct" },
    },
    sync: {
      cwd: packageRoot,
      include: ["skills/*"],
      suggestions: [
        "list the live PACT offerings and quote 10 units of the newest one",
        "prepare an unsigned public buy of 5 units and hand me the transactions",
      ],
    },
  })
    .use(async (c, next) => {
      const ctx = connect(c.env);
      const chainId = await ctx.client.getChainId();
      if (chainId !== ctx.chainId)
        return c.error({
          code: "CHAIN_MISMATCH",
          message: `PACT_RPC_URL serves chain ${chainId}, expected ${ctx.chainId} (PACT_CHAIN_ID). Refusing to run.`,
          exitCode: 1,
        });
      c.set("pact", ctx);
      await next();
    })
    .command("config", {
      description:
        "Effective configuration: chain, factory, USDC, RPC, signing mode, version",
      output: z.object({
        version: z.string(),
        chainId: z.number(),
        factory: z.string(),
        factoryDeployBlock: z.number(),
        usdc: z.string(),
        rpcUrl: z.string(),
        signingMode: z.enum(["unsigned", "key"]),
        signer: z.string().nullable(),
        ledgerDir: z.string(),
      }),
      mcp: { annotations: { readOnlyHint: true } },
      examples: [{ description: "Show the effective configuration" }],
      hint: [
        "Environment:",
        ...Object.entries(ENV.shape).map(
          ([name, schema]) => `  ${name.padEnd(27)}${schema.description ?? ""}`,
        ),
      ].join("\n"),
      run(c) {
        const ctx = c.var.pact;
        return {
          version,
          chainId: ctx.chainId,
          factory: ctx.factory,
          factoryDeployBlock: ctx.deployBlock,
          usdc: BASE_USDC_ADDRESS,
          rpcUrl: ctx.rpcUrl,
          signingMode: ctx.account ? ("key" as const) : ("unsigned" as const),
          signer: ctx.account?.address ?? null,
          ledgerDir: ctx.ledgerDir,
        };
      },
    })
    .command(offering)
    .command(buy)
    .command(funds)
    .command(fail)
    .command(voucher)
    .command(admin);
}
