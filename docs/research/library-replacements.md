# Library-replacement sweep

Follow-up to the `checksumOrLower` deletion (see
[as-assertions-audit.md](./as-assertions-audit.md) — viem's `getAddress`
already validated + checksummed). This sweep asks the same question of the
rest of the hand-written source: where does local code duplicate something an
installed library, the platform, or (conservatively) a new dependency already
provides?

Installed dependencies (`package.json`): `viem`, `wagmi`, `react`,
`react-dom`, `@tanstack/react-query`. Scope: `src/lib/**`, `src/pages/**`,
`src/components/**`, `src/hooks/**`, `scripts/**`, `tests/**`. Skipped:
`src/generated/` (generated), `contracts/src/vendor/` (pinned upstream).

## Clear wins (drop-in, deletes code)

### 1. `scripts/generate-voucher-fixture.ts:17` — hand-rolled 32-byte hex pad

```ts
const key = (n: bigint): Hex => ("0x" + n.toString(16).padStart(64, "0")) as Hex;
```

viem (already imported in this file) exports `numberToHex(n, { size: 32 })`
which produces exactly this, typed `Hex`, no cast
(`node_modules/viem/_types/utils/encoding/toHex.d.ts:119`,
https://viem.sh/docs/utilities/toHex#numbertohex). Deletes the helper and its
`as Hex`.

That is the only unqualified drop-in found. The codebase is already lean:
routes go through `URL`/`URLSearchParams` (`src/lib/routes.ts:16,38`), money
math already went through viem `parseUnits`/`formatUnits` (PE-8542), scripts
already use Node stdlib (`execFileSync`, `fs`, `path`).

## Wins with caveats (behavior delta to accept)

### 2. `src/lib/validate.ts:4-10` — `isAddress` / `isTxHash` vs viem `isAddress` / `isHash`

Local:

```ts
export function isAddress(value: unknown): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}
export function isTxHash(value: unknown): value is Hex { /* 64-hex regex */ }
```

viem exports `isAddress(address: string, options?)`
(`node_modules/viem/_types/utils/address/isAddress.d.ts:15`) and
`isHash(hash: string)` (`.../utils/hash/isHash.d.ts:6`). Implementation
(`node_modules/viem/utils/address/isAddress.js`): same 40-hex regex, plus —
with the default `strict: true` — checksum validation on mixed-case input
(all-lowercase always passes), plus an LRU result cache.

Semantic deltas, stated honestly:

- Local accepts `unknown` and trims; viem takes `string` and does not trim.
  A thin wrapper (`typeof v === "string" && viemIsAddress(v.trim(), …)`)
  keeps the call sites unchanged.
- **Local accepts mixed-case addresses with a wrong EIP-55 checksum; viem's
  default rejects them.** For the create/buy input boundaries
  (`create-app.tsx:284`, routes) strict is arguably a bug fix — a typo'd
  paste gets caught instead of silently sent onchain — but it is a behavior
  change and needs a decision. `{ strict: false }` reproduces today's
  behavior exactly while still deleting the regex.

Verdict: worth doing with `strict: false` (pure delegation), and worth a
deliberate follow-up decision on `strict: true`. Small code delta either way;
the value is one canonical address validator (viem's) instead of two.

### 3. `src/lib/ui/toast.ts:22-31` — deprecated `document.execCommand("copy")` fallback

Primary path is already `navigator.clipboard.writeText`. The fallback exists
for non-secure contexts, but the Clipboard API covers HTTPS production and
`localhost` dev (https://developer.mozilla.org/en-US/docs/Web/API/Clipboard;
`execCommand` is deprecated:
https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand).
Deleting the fallback loses copy only on odd setups like LAN-IP dev servers.
Verdict: delete when nobody dev-serves over plain-HTTP LAN IPs.

## Considered and rejected (so the sweep is visibly complete)

- **`fmtUsd` "compact" branch (`src/lib/format.ts:19-24`) vs
  `Intl.NumberFormat` `notation: "compact"`** — Intl renders `$1.5M`; the
  hand-rolled branch deliberately renders `$1.50M` (two decimals for
  non-round millions) and whole-number `K`, tuned for chart axis labels
  (`src/lib/ui/chart.ts:236-238`). Replacement changes visible output for no
  code saving worth the churn.
- **`relDays` (`src/lib/format.ts:56-63`) vs `Intl.RelativeTimeFormat`** —
  Intl with `numeric: "auto"` says "tomorrow"/"yesterday" where the app says
  "in 1 day"/"1 day ago", and the `pastDates: false` mode needs the wrapper
  anyway. Net deletion ≈ zero.
- **Per-field `readContract` + `Promise.all` (`src/lib/chain/onchain.ts:355`,
  `offerings.ts:331-380`) vs wagmi `readContracts`/`multicall`** — both are
  exported by `wagmi/actions` (verified by import), but the repo's pattern is
  documented and deliberate: viem's client batches same-tick `eth_call`s into
  one multicall round trip (wagmi default `batch.multicall`,
  https://wagmi.sh/core/api/createConfig#batch) while keeping per-field
  return types. `readContracts` would be the same line count with weaker
  types. Keep.
- **Base64url codec (`src/lib/chain/voucher.ts:118-132`) vs
  `Uint8Array.prototype.toBase64`/`fromBase64`** — the platform replacement
  exists (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array/toBase64)
  but is not in Node 22 (repo `engines: node >=22.18`; the module runs under
  `node --test`). `Buffer.toString("base64url")` is Node-only, and the module
  also runs in the browser. Keep; revisit when the Node baseline reaches 24+.
- **`voucher.ts` local `isHex(value, bytes)`/`isSignatureHex`
  (`voucher.ts:155-160`)** — viem's `isHex` doesn't check byte length and
  `isHash` only covers 32 bytes; the 65–4096-byte ERC-1271 signature range is
  app policy. Keep.
- **`chunkRanges` (`src/lib/chain/offerings.ts:33`)** — viem exposes no
  public log-range chunking helper; the 10k-block cap is a Base-public-RPC
  policy. Keep.
- **`cx` classnames joiner (`src/components/ui.tsx:10`) vs adding `clsx`** —
  three lines of local code beat a dependency.
- **Canvas bonding-curve chart (`src/lib/ui/chart.ts`) vs a chart library** —
  one bespoke, styled, hover-interactive chart; any charting dependency is
  strictly heavier than the ~330 local lines and would fight the custom
  markers/slices. Keep.
- **`parseMoney`/`formatAmountInput` (`src/lib/format.ts:66-77`)** — live
  input masking; no installed library covers it, and a mask library is not
  warranted for one input style. Keep.
- **Validation in `decodeVoucherFragment` (`voucher.ts:169-193`) vs adding
  `zod`** — the hand checks are ~10 lines at one boundary; a schema library
  doesn't clear the add-a-dependency bar for the same rigor. Keep.
- **`offeringStatus`, curve math (`curve.ts`), `unitsForBudget` linear
  scan** — domain logic, no library equivalent; the scan is bounded at 1000
  units. Keep.

## Recommended shortlist, ranked

1. `generate-voucher-fixture.ts`: replace `key()` with
   `numberToHex(n, { size: 32 })`. Zero risk.
2. `validate.ts`: delegate `isAddress`/`isTxHash` bodies to viem
   `isAddress(v, { strict: false })` / `isHash(v)` behind the existing
   trim/coerce wrappers. Zero behavior change; one canonical validator.
3. Decide separately whether address inputs should be checksum-strict
   (`strict: true`) — a UX-visible safety upgrade, not a refactor.
4. `toast.ts`: drop the deprecated `execCommand` fallback if plain-HTTP dev
   over LAN isn't a workflow anyone uses.

No new dependency earns its place anywhere in the sweep.
