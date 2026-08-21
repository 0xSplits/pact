// Two-key allocation vouchers: the offering owner signs an EIP-712 voucher
// endorsing a throwaway per-allocation "link key"; the link key rides in the
// share URL and signs the claiming buyer's address at purchase time, so the
// link is the sole capability and a claim in the mempool can't be frontrun.
// Framework-free so the node test runner can exercise it directly.
import { hashTypedData, keccak256 } from "viem";
import type { Address, Hex } from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  serializeSignature,
  sign,
} from "viem/accounts";

export interface Voucher {
  allocationId: Hex;
  buyerName: string;
  // String in stored/serialized shapes, bigint once decoded from a link.
  amountCapUsdc: string | bigint;
  linkKey: Address;
}

// A getItem/setItem pair; tests substitute an in-memory map for localStorage.
export type KVStorage = Pick<Storage, "getItem" | "setItem">;

const VOUCHER_TYPES = {
  Voucher: [
    { name: "allocationId", type: "bytes32" },
    { name: "buyerName", type: "string" },
    { name: "amountCapUsdc", type: "uint256" },
    { name: "linkKey", type: "address" },
  ],
} as const;

export function voucherTypedData({
  offering,
  chainId,
  voucher,
}: {
  offering: Address;
  chainId: number;
  voucher: Voucher;
}) {
  return {
    domain: {
      name: "PACT",
      version: "1",
      chainId,
      verifyingContract: offering,
    },
    types: VOUCHER_TYPES,
    primaryType: "Voucher" as const,
    message: {
      allocationId: voucher.allocationId,
      buyerName: voucher.buyerName,
      amountCapUsdc: BigInt(voucher.amountCapUsdc),
      linkKey: voucher.linkKey,
    },
  };
}

// Fresh link key + allocation id. The id is derived from the key, so it is
// unique per allocation without a second source of randomness.
export function newAllocationKey(): {
  linkPrivateKey: Hex;
  linkKey: Address;
  allocationId: Hex;
} {
  const linkPrivateKey = generatePrivateKey();
  const linkKey = privateKeyToAccount(linkPrivateKey).address;
  return { linkPrivateKey, linkKey, allocationId: keccak256(linkKey) };
}

// Mirrors Offering.claimDigest: EIP-712 typed data under the offering's own
// domain, so a claim signature binds to one chain and one contract.
function claimDigest({
  offering,
  chainId,
  allocationId,
  buyer,
}: {
  offering: Address;
  chainId: number;
  allocationId: Hex;
  buyer: Address;
}): Hex {
  return hashTypedData({
    domain: {
      name: "PACT",
      version: "1",
      chainId,
      verifyingContract: offering,
    },
    types: {
      Claim: [
        { name: "allocationId", type: "bytes32" },
        { name: "buyer", type: "address" },
      ],
    },
    primaryType: "Claim",
    message: { allocationId, buyer },
  });
}

export async function signClaim({
  linkPrivateKey,
  offering,
  chainId,
  allocationId,
  buyer,
}: {
  linkPrivateKey: Hex;
  offering: Address;
  chainId: number;
  allocationId: Hex;
  buyer: Address;
}): Promise<Hex> {
  return serializeSignature(
    await sign({
      hash: claimDigest({ offering, chainId, allocationId, buyer }),
      privateKey: linkPrivateKey,
    }),
  );
}

// --- share-link fragment codec ---------------------------------------------
// The fragment is base64url JSON and self-describing: the buy page renders the
// allocation from the link alone, with zero lookups. `v` keeps old DM'd links
// parseable if the shape ever shifts.

const FRAGMENT_VERSION = 1;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const binary = atob(String(encoded).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeVoucherFragment({
  voucher,
  ownerSig,
  linkPrivateKey,
}: {
  voucher: Voucher;
  ownerSig: Hex;
  linkPrivateKey: Hex;
}): string {
  return toBase64Url(
    JSON.stringify({
      v: FRAGMENT_VERSION,
      a: voucher.allocationId,
      n: voucher.buyerName,
      c: String(voucher.amountCapUsdc),
      s: ownerSig,
      k: linkPrivateKey,
    }),
  );
}

const isHex = (value: unknown, bytes: number) =>
  new RegExp("^0x[0-9a-fA-F]{" + bytes * 2 + "}$").test(String(value || ""));
// Owner signatures vary by wallet: 65 bytes from an EOA, an opaque ERC-1271
// blob (WebAuthn payload and all) from a passkey/smart wallet.
const isSignatureHex = (value: unknown) =>
  /^0x(?:[0-9a-fA-F]{2}){65,4096}$/.test(String(value || ""));

export interface DecodedVoucherLink {
  voucher: Voucher & { amountCapUsdc: bigint };
  ownerSig: Hex;
  linkPrivateKey: Hex;
}

// Returns { voucher, ownerSig, linkPrivateKey } or throws on any malformed payload.
export function decodeVoucherFragment(fragment: string): DecodedVoucherLink {
  const payload = JSON.parse(
    fromBase64Url(String(fragment || "").replace(/^#/, "")),
  );
  if (payload.v !== FRAGMENT_VERSION)
    throw new Error("Unsupported link version.");
  if (
    !isHex(payload.a, 32) ||
    !isHex(payload.k, 32) ||
    !isSignatureHex(payload.s)
  )
    throw new Error("Malformed link.");
  if (typeof payload.n !== "string" || !/^\d+$/.test(String(payload.c)))
    throw new Error("Malformed link.");
  return {
    voucher: {
      allocationId: payload.a,
      buyerName: payload.n,
      amountCapUsdc: BigInt(payload.c),
      linkKey: privateKeyToAccount(payload.k).address,
    },
    ownerSig: payload.s,
    linkPrivateKey: payload.k,
  };
}

// --- issuer link ledger ------------------------------------------------------
// localStorage is the ledger of issued links; claims are always recoverable
// from Bought events, so losing it degrades softly (unclaimed links survive in
// the DMs they were sent in, re-issuing is free).

export interface AllocationLedgerRow {
  allocationId: Hex;
  name: string;
  amountCapUsd: number;
  link: string;
  createdAt: number;
  revokedAt?: number;
}

const ledgerKey = (offering: Address) =>
  "pact:allocations:" + String(offering).toLowerCase();

export function listAllocationLedger(
  offering: Address,
  storage: KVStorage = localStorage,
): AllocationLedgerRow[] {
  try {
    const rows = JSON.parse(storage.getItem(ledgerKey(offering)) || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function saveAllocationLedgerRow(
  offering: Address,
  row: AllocationLedgerRow,
  storage: KVStorage = localStorage,
): void {
  const rows = listAllocationLedger(offering, storage).filter(
    (r) => r.allocationId !== row.allocationId,
  );
  rows.push(row);
  storage.setItem(ledgerKey(offering), JSON.stringify(rows));
}

// Revoked rows are kept, not deleted: the issuer's ledger is the only record
// an unclaimed allocation ever existed (the AllocationCancelled event carries
// just the id), so a mark beats an erasure.
export function markAllocationLedgerRowRevoked(
  offering: Address,
  allocationId: Hex,
  revokedAt: number,
  storage: KVStorage = localStorage,
): void {
  const rows = listAllocationLedger(offering, storage).map((r) =>
    r.allocationId === allocationId ? { ...r, revokedAt } : r,
  );
  storage.setItem(ledgerKey(offering), JSON.stringify(rows));
}
