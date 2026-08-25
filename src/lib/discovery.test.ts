import assert from "node:assert/strict";

import { test } from "vitest";

import { llmsTxt, wellKnownManifest } from "#lib/discovery.ts";

const inputs = {
  factoryAddress: "0x0000000000000000000000000000000000000Fac",
  factoryDeployBlock: 123,
  cliPackage: "@splits/pact",
  repository: "https://github.com/0xSplits/pact",
};

test("manifest carries the pin and the one install command everywhere", () => {
  const manifest = wellKnownManifest(inputs);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.chainId, 8453);
  assert.equal(
    manifest.contracts.offeringFactory.address,
    inputs.factoryAddress,
  );
  assert.equal(manifest.contracts.offeringFactory.deployBlock, 123);
  assert.equal(manifest.cli.skills, "npx @splits/pact skills add");
  assert.equal(manifest.skill, manifest.cli.skills);
  assert.equal(manifest.mcp.run, "npx @splits/pact --mcp");
  assert.equal(manifest.mcp.registryName, "org.splits/pact-mcp");
  assert.match(manifest.docs.integrate, /\/docs\/integrate\.md$/);
  assert.doesNotThrow(() => JSON.stringify(manifest));
});

test("llms.txt names chain, factory, deploy block, and the tools in order", () => {
  const text = llmsTxt(inputs);
  assert.match(text, /chain id 8453/);
  assert.match(text, new RegExp(inputs.factoryAddress));
  assert.match(text, /block 123/);
  const order = ["--help", "skills add", "--mcp"].map((needle) =>
    text.indexOf(needle),
  );
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
});
