# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PACT: raise small onchain rounds by selling a slice of a 0xSplits Liquid Split (ERC-1155, token id 0, 1000 units = 100%) along a linear bonding curve, in USDC on Base mainnet. Unaudited prototype. See `docs/` (architecture.md, onchain.md, testing.md, deployment.md) for full detail.

## Commands

- `npm run dev` — Vite dev server with the Express API mounted in-process (http://localhost:5173)
- `npm run build && npm start` — production shape: one Node process serving `dist/` + `/api` (port 7228)
- `npm test` — API/domain tests (`node --test tests/*.test.js`)
  - single file: `node --test tests/api.test.js`
- `forge test` — Solidity tests in `test/` (requires Foundry)
  - single test: `forge test --match-test <name>`
- `npm run test:e2e` — Vite build then Playwright browser flow (`tests/pact-flow.spec.js`, mocked EIP-1193 wallet, no real transactions)
- `npm run build:contracts` — after Solidity changes: `forge build` + regenerate `src/generated/offering-contracts.js` (checked in, so frontend builds don't need Foundry)

Node >= 22.12 (`.nvmrc` / `.tool-versions`). SQLite db lives at `data/pact.sqlite` (`PACT_DB_PATH` overrides, `PACT_RESET_DB=1` wipes on boot). Pushes to `main` auto-deploy to Fly.

## Architecture

Three layers, one repo:

- **Contracts** (`contracts/`): `OfferingFactory` deploys a per-issuance `Offering` that escrows Liquid Split units and sells them for USDC; lifecycle is buy → withdraw (permissionless once `minMet`, always pays `treasury`) → owner `closeAndWithdraw()`, or `markFailed()` + refunds if the minimum isn't met by close date.
- **Server** (`server.js` → `server/app.js`): Express serving the Vite build plus `/api` — PACT/allocation persistence in SQLite (`server/db.js`, `server/pacts.js`) and a Splits Explorer GraphQL proxy (`server/explorer.js`) for cap-table holder reads.
- **Frontend**: a multi-page app — four HTML shells at repo root, each mounting one React app from `src/pages/` (home, create, status, buy). Shared React primitives in `src/components/ui.jsx`; Tailwind v4 tokens/component classes in `src/app.css`. Wallet, settings, and debug-menu are framework-free modules bridged into React via hooks (`use-wallet.js`, `use-offering-state.js`).

Key `src/lib/` modules: `onchain.js` (all viem contract interaction; reads via public Base RPC, wallet only switches chain and signs), `wallet.js` (EIP-6963 discovery), `routes.js` (route construction/parsing), and framework-free modules also imported by the server (`curve.js`, `liquid-split.js`, `chain.js`, `validate.js`, `access.js`).

### Three sources of truth — don't conflate them

1. **Offering contract** — offering state, units, raised/withdrawn, minimum, close date. Always authoritative.
2. **Liquid Split** — cap table ownership (Splits Explorer proxy first, direct Base RPC fallback).
3. **Local SQLite** — PACT/allocation records, buyer names, receipts, and cached onchain snapshots (`onchainOffering`, `onchainCapTable`). The cached snapshots are client-reported and unauthenticated: display convenience only, never treat them as truth.

Pages read the contract on load, poll while visible, and prefer live reads over cache. The buy page self-heals: a wallet with an onchain deposit but no local purchase record gets recovered from the `Bought` event.

## Conventions

- ES modules throughout (`"type": "module"`); plain JS, no TypeScript.
- The `/create` flow only saves a local record after the `OfferingCreated` event is decoded — keep that ordering.
- For small frontend-only changes, prefer targeted manual browser checks against the running dev server; run the full suites before committing (see `docs/testing.md`, which also has the manual Base dust checklist).
