// Route construction/parsing. The offering contract address is the record id:
// /status?offering=0x… and /buy?offering=0x… (+ '#<voucher fragment>' for
// private claims). Query-param style needs no path rewrites on static hosting.
// Framework-free so the node test runner can exercise it directly.
import type { Address } from "viem";

import { isAddress } from "#lib/validate.ts";

export const CREATE_PATH = "/create";
export const TERMS_PATH = "/terms";
export const statusPath = (offering: Address) => "/status?offering=" + offering;
export const buyPath = (offering: Address) => "/buy?offering=" + offering;
export const termsPath = (offering: Address) =>
  TERMS_PATH + "?offering=" + offering;
export const buyLinkPath = (offering: Address, fragment: string) =>
  buyPath(offering) + "#" + fragment;
// A shareable absolute URL for an app path.
export const absoluteUrl = (path: string, origin: string = location.origin) =>
  new URL(path, origin).href;

// The `offering` query param, or null when missing or not an address.
export function currentOfferingAddress(
  search: string = location.search,
): Address | null {
  const value = new URLSearchParams(search).get("offering");
  return isAddress(value) ? value : null;
}

// The voucher payload riding the URL fragment, or null when absent.
export function currentVoucherFragment(
  hash: string = location.hash,
): string | null {
  const fragment = String(hash || "").replace(/^#/, "");
  return fragment || null;
}
