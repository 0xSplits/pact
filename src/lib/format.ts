// Shared display formatting helpers for the React pages.
import { formatUnits } from "viem";

import { USDC_DECIMALS } from "#lib/chain/chain.ts";

export const MS_PER_DAY = 86400000;

// Every dollar render in the app goes through this one formatter.
//   auto    — cents only when the value has them (or is sub-$1)
//   cents   — always two decimals
//   whole   — rounded to whole dollars
//   price   — per-token prices: four decimals below $1, else two
//   compact — $1.50M / $250K axis-label style
export type UsdFormat = "auto" | "cents" | "whole" | "price" | "compact";

export function fmtUsd(value: number, format: UsdFormat = "auto"): string {
  if (format === "whole")
    return "$" + Math.round(value).toLocaleString("en-US");
  if (format === "compact") {
    if (value >= 1e6)
      return "$" + (value / 1e6).toFixed(value % 1e6 === 0 ? 0 : 2) + "M";
    if (value >= 1e3) return "$" + Math.round(value / 1e3) + "K";
    return "$" + Math.round(value);
  }
  const fourDecimals = format === "price" && value > 0 && value < 1;
  const showCents =
    format !== "auto" ||
    Math.abs(value - Math.round(value)) > 0.000001 ||
    (value > 0 && value < 1);
  return (
    "$" +
    value.toLocaleString("en-US", {
      minimumFractionDigits: fourDecimals ? 4 : showCents ? 2 : 0,
      maximumFractionDigits: fourDecimals ? 4 : 2,
    })
  );
}

export const fmtPct = (n: number) => n.toFixed(1) + "%";
export const fmtTokens = (n: number) => Math.round(n).toLocaleString("en-US");
export const fmtDate = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
// Compact day-month ("16-Aug") for table cells.
export const fmtShortDate = (ts: number) => {
  const d = new Date(ts);
  return d.getDate() + "-" + d.toLocaleDateString("en-US", { month: "short" });
};

// Relative close-date copy ("in 3 days" / "today" / "3 days ago").
// pastDates: false returns "" once the date has passed (the status page
// shows nothing rather than a stale countdown).
export function relDays(ts: number, { pastDates = true } = {}): string {
  const days = Math.ceil((ts - Date.now()) / MS_PER_DAY);
  if (days > 1) return "in " + days + " days";
  if (days === 1) return "in 1 day";
  if (days === 0) return "today";
  if (!pastDates) return "";
  return days === -1 ? "1 day ago" : Math.abs(days) + " days ago";
}

// Dollars out of a text input that may carry commas and stray characters.
export const parseMoney = (s: string | number) =>
  +String(s).replace(/[^0-9.]/g, "") || 0;

// Live-format a dollar text input: thousands separators, max two decimals.
export function formatAmountInput(value: string): string {
  const raw = value.replace(/,/g, "").replace(/[^0-9.]/g, "");
  const parts = raw.split(".");
  const intPart = (parts[0] ?? "").replace(/^0+(?=\d)/, "");
  const decPart = parts.length > 1 ? parts.slice(1).join("").slice(0, 2) : null;
  const intDisplay = intPart ? Number(intPart).toLocaleString("en-US") : "";
  return decPart == null ? intDisplay : (intDisplay || "0") + "." + decPart;
}

// The one bigint→float boundary: base units become dollars for display and
// chart math only, after formatUnits has already done the exact division.
// Accepts numbers/strings so legacy localStorage cache values still convert.
export const usdcBaseUnitsToDollars = (
  n: bigint | number | string | null | undefined,
) => Number(formatUnits(BigInt(n ?? 0), USDC_DECIMALS));
export const shortAddr = (a: string | null | undefined) =>
  a && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a || "";
export const basescanTx = (hash: string) =>
  "https://basescan.org/tx/" + encodeURIComponent(hash);
export const basescanAddress = (address: string) =>
  "https://basescan.org/address/" + encodeURIComponent(address);

// Message for the user out of an unknown thrown value.
export const errMsg = (err: unknown, fallback: string): string =>
  (err instanceof Error && err.message) || fallback;
