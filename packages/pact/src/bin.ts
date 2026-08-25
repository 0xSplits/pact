#!/usr/bin/env node
import { createCli } from "#pact/cli.ts";
import { connect } from "#pact/context.ts";
import { ENV } from "#pact/env.ts";

// The MCP server is long-lived: refuse to start on a chain mismatch instead
// of failing every tool call.
if (process.argv.includes("--mcp")) {
  const ctx = connect(ENV.parse(process.env));
  const chainId = await ctx.client.getChainId();
  if (chainId !== ctx.chainId) {
    console.error(
      `PACT_RPC_URL serves chain ${chainId}, expected ${ctx.chainId}. Refusing to start.`,
    );
    process.exit(1);
  }
}

await createCli().serve();
