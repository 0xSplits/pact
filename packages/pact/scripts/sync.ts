// Publish-time generation, run by `npm run build` (so also at prepack):
// server.json for the MCP registry from package.json, and the skill's
// onchain-recipes reference from the canonical docs/integrate.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.join(packageRoot, "..", "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);

const env = (name: string, description: string, isSecret = false) => ({
  name,
  description,
  isRequired: false,
  ...(isSecret ? { isSecret: true } : {}),
});

const serverJson = {
  $schema:
    "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: pkg.mcpName,
  description: pkg.description,
  title: "PACT",
  repository: {
    url: "https://github.com/0xSplits/pact",
    source: "github",
    subfolder: "packages/pact",
  },
  version: pkg.version,
  websiteUrl: pkg.homepage,
  packages: [
    {
      registryType: "npm",
      registryBaseUrl: "https://registry.npmjs.org",
      identifier: pkg.name,
      version: pkg.version,
      runtimeHint: "npx",
      runtimeArguments: [{ type: "positional", value: "-y", valueHint: "-y" }],
      packageArguments: [
        { type: "positional", value: "--mcp", valueHint: "--mcp" },
      ],
      transport: { type: "stdio" },
      environmentVariables: [
        env(
          "PACT_RPC_URL",
          "JSON-RPC endpoint; defaults to the public Base RPC",
        ),
        env("PACT_CHAIN_ID", "Expected chain id; defaults to 8453"),
        env(
          "PACT_FACTORY_ADDRESS",
          "OfferingFactory address; defaults to the pinned Base deployment",
        ),
        env(
          "PACT_PRIVATE_KEY",
          "Operator key enabling signed sends; omit for unsigned transactions",
          true,
        ),
        env(
          "PACT_LEDGER_DIR",
          "Voucher ledger directory; defaults to ~/.pact/ledger",
        ),
      ],
    },
  ],
};
fs.writeFileSync(
  path.join(packageRoot, "server.json"),
  JSON.stringify(serverJson, null, 2) + "\n",
);

const origin = "https://pact.splits.org";
const recipes = fs
  .readFileSync(path.join(repoRoot, "docs/integrate.md"), "utf8")
  .replaceAll(
    "](../contracts/docs/contracts.md",
    `](${origin}/docs/contracts.md`,
  )
  .replaceAll("](architecture.md)", `](${origin}/docs/architecture.md)`);
fs.mkdirSync(path.join(packageRoot, "skills/pact/references"), {
  recursive: true,
});
fs.writeFileSync(
  path.join(packageRoot, "skills/pact/references/onchain-recipes.md"),
  `<!-- Generated from docs/integrate.md by packages/pact/scripts/sync.ts. Edit the source. -->\n\n` +
    recipes,
);
console.error(
  "Wrote server.json and skills/pact/references/onchain-recipes.md",
);
