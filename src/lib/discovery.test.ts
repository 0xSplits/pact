import assert from "node:assert/strict";

import { test } from "vitest";

import { llmsTxt, robotsTxt, wellKnownManifest } from "#lib/discovery.ts";

const inputs = {
  factoryAddress: "0x0000000000000000000000000000000000000Fac",
  factoryDeployBlock: 123,
  repository: "https://github.com/0xSplits/pact",
};

test("manifest carries the pin and the skill pointer", () => {
  const manifest = wellKnownManifest(inputs);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.chainId, 8453);
  assert.equal(
    manifest.contracts.offeringFactory.address,
    inputs.factoryAddress,
  );
  assert.equal(manifest.contracts.offeringFactory.deployBlock, 123);
  assert.equal(manifest.skill.install, "npx skills add 0xSplits/pact");
  assert.match(manifest.skill.source, /\/skills\/pact$/);
  assert.match(manifest.docs.integrate, /\/docs\/integrate\.md$/);
  assert.doesNotThrow(() => JSON.stringify(manifest));
});

test("robots.txt allows crawling and points agents at llms.txt", () => {
  const text = robotsTxt();
  assert.match(text, /Allow: \//);
  assert.match(text, /User-agent: \*/);
  assert.match(text, /\/llms\.txt/);
  assert.match(text, /\/\.well-known\/pact\.json/);
});

test("llms.txt names chain, factory, deploy block, and the skill", () => {
  const text = llmsTxt(inputs);
  assert.match(text, /chain id 8453/);
  assert.match(text, new RegExp(inputs.factoryAddress));
  assert.match(text, /block 123/);
  assert.match(text, /npx skills add 0xSplits\/pact/);
  assert.doesNotMatch(text, /--mcp|@splits\/pact/);
});
