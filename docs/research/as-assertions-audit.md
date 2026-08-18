# `as` assertion audit

_2026-08-17. Question: is the volume of `as` usage a symptom of type rot?_

**Verdict: no.** Excluding comments, prose, `as const`, and import aliases, the
hand-written TypeScript (~8.5k lines across `src/`, `tests/`, `scripts/`) contains
**21 real type assertions, zero `as unknown as X` double-casts, and one `as any`
in app code** (plus two in Playwright init scripts). Nearly all sit at genuine
trust boundaries — DOM events, `globalThis` override hooks, `process.env`, and
`JSON.parse` output — which is exactly where assertions belong: TypeScript's own
handbook frames `as` as the tool for when "you will have information about the
type of a value that TypeScript can't know about"
([Type Assertions, TS Handbook](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions)).
Three sites are avoidable and worth fixing; the rest should stay.

Note `as` is not a free-for-all: TypeScript only permits assertions between
overlapping types, so most of these are checked narrowings (e.g.
`EventTarget → Node`), not arbitrary reinterpretation. The escape hatches are
`as any` and `as unknown as X`, and the codebase has almost none.

## Inventory by category

### DOM / platform escape hatches — 5 sites, keep

`lib.dom.d.ts` types `Event.target` as `EventTarget | null`
(`node_modules/@typescript/typescript-darwin-arm64/lib/lib.dom.d.ts:14227`)
because listeners can be attached to anything; narrowing to `Node`/`HTMLElement`
in a handler is the standard idiom, not a smell.

- `src/components/wallet.tsx:152` — `e.target as Node` for `contains()`
- `src/hooks/use-error-tip.ts:16` — `e.target as HTMLElement | null` before `closest()`
- `src/lib/ui/debug-menu.ts:53` — `e.target as HTMLElement`
- `src/lib/ui/debug-menu.ts:62` — `e.target as Node`
- `src/components/wallet.tsx:42` — `(window as { ethereum?: unknown }).ethereum`;
  `window.ethereum` is wallet-injected and absent from `lib.dom.d.ts`, and the
  asserted shape types the property as `unknown`, forcing further checks.

### Untyped global / env boundary — 6 sites, keep

The e2e/manual override convention (documented at `src/lib/chain/chain.ts:16-19`)
reads values Playwright sets on `globalThis` before modules load. Those globals
are untyped by nature; each read asserts once at the single sanctioned entry
point (`globalOverride`, `src/lib/chain/chain.ts:20-21`, which widens to
`Record<string, unknown>` — a lossless assertion).

- `src/lib/chain/chain.ts:24` — `as string | undefined` (RPC URL override)
- `src/lib/chain/offerings.ts:138`, `src/lib/chain/onchain.ts:266` — `as Address | undefined` (factory override)
- `src/lib/chain/offerings.ts:143` — `override as number`, guarded by
  `Number.isInteger(override)` on the line above — a sound checked narrowing
- `tests/e2e-setup.ts:67` — `process.env.PACT_E2E_FACTORY as Address`; Node types
  env vars as `string | undefined`, and the harness sets this one itself

These trust the test harness to set well-formed values. For e2e-only hooks that
never run against user input, that is the right amount of ceremony.

### Validated narrowing at the boundary — 2 sites, keep (exemplary)

- `src/lib/chain/liquid-split.ts:30` — `as Address` after an `isAddress` guard
  two lines up; the comment explains why the widening happens (lowercasing
  returns `string`). This is the repo convention working as intended: validate,
  then assert, at one boundary.
- `scripts/generate-voucher-fixture.ts:19` — `as Hex` on
  `"0x" + n.toString(16).padStart(64, "0")` — correct by construction.

### Error-shape probing — 1 site, keep

- `src/pages/create-app.tsx:40` — walks an `unknown` error's `cause` chain by
  asserting to `{ code?: unknown; name?: unknown; message?: unknown; cause?: unknown }`.
  Every field stays `unknown`, so nothing unchecked leaks out. This is the safe
  pattern for probing thrown values.

### Test fixtures & scripts — 4 sites, keep

- `src/lib/chain/curve.test.ts:35` — `} as Pact` on a partial fixture; the test
  only exercises the fields provided.
- `tests/pact-flow.spec.ts:40`, `tests/pact-flow.spec.ts:465` — `window as any`
  inside `addInitScript` callbacks, which Playwright serializes into the page to
  plant the override globals described above.
- `scripts/export-contracts.ts:17-18` — casts on `JSON.parse` output
  (`abi as unknown[]`, `bytecode.object as string`). `JSON.parse` returns `any`,
  so these _add_ type information rather than remove it; `as unknown[]` is a
  tightening, not an escape.
- `tests/e2e-setup.ts:142` — `factoryArtifact.abi as Abi` on the same
  `JSON.parse`d Foundry artifact.

### Library-type workarounds — 3 sites, all fixable

