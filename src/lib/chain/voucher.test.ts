import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  newAllocationKey,
  encodeVoucherFragment,
  decodeVoucherFragment,
  listAllocationLedger,
  saveAllocationLedgerRow,
  markAllocationLedgerRowRevoked,
} from "./voucher.ts";
import { buildGoldenFixture } from "../../../scripts/generate-voucher-fixture.ts";

const fakeStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};

test("fragment codec round-trips a voucher", async () => {
  const { linkPrivateKey, linkKey, allocationId } = newAllocationKey();
  const voucher = {
    allocationId,
    buyerName: "Ada Lovelace",
    amountCapUsdc: "125000000",
    linkKey,
  };
  const ownerSig = ("0x" + "ab".repeat(65)) as `0x${string}`;

  const fragment = encodeVoucherFragment({ voucher, ownerSig, linkPrivateKey });
  assert.match(fragment, /^[A-Za-z0-9_-]+$/, "base64url, no padding");

  const decoded = decodeVoucherFragment(fragment);
  assert.equal(decoded.voucher.allocationId, allocationId);
  assert.equal(decoded.voucher.buyerName, "Ada Lovelace");
  assert.equal(decoded.voucher.amountCapUsdc, 125000000n);
  assert.equal(
    decoded.voucher.linkKey,
    linkKey,
    "link key re-derived from the private key",
  );
  assert.equal(decoded.ownerSig, ownerSig);
  assert.equal(decoded.linkPrivateKey, linkPrivateKey);
});

test("fragment decode strips a leading #", () => {
  const { linkPrivateKey, linkKey, allocationId } = newAllocationKey();
  const fragment = encodeVoucherFragment({
    voucher: { allocationId, buyerName: "X", amountCapUsdc: "1", linkKey },
    ownerSig: ("0x" + "00".repeat(65)) as `0x${string}`,
    linkPrivateKey,
  });
  assert.equal(
    decodeVoucherFragment("#" + fragment).voucher.allocationId,
    allocationId,
  );
});

test("fragment decode rejects malformed payloads", () => {
  assert.throws(() => decodeVoucherFragment("not-base64-json"));
  assert.throws(() => decodeVoucherFragment(btoa('{"v":1}')));
  // Wrong version
  const payload = {
    v: 2,
    a: "0x" + "11".repeat(32),
    n: "X",
    c: "1",
    s: "0x" + "00".repeat(65),
    k: "0x" + "22".repeat(32),
  };
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  assert.throws(() => decodeVoucherFragment(encode(payload)), /version/i);
  // Bad hex lengths and non-numeric cap
  assert.throws(() =>
    decodeVoucherFragment(encode({ ...payload, v: 1, a: "0xdead" })),
  );
  assert.throws(() =>
    decodeVoucherFragment(encode({ ...payload, v: 1, c: "12.5" })),
  );
  // Owner sigs shorter than one ECDSA signature or of odd byte length
  assert.throws(() =>
    decodeVoucherFragment(
      encode({ ...payload, v: 1, s: "0x" + "00".repeat(64) }),
    ),
  );
  assert.throws(() =>
    decodeVoucherFragment(
      encode({ ...payload, v: 1, s: "0x" + "00".repeat(65) + "0" }),
    ),
  );
});

test("fragment decode accepts an ERC-1271 smart-wallet owner sig blob", () => {
  const { linkPrivateKey, linkKey, allocationId } = newAllocationKey();
  const ownerSig = ("0x" + "cd".repeat(736)) as `0x${string}`;
  const fragment = encodeVoucherFragment({
    voucher: {
      allocationId,
      buyerName: "Abram",
      amountCapUsdc: "5000000",
      linkKey,
    },
    ownerSig,
    linkPrivateKey,
  });
  assert.equal(decodeVoucherFragment(fragment).ownerSig, ownerSig);
});

test("allocation ids are unique per link key", () => {
  const a = newAllocationKey();
  const b = newAllocationKey();
  assert.notEqual(a.allocationId, b.allocationId);
  assert.notEqual(a.linkPrivateKey, b.linkPrivateKey);
});

test("golden vector matches the checked-in fixture byte for byte", async () => {
  const root = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
  const checkedIn = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests", "fixtures", "voucher-golden.json"),
      "utf8",
    ),
  );
  const regenerated = await buildGoldenFixture();
  // Drift on either side of the JS ↔ Solidity boundary goes red here or in
  // the Forge golden test; regenerate the fixture only on intentional change.
  assert.deepEqual(regenerated, checkedIn);
});

test("allocation ledger add/list/revoke round-trips", () => {
  const storage = fakeStorage();
  const offering = "0x" + "99".repeat(20);
  const row = {
    allocationId: "0x" + "11".repeat(32),
    name: "Bob",
    amountCapUsd: 50,
    link: "https://x/#f",
    createdAt: 1,
  };
  saveAllocationLedgerRow(offering, row, storage);
  assert.deepEqual(listAllocationLedger(offering, storage), [row]);
  // Saving the same allocation replaces, not duplicates.
  saveAllocationLedgerRow(offering, { ...row, name: "Bobby" }, storage);
  assert.equal(listAllocationLedger(offering, storage).length, 1);
  assert.equal(listAllocationLedger(offering, storage)[0]?.name, "Bobby");
  markAllocationLedgerRowRevoked(offering, row.allocationId, 7, storage);
  assert.deepEqual(listAllocationLedger(offering, storage), [
    { ...row, name: "Bobby", revokedAt: 7 },
  ]);
  // Marking an unknown id leaves the ledger untouched.
  markAllocationLedgerRowRevoked(offering, "0x" + "22".repeat(32), 8, storage);
  assert.deepEqual(listAllocationLedger(offering, storage), [
    { ...row, name: "Bobby", revokedAt: 7 },
  ]);
});
