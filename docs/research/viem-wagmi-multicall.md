# Batched contract reads without positional index arithmetic (viem/wagmi)

Research notes, 2026-08-17. Question: are there better ways to consume
batched/multicall results than the flat-array index arithmetic in
`loadWalletRecords` (`src/lib/chain/offerings.ts`)?

```ts
const values = await readMany(calls); // wagmi readContracts, allowFailure: false
const raised = BigInt((values[i * 3] as bigint) ?? 0n);
const unitsSold = Number(values[i * 3 + 1] ?? 0);
```

Verified against the installed packages — viem `2.55.15`, wagmi `3.7.6`
(`@wagmi/core` vendored under `node_modules/wagmi/node_modules/@wagmi/core`) —
and confirmed with a strict `tsc` compile check against this repo's own
`OFFERING_ABI` (all claims below marked "compile-verified" passed
`--noEmit --strict`).

## Pattern 1 — `readContracts` / `multicall` with a tuple-literal `contracts` array

- **Result shape** (`allowFailure: false`): a plain array of decoded values,
  positionally typed when the input is a tuple. Docs: "`allowFailure: false`
  … Returns only the inferred data directly" —
  <https://viem.sh/docs/contract/multicall>.
- **Typing**: survives fully, per position. `MulticallResults` recurses over
  tuple types (`contracts extends readonly [infer contract, ...infer rest]`)
  and maps each element through `GetMulticallContractReturnType`
  (`node_modules/viem/_types/types/multicall.d.ts`). wagmi's action declares
  `readContracts<config, const contracts extends readonly ContractFunctionParameters[], …>`
  (`node_modules/wagmi/node_modules/@wagmi/core/dist/types/actions/readContracts.d.ts`)
  — the `const` type parameter means an *inline literal* array is inferred as a
  tuple with no `as const` needed. Compile-verified: with
  `functionName: "raised" | "unitsSold" | "minMet"` in three literal entries,
  `res[0]: bigint`, `res[2]: boolean`.
- **RPC cost**: one `aggregate3` `eth_call` round trip, chunked by `batchSize`
  (default 1024 bytes of calldata; `0` disables the limit) —
  <https://viem.sh/docs/contract/multicall>. wagmi falls back to sequential
  `readContract` calls only if the multicall itself throws
  (`node_modules/wagmi/node_modules/@wagmi/core/dist/esm/actions/readContracts.js`).
- **Fit for our dynamic list**: poor as-is. Tuple inference exists only for
  literal arrays. `records.flatMap(record => ["raised","unitsSold","remainingUnits"].map(…))`
  produces a non-tuple `ContractFunctionParameters[]`, and `MulticallResults`
  then degrades to a homogeneous array: the element type is the *union* of the
  possible return types (compile-verified: mapping over
  `["raised","unitsSold","remainingUnits"] as const` yields `bigint[]` — fine —
  but mixing in `"minMet"` would yield `(bigint | boolean)[]`, and a plain
  `string` functionName yields `unknown[]`). Per-position narrowing is
  unrecoverable for a runtime-length list — that is a TypeScript limitation,
  not a viem one.
- Note: our `readMany` wrapper (`src/lib/chain/onchain.ts`) erases even the
  union typing: its signature `(calls: ContractFunctionParameters[]) => Promise<unknown[]>`
  discards whatever inference the call sites could have kept.

## Pattern 2 — `allowFailure: true` (the default): per-call status objects

- **Result shape**: one object per call,
  `{ status: 'success', result } | { status: 'failure', error }` — a
  discriminated union (`MulticallResponse` in
  `node_modules/viem/_types/types/multicall.d.ts`; note the type-level literal
  is `'failure'`, not `'reverted'`). Docs: a reverted call "will fail silently
  and its error will be logged in the results array" —
  <https://viem.sh/docs/contract/multicall>,
  <https://wagmi.sh/core/api/actions/readContracts>.
- **Typing**: same tuple rules as pattern 1; `result` is per-call typed inside
  the `status === 'success'` branch (compile-verified).
- **RPC cost**: identical — one `aggregate3` round trip.
- **Fit**: doesn't remove index math by itself, but gives per-call failure
  granularity. Our current `readMany(...).catch(() => null)` throws away *all*
  live fields when *any* offering read reverts; `allowFailure: true` would
  degrade only the affected offering.

## Pattern 3 — transport-level `batch.multicall`: N typed `readContract` calls, one round trip

