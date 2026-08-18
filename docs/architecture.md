# Architecture

PACT is intentionally small: a static Vite-built multi-page frontend with the
chain as its only backend. There is no server, no database, and no API — every
read comes from Base RPC and every durable write is a transaction.

## Runtime

- `npm run dev` starts Vite (HMR included).
- `npm run build` emits the static site into `dist/`; production is that
  directory on Vercel (`cleanUrls` routing, no server code, no rewrites).
- A dev/preview middleware in `vite.config.ts` mirrors Vercel's `cleanUrls`
  (`/create` → `create.html` etc.) so local routing matches production.

## Repository Layout

```text
contracts/            self-contained Foundry project (run forge with --root contracts)
  src/                Offering, OfferingFactory, PactToken
  src/vendor/         pinned upstream snapshots (0xSplits LiquidSplit base, ERC-1155)
  test/               Foundry suite: Base.t.sol + per-contract files, fuzz,
                      invariant handler, golden-vector check
  script/Deploy.s.sol CREATE2 factory deploy
  foundry.toml        solc pin, fmt ignore for vendor, invariant profile
index.html            page shells (one per route; minimal head + mount point)
create.html
status.html
buy.html
src/
  pages/              one React app per page (+ its page-specific CSS)
  components/         shared React primitives (ui.tsx) and the wallet button
  hooks/              React bridges (use-offering-state, use-debug-menu)
  lib/chain/          everything onchain: wagmi config, viem interaction,
                      event-scan listings + delta cache, vouchers, curve math
  lib/ui/             framework-free widgets (toast, chart, debug menu)
  lib/                small shared utils (routes, validate, format, settings)
  generated/          contract ABIs + factory pin exported from Foundry artifacts
  app.css             Tailwind entry + design tokens + component classes
scripts/              contract export + voucher golden-vector generation
tests/                Playwright e2e (anvil-backed) + the shared golden fixture
docs/                 this documentation
```

Unit tests are colocated with the modules they cover (`src/**/*.test.ts`);
`tests/` holds only the browser flow and the JS↔Solidity fixture.

## Browser Surfaces

- `/` shows a connected-wallet dashboard when offerings exist; otherwise it
  explains what PACT is and links into the issuance flow.
- `/create` creates a PACT. It validates form fields, previews the
  capitalization/curve, connects a wallet, and calls
  `OfferingFactory.createOffering` — there is nothing to save anywhere else.
- `/status?offering=0x…` is the issuer dashboard: offering state, lifecycle
  actions, allocation links, and the cap table.
- `/buy?offering=0x…` is the buyer page for public purchases; a private
  allocation link appends `#<fragment>` carrying the voucher payload.

The offering contract address is the record id — routes are query-param style
so static hosting needs no path rewrites. Route construction/parsing lives in
`src/lib/routes.ts`.

Each page is a React app under `src/pages/`, mounted into its page's `#app`
element and built on the shared primitives in `src/components/ui.tsx`, which
map onto the design-system classes in `src/app.css`.

## Wallets and RPC

Wallet plumbing is wagmi (`src/lib/chain/wagmi.ts`): injected/EIP-6963
discovery, plus WalletConnect when `VITE_WALLETCONNECT_PROJECT_ID` is set —
the menu only lists wallets the browser actually has. The one exception is
Splits Connect: pinned first when its extension is installed, shown as a
Chrome Web Store link when not. All contract interaction flows through
`wagmi/actions` in `src/lib/chain/onchain.ts` — reads use the app's own Base
transport so they work without a wallet and regardless of which chain the
wallet is on; the wallet only switches chains and signs. Buys batch
approve+buy via EIP-5792 `sendCalls` when the wallet supports it.

The app transport resolves in `chain.ts`/`wagmi.ts`: a `PACT_RPC_URL` global
(e2e/manual override) wins outright, then Alchemy when `VITE_ALCHEMY_API_KEY`
is set (with the public RPC as fallback), else the rate-limited public Base
RPC. Wallet `wallet_addEthereumChain` metadata stays on the public RPC so a
keyed URL never enters a wallet.

## Data Sources

Two onchain sources of truth, plus localStorage as display convenience:

- **Offering contract**: offering state, units sold, remaining units, raised
  USDC, withdrawn USDC, minimum status, close date, owner, and treasury.
- **PactToken (the cap table)**: holder balances, read by scanning transfer
  events and confirming with `balanceOf` over Base RPC.
- **localStorage**: two distinct roles —
  - the _delta cache_ for listings (`src/lib/chain/offerings.ts`): the public
    RPC caps `eth_getLogs` at 10k-block ranges, so `OfferingCreated`/`Bought`
    scans are chunked; results are cached with the last scanned block and
    later visits only scan the delta. Cold scan on first visit per device.
  - the _allocation ledger_ (`src/lib/chain/voucher.ts`): the issuer's private
    allocation links (including revoked rows). Losing it loses unclaimed
    links; claims themselves are `Bought` events and survive.

Events are the truth, localStorage is convenience — a corrupt or missing
cache falls back to a full rescan, never to wrong data.

The status and buy pages read the offering contract on load and poll while
visible (`use-offering-state.ts`); server-state caching in React is
react-query.

## Styling

Tailwind v4 is compiled at build time through `@tailwindcss/vite` — there is
no runtime styling dependency. `src/app.css` declares the type scale and
color tokens in `@theme`, the CSS-variable design system (light plus a
`prefers-color-scheme: dark` palette), and the shared component classes.
Page-specific styles live next to each page (`src/pages/*.css`).

## Generated Files

- `src/generated/offering-contracts.ts` is generated from Foundry artifacts by
  `scripts/export-contracts.ts` (`npm run build:contracts`). It carries the
  ABIs (`as const`) plus the pinned factory address and deploy block, and is
  checked in so frontend builds do not require Foundry.
- `dist/` is the Vite build output (`npm run build`), ignored by git.

## Local Runtime Files

These are intentionally ignored by git: `dist/`, `cache/`, `out/`,
`broadcast/`, `test-results/`, `playwright-report/`.