These are the only assertions papering over something the types could express.

1. **`src/lib/chain/onchain.ts:77` — `} as any`** (the sole `as any` in `src/`).
   viem's `GetLogsParameters` is a three-way discriminated union — `{event,
events?: undefined}` | `{events, event?: undefined}` | both `undefined`
   (`node_modules/viem/_types/actions/public/getLogs.d.ts:15` ff.) — while the
   app's `GetLogsFn` (`src/lib/chain/onchain.ts:62-69`) makes `event` and
   `events` independently optional, so the spread can't be proven to inhabit any
   one branch. Fix: branch before calling —
   `filter.events ? client().getLogs({events: filter.events, ...}) : client().getLogs({event: filter.event, ...})` —
   and the cast disappears.

2. **`src/lib/chain/onchain.ts:232` and `:249` — `receipt.logs as Log[]`.**
   `ReceiptLike.logs` is deliberately `unknown[]` (`src/lib/chain/onchain.ts:90`)
   because EIP-5792 batch receipts carry raw-hex logs. But viem's
   `parseEventLogs` already accepts exactly that union — `logs: (Log | RpcLog)[]`
   (`node_modules/viem/_types/utils/abi/parseEventLogs.d.ts`, `ParseEventLogsParameters`).
   Typing `ReceiptLike.logs` as `(Log | RpcLog)[]` removes both casts and models
   the batch-receipt reality more precisely than `unknown[]` does.

3. **`src/lib/chain/onchain.ts:502` — `OFFERING_ABI as Abi`.** The generated ABI
   is `as const` (`src/generated/offering-contracts.ts:1378`), so `writeContract`
   would require `functionName` to be one of the ABI's literal function names —
   but `sendOfferingFunction` takes `functionName: string`
   (`src/lib/chain/onchain.ts:493`), so the ABI is widened to `Abi` to opt out.
   Fix: type the parameter as
   `ContractFunctionName<typeof OFFERING_ABI, "nonpayable" | "payable">` instead.
   That deletes the cast _and_ makes a typo'd function name a compile error at
   every call site (`withdrawOffering`, `closeAndWithdraw`, …) instead of a
   runtime revert.

## Judgement

The fear that heavy `as` usage signals broken types doesn't hold here — the raw
grep count is inflated by comments, JSX prose, `as const`, and import aliases
(31 of 52 hits). Of the 21 real assertions, 18 are boundary conversions the type
system cannot make for you: DOM event targets, injected wallets, test-harness
globals, env vars, and parsed JSON. They follow the house convention (validate,
then convert, once, at the boundary — see `liquid-split.ts:30` for the model
case), and the dangerous forms are essentially absent: no double-casts anywhere,
one `as any` in app code with a specific, documented cause.

The three fixes above (branch the `getLogs` params; type `ReceiptLike.logs` as
`(Log | RpcLog)[]`; use `ContractFunctionName` in `sendOfferingFunction`) would
bring app-code assertions down to boundary-only and make the last one a safety
upgrade, not just a cleanup. Everything else should be left alone — replacing
those assertions with runtime validation machinery would be ceremony without a
threat model, since none of them sit on user-input paths that aren't already
guarded.

## Resolution (2026-08-17)

All three fixes landed, with two corrections to the recommendations above:

1. **`getLogs` `as any`** — fixed as recommended: the call now branches on
   `event` vs `events` instead of spreading merged optionals. Cast deleted.
2. **`receipt.logs as Log[]`** — the recommendation was wrong: typing
   `ReceiptLike.logs` as `(Log | RpcLog)[]` doesn't survive the EIP-5792 batch
   path, because `WalletCallReceipt.logs` carries only
   `{address, data, topics}` (`viem/_types/types/eip1193.d.ts:69-80`), which is
   not assignable to `Log | RpcLog`. `ReceiptLike.logs` is now typed as that
   three-field shape (both producers satisfy it structurally, which deleted a
   fourth cast on the batch receipt itself), and the two `parseEventLogs` call
   sites keep a documented cast bridging viem's over-strict `(Log | RpcLog)[]`
   declaration — decoding only reads those three fields.
3. **`OFFERING_ABI as Abi`** — partially as recommended: `sendOfferingFunction`
   is now generic over `ContractFunctionName<typeof OFFERING_ABI>` with
   `ContractFunctionArgs`-typed args, so call sites get compile-checked names
   and argument tuples. The cast itself could not be deleted: wagmi's
   `writeContract` computes its parameter union over concrete function names
   and can't distribute it over a generic type parameter, so the call widens
   internally behind the strictly-typed wrapper signature.

Separately, the model-case assertion at `liquid-split.ts:30` no longer exists:
the whole `checksumOrLower` helper (validate + lowercase-fallback + cast +
injectable `getAddress`) was replaced by calling viem's `getAddress` directly,
which validates and already returns `Address`.
