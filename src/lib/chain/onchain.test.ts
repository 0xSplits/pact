import assert from "node:assert/strict";

import { test } from "vitest";

import { QuoteChangedError } from "#lib/chain/onchain.ts";

test("QuoteChangedError carries the fresh quote", () => {
  const error = new QuoteChangedError(7, 123n);
  assert.ok(error instanceof Error);
  assert.equal(error.units, 7);
  assert.equal(error.cost, 123n);
  assert.match(error.message, /Prices moved/);
});
