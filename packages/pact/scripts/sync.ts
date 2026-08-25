// Publish-time generation, run by `npm run build` (so also at prepack):
// server.json for the MCP registry from package.json, and the skill's
// onchain-recipes reference from the canonical docs/integrate.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ENV } from "#pact/env.ts";

const packageRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.join(packageRoot, "..", "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);

const environmentVariables = Object.entries(ENV.shape).map(
  ([name, schema]) => ({
    name,
    description: schema.description ?? "",
    isRequired: false,
    ...(name === "PACT_PRIVATE_KEY" ? { isSecret: true } : {}),
  }),
);

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
      environmentVariables,
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
