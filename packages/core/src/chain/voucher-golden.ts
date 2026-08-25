// Builds tests/fixtures/voucher-golden.json — the golden vector pinning the
// JS ↔ Solidity voucher boundary. The JS test asserts this module still
// reproduces the checked-in file byte-for-byte; the Forge test deploys an
// Offering at the same address and asserts the real verifier accepts the
// signatures. Run `node packages/core/src/chain/voucher-golden.ts` to regenerate
// after an intentional change to the voucher shape (both suites go red until
// the fixture is refreshed).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getContractAddress, keccak256, numberToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { signClaim, voucherTypedData } from "#core/chain/voucher.ts";

const key = (n: bigint) => numberToHex(n, { size: 32 });

export async function buildGoldenFixture() {
  const ownerKey = key(1n);
  const linkPrivateKey = key(2n);
  const buyer = privateKeyToAccount(key(3n)).address;
  const deployer = privateKeyToAccount(key(9n)).address;
  const owner = privateKeyToAccount(ownerKey).address;
  const linkKey = privateKeyToAccount(linkPrivateKey).address;
  const offering = getContractAddress({ from: deployer, nonce: 0n });
  const chainId = 8453;

  const voucher = {
    allocationId: keccak256(linkKey),
    buyerName: "Golden Buyer",
    amountCapUsdc: "250000000",
  };
  const ownerSig = await privateKeyToAccount(ownerKey).signTypedData(
    voucherTypedData({ offering, chainId, voucher: { ...voucher, linkKey } }),
  );
  const claimSig = await signClaim({
    linkPrivateKey,
    offering,
    chainId,
    allocationId: voucher.allocationId,
    buyer,
  });

  return {
    chainId,
    deployer,
    offering,
    ownerKey,
    owner,
    linkPrivateKey,
    linkKey,
    buyer,
    voucher,
    ownerSig,
    claimSig,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const outPath = path.join(root, "tests", "fixtures", "voucher-golden.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(await buildGoldenFixture(), null, 2) + "\n",
  );
  console.log("Wrote", path.relative(root, outPath));
}
