import test from "node:test";
import assert from "node:assert/strict";
import {
  statusPath,
  buyPath,
  buyLinkPath,
  currentOfferingAddress,
  currentVoucherFragment,
  currentCreatePage,
  currentStatusPage,
  currentBuyPage,
} from "./routes.ts";

const OFFERING = "0x692f4B9Fd0940fb5F2Ed2f32435A2DbFDA23b5F8";

test("status and buy routes round-trip the offering address", () => {
  const status = new URL(statusPath(OFFERING), "http://pact.local");
  assert.equal(status.pathname, "/status");
  assert.equal(currentOfferingAddress(status.search), OFFERING);

  const buy = new URL(buyPath(OFFERING), "http://pact.local");
  assert.equal(buy.pathname, "/buy");
  assert.equal(currentOfferingAddress(buy.search), OFFERING);
});

test("buy link carries the voucher fragment", () => {
  const link = new URL(
    buyLinkPath(OFFERING, "eyJ2IjoxfQ"),
    "http://pact.local",
  );
  assert.equal(currentOfferingAddress(link.search), OFFERING);
  assert.equal(currentVoucherFragment(link.hash), "eyJ2IjoxfQ");
});

test("garbage is rejected, not passed through", () => {
  assert.equal(currentOfferingAddress("?offering=not-an-address"), null);
  assert.equal(currentOfferingAddress("?offering=0x123"), null);
  assert.equal(currentOfferingAddress(""), null);
  assert.equal(currentVoucherFragment(""), null);
  assert.equal(currentVoucherFragment("#"), null);
});

test("app page detection", () => {
  assert.equal(currentCreatePage("/create"), true);
  assert.equal(currentCreatePage("/"), false);
  assert.equal(currentStatusPage("/status"), true);
  assert.equal(currentStatusPage("/buy"), false);
  assert.equal(currentBuyPage("/buy"), true);
  assert.equal(currentBuyPage("/status"), false);
});
