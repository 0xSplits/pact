import assert from "node:assert/strict";

import { test } from "vitest";

import { isAddress, isSameAddress } from "#lib/validate.ts";

test("isAddress accepts 40-hex addresses and trims whitespace", () => {
  const address = "0x" + "aB".repeat(20);
  assert.equal(isAddress(address), true);
  assert.equal(isAddress("  " + address + "  "), true);
  assert.equal(isAddress("0x" + "ab".repeat(19)), false);
  assert.equal(isAddress(null), false);
  assert.equal(isAddress(42), false);
});

test("isSameAddress matches case-insensitively and rejects missing sides", () => {
  const address = "0x" + "AB".repeat(20);
  assert.equal(isSameAddress(address, address.toLowerCase()), true);
  assert.equal(isSameAddress(address, "0x" + "cd".repeat(20)), false);
  assert.equal(isSameAddress(address, null), false);
  assert.equal(isSameAddress(null, null), false);
  assert.equal(isSameAddress("", ""), false, "falsy sides short-circuit");
});
