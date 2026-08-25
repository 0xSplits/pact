// Renders the static discovery surfaces into public/ before every Vite build:
// /llms.txt, /.well-known/pact.json, and the markdown mirrors under /docs/.
// Everything hard-coded here traces to the generated contract pin, and the
// hand-written docs are checked against it so a stale address fails the build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OFFERING_FACTORY_ADDRESS,
  OFFERING_FACTORY_DEPLOY_BLOCK,
} from "#generated/offering-contracts.ts";
import { BASE_USDC_ADDRESS } from "#lib/chain/chain.ts";
import { llmsTxt, wellKnownManifest } from "#lib/discovery.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const cliPackage = JSON.parse(
  fs.readFileSync(path.join(root, "packages/pact/package.json"), "utf8"),
).name as string;
const inputs = {
  factoryAddress: OFFERING_FACTORY_ADDRESS,
  factoryDeployBlock: OFFERING_FACTORY_DEPLOY_BLOCK,
  cliPackage,
  repository: "https://github.com/0xSplits/pact",
};

const write = (relative: string, content: string) => {
  const target = path.join(publicDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};

// Any 20-byte address in a landing doc must be the pin or USDC.
function assertPinned(relative: string, text: string) {
  const allowed = new Set(
    [OFFERING_FACTORY_ADDRESS, BASE_USDC_ADDRESS].map((a) => a.toLowerCase()),
  );
  for (const match of text.match(/0x[0-9a-fA-F]{40}/g) ?? []) {
    if (!allowed.has(match.toLowerCase()))
      throw new Error(
        `${relative}: ${match} is not the pinned factory or USDC`,
      );
  }
  if (!text.includes(OFFERING_FACTORY_ADDRESS))
    throw new Error(`${relative}: missing the pinned factory address`);
  if (
    relative === "docs/integrate.md" &&
    !text.includes(String(OFFERING_FACTORY_DEPLOY_BLOCK))
  )
    throw new Error(`${relative}: deploy block does not match the pin`);
}

const mirrors: Array<[source: string, target: string]> = [
  ["docs/architecture.md", "docs/architecture.md"],
  ["docs/integrate.md", "docs/integrate.md"],
  ["contracts/docs/contracts.md", "docs/contracts.md"],
];
for (const [source, target] of mirrors) {
  const text = fs
    .readFileSync(path.join(root, source), "utf8")
    // Flattened layout: every doc sits beside the others.
    .replaceAll("../contracts/docs/contracts.md", "contracts.md")
    .replaceAll("../docs/architecture.md", "architecture.md");
  if (source === "docs/integrate.md") assertPinned(source, text);
  write(target, text);
}
assertPinned(
  "README.md",
  fs.readFileSync(path.join(root, "README.md"), "utf8"),
);

write("llms.txt", llmsTxt(inputs));
write(
  ".well-known/pact.json",
  JSON.stringify(wellKnownManifest(inputs), null, 2) + "\n",
);
console.log(
  "Wrote public/llms.txt, public/.well-known/pact.json, public/docs/*.md",
);