- **What it is**: the public client aggregates individual `eth_call`s
  (i.e. `readContract` calls) issued in the same scheduler window into a single
  `aggregate3` request —
  <https://viem.sh/docs/clients/public#eth_call-aggregation-via-multicall>.
  Mechanics in `node_modules/viem/_esm/actions/public/call.js`:
  `shouldPerformMulticall` (plain calls only — no `nonce`/`gas`/state
  overrides, not already an aggregate3 call), then `scheduleMulticall` batches
  by `client.uid` + block tag via `createBatchScheduler` with `wait: 0`
  (end of the current message queue) and splits chunks over `batchSize`
  (default 1024 bytes). Each inner call is sent with `allowFailure: true` and
  its own promise resolves/rejects individually.
- **Already enabled in this repo**: wagmi's `createConfig` defaults
  `batch: properties.batch ?? { multicall: true }` on every client it creates
  from `transports`
  (`node_modules/wagmi/node_modules/@wagmi/core/dist/esm/createConfig.js`,
  line 132). Our config (`src/lib/chain/wagmi.ts`) uses `transports` and does
  not override `batch`, so `getPublicClient(wagmiConfig)` already returns a
  batching client. No configuration change needed.
- **Result shape / typing**: each `readContract` resolves to its own fully
  inferred value — no array, no index. Compile-verified:
  `Promise.all([client.readContract({ …, functionName: "raised" }), …])`
  destructures to `bigint, bigint, boolean` against `OFFERING_ABI`.
- **RPC cost**: still one round trip for all calls issued in the same tick
  (e.g. one `Promise.all` across records), chunked at the same 1024-byte
  default as `readContracts`. Failure granularity is per call.
- **Fit for our dynamic list**: excellent — this is the pattern that dissolves
  the constraint. Instead of flattening per-record calls into one positional
  array, each record fires its own three typed reads; the transport reassembles
  them into one `aggregate3` behind the scenes.

## Pattern 4 — `useReadContracts` + `query.select` (React hooks)

- `select` "can be used to transform or select a part of the data returned by
  the query function" without affecting the cache —
  <https://wagmi.sh/react/api/hooks/useReadContracts>. Same typing rules as
  patterns 1–2 (tuple literal in the component keeps per-position types).
- **Fit**: not applicable here — `onchain.ts`/`offerings.ts` are deliberately
  framework-free (wagmi *actions*, not hooks), and the list is dynamic anyway.
  Noted for completeness.

## Other options noted

- **Deployless multicall** (`deployless: true` on the `multicall` action):
  for chains without a deployed Multicall3 — irrelevant on Base, which has it.
  <https://viem.sh/docs/contract/multicall>.
- **Name-zipping (in-house precedent)**: `getOfferingState`
  (`src/lib/chain/onchain.ts`) already avoids index drift by zipping results
  back to field names with `Object.fromEntries(fields.map((name, i) => [name, values[i]]))`.
  Runtime-only safety (no static types), but immune to insert/reorder bugs.

## Recommendation for this codebase

The current index arithmetic in `loadWalletRecords` is *defensible* — the call
list is runtime-length, so no viem/wagmi API can give per-position static types
for it, and the math is correct today. But it is the most fragile idiom
available, and the repo already ships two better ones:

1. **Cheapest fix, same wire shape**: build the per-record call list as
   `fields.map(…)` per record and zip results back to names, exactly as
   `getOfferingState` does. Kills the `i * 3 + 1` arithmetic and the
   `base = mine.length * 3` offset without changing `readMany` or the RPC
   traffic.
2. **Best fix, if touching it anyway**: drop the flattening entirely and issue
   per-record typed reads through the public client —
   `Promise.all(records.map(record => Promise.all([readContract(raised), readContract(unitsSold), …])))`.
   Because wagmi already enables `batch.multicall` on this repo's client, this
   still costs one `aggregate3` round trip per tick, restores full static
   typing (`bigint`/`boolean` inferred from `OFFERING_ABI`, which is
   `as const` in `src/generated/offering-contracts.ts`), and upgrades failure
   handling from all-or-nothing to per-call. `readMany`'s
   `Promise<unknown[]>` wrapper — the thing that erases types even where viem
   could infer them — becomes unnecessary for these paths.

Either way, prefer `allowFailure: true` (or per-call promises) over the current
`.catch(() => null)` so one reverting offering doesn't blank the live fields of
every other one.
