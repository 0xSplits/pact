# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PACT: raise small onchain rounds by selling a slice of a project's cap table — a custom liquid-split ERC-1155 (`PactToken`, token id 0, 1000 units = 100%) — along a linear bonding curve, in USDC on Base mainnet. Fully serverless: a static Vite app on Vercel with the chain as the only backend. Prototype. See `docs/architecture.md` for the system design and `contracts/docs/contracts.md` for the contract specification.

## Commands

- `npm run dev` — Vite dev server (http://localhost:5173)
- `npm run build` — static production build into `dist/` (what Vercel serves)
- `npm run typecheck` — `tsc --noEmit` (strict TS everywhere, plain `.ts`/`.tsx`)
- `npm test` — colocated unit tests (`vitest run` over `src/**/*.test.ts`; run against fakes, never real RPC)
- `forge test --root contracts` (or `npm run test:contracts`) — Solidity suite incl. fuzz + invariants (requires Foundry)
  - single test: `forge test --root contracts --match-test <name>`
- `FOUNDRY_PROFILE=fuzz medusa fuzz --config medusa.json` (from `contracts/`) — stateful Medusa fuzz suite (`contracts/test/fizz/`, specs in `PROPERTIES.md`); see `contracts/test/fizz/README.md`
- `npm run test:e2e` — Vite build then anvil-backed Playwright flow (`tests/pact-flow.spec.ts`, real local-chain transactions through a mocked EIP-1193 wallet; needs `forge build` artifacts)
- `npm run build:contracts` — after Solidity changes: `forge build` + regenerate `packages/core/src/generated/offering-contracts.ts` (checked in, so frontend builds don't need Foundry)
- `npm run deploy:factory` — CREATE2 factory deploy to Base (rare)

Node >= 22.18 (`.nvmrc` / `.tool-versions`). Imports use explicit `.ts` extensions so tests/scripts run on Node's native type stripping. CI (`.github/workflows/ci.yml`) runs fmt-check, forge, typecheck, units, and the e2e; Vercel deploys `main` independently of CI.

## Architecture

Two layers, one repo, with a shared chain module between them:

- **Contracts** (`contracts/`, self-contained Foundry project — always `--root contracts`): `OfferingFactory` deploys a per-issuance `Offering` + `PactToken` pair in one transaction. The Offering escrows units and sells them in two tranches — permissionless `buyPublic` up to an owner-adjustable `publicUnits` cap, and `buyPrivate` gated by owner-signed EIP-712 two-key vouchers (link key in the URL fragment signs the buyer at claim). Lifecycle: buy → `withdraw()` (permissionless once `minMet`, always pays `treasury`) → owner `closeAndWithdraw()`, or `markFailed()` + refunds (refund reclaims the buyer's units; `sweepFailedUnits` reverts the cap table to founders). `contracts/src/vendor/` holds pinned upstream snapshots — never reformat or edit them.
- **Frontend**: a static multi-page app — four HTML shells at repo root (Vite MPA routing; `cleanUrls` maps `/create` → `create.html`), each mounting one React app from `src/pages/` (home, create, status, buy). Routes are query-param style: `/status?offering=0x…`, `/buy?offering=0x…` `#<fragment>` for private claims. Wallets via wagmi (`src/lib/chain/wagmi.ts`); the browser's two adapters are `src/lib/chain/onchain.ts` (send adapter: wagmi public client typed as core's `ChainClient`, `sendCalls` over EIP-5792 or sequential transactions, the two buy flows) and `src/lib/chain/offerings.ts` (cache adapter: localStorage delta cache over core's scans, bigint stored as decimal strings). Reads use the app's own Base transport (env-keyed Alchemy or public RPC); the wallet only switches chains and signs.
- **Core** (`packages/core`, `@splits/pact-core`, private, zero-build, inlined into the CLI bundle): the chain layer both the app and the CLI (`packages/pact`) consume. `chain/reads.ts` (`readOffering`, `quote`, event decoders, `scan` (whole range first, 10k-block chunks on failure), `scanOfferings`/`findFactoryChild` (the factory-child invariant), `capTable`), `chain/writes.ts` (`Call`, encoders, `planBuy`: pure, units-driven, approve == `maxCost`), `chain/voucher.ts` (voucher codec + issuer's allocation ledger), `chain/curve.ts` (bonding-curve math), `chain/offering-status.ts`, `routes.ts`, `validate.ts`, `generated/offering-contracts.ts`. Amounts are bigint throughout core; adapters convert at their edges. Internal imports use `#core/*`; consumers import `@splits/pact-core/<path>.ts`.

### Sources of truth — don't conflate them

1. **Offering contract** — offering state, tranches, raised/withdrawn, minimum, close date. Always authoritative.
2. **PactToken** — cap table ownership (event scan + `balanceOf` over RPC).
3. **localStorage** — display convenience only: the listings delta cache (falls back to a full rescan when corrupt, never to wrong data) and the issuer's private-allocation ledger (unclaimed links exist nowhere else; claims are `Bought` events and survive).

Pages read the contract on load and poll while visible; live reads always beat cache.

## Conventions

- ES modules, strict TypeScript, explicit `.ts` import extensions; no default exports of config-like objects. Solidity stays Foundry.
- The `/create` flow only seeds the local cache and redirects after the `OfferingCreated` event is decoded — keep that ordering.
- Unit tests are colocated (`src/**/*.test.ts`) and take injectable fakes (`getLogs`, `storage`). The JS↔Solidity voucher boundary is pinned by `tests/fixtures/voucher-golden.json`, asserted by both suites — regenerate it only for intentional struct changes.
- For small frontend-only changes, prefer targeted manual browser checks against the running dev server; run the full suites before committing.
