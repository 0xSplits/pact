# Architecture

PACT is intentionally small: a Vite-built multi-page frontend, a minimal Node
API, and SQLite storage.

## Runtime

- `npm run dev` starts Vite with the Express API mounted as dev middleware
  (single process, HMR included).
- In production, `server.js` starts one Express process serving the Vite build
  output from `dist/`.
- `/api` endpoints persist PACT and allocation records in SQLite.
- `/api/liquid-splits/:address/holders` proxies Splits Explorer GraphQL for cap
  table holder reads.
- `PACT_DB_PATH` controls the SQLite file path.

The production shape is one Node process serving both the built static files
and API routes.

## Repository Layout

```text
contracts/            Offering + OfferingFactory Solidity sources
test/                 Foundry tests for the contracts
server.js             production entry point (thin: starts server/app.js)
server/
  app.js              Express wiring: /api routes + static serving
  pacts.js            domain operations over PACT records
  explorer.js         Splits Explorer GraphQL proxy
  db.js               SQLite open/read/write + id generation
  parse.js            tolerant parsing of client-supplied values
index.html            page shells (one per route; minimal head + mount point)
create.html
status.html
buy.html
src/
  pages/              one React app per page (+ its page-specific CSS)
  components/ui.jsx   shared React primitives (Button, Field, Notice, ...)
  lib/                shared browser modules (several also used by server/)
  generated/          contract ABIs exported from Foundry artifacts
  app.css             Tailwind entry + design tokens + component classes
tests/                node:test suites and the Playwright browser flow
docs/                 this documentation
```

## Browser Surfaces

- `/` shows a connected-wallet dashboard when records exist; otherwise it
  explains what PACT is and links into the issuance flow.
- `/create` creates a PACT. It validates form fields, previews the
  capitalization/curve, connects a wallet, deploys the onchain offering, then
  saves the record through the API.
- `/pacts/:id` is the issuer dashboard. It shows offering details/state,
  lifecycle actions, allocation links, and the cap table.
- `/pacts/:id/allocations/:allocationId` is the buyer page. It quotes the
  allocation against current onchain offering state, submits USDC approval if
  needed, calls `Offering.buy`, and renders receipt/refund states.

Each page is a React app under `src/pages/`, mounted into its page's `#app`
element and built on the shared primitives in `src/components/ui.jsx`, which
map onto the design-system classes in `src/app.css`. The wallet, settings, and
debug-menu widgets are framework-free modules bridged into React through
hooks. Shared browser modules live under `src/lib/`:

- `api.js` wraps local API calls.
- `routes.js` owns route construction and parsing.
- `wallet.js` owns wallet connection (EIP-6963 discovery) and the wallet menu;
  `use-wallet.js` exposes the connected account to React.
- `use-offering-state.js` polls the offering contract while the tab is
  visible so onchain changes appear without a manual reload.
- `onchain.js` performs all contract interaction (via viem). Reads go through
  the public Base RPC; the wallet only switches chains and signs.
- `chain.js`, `curve.js`, `liquid-split.js`, `validate.js`, `access.js` hold
  constants, bonding-curve math, factory-input construction, and shared
  validation — all framework-free and importable from the server.
- `chrome.js` injects the shared top-right controls; `toast.js` renders
  transient confirmations; `settings.js` owns the style switcher;
  `chart.js` renders the issuance creation curve chart; `debug-menu.js` is the
  localhost-only offering-state preview; `format.js` holds display formatting.

## Styling

Tailwind v4 is compiled at build time through `@tailwindcss/vite` — there is
no runtime styling dependency. `src/app.css` declares the type scale and
color tokens in `@theme`, the CSS-variable design system (with the
Clarity/Cipher/Chambers presets), and the shared component classes.
Page-specific styles live next to each page (`src/pages/*.css`).

## Data Sources

The UI deliberately separates three sources of truth:

- **Local SQLite**: PACT records, allocation records, buyer names, intended
  allocation amounts, purchase receipts, and cached onchain snapshots.
- **Offering contract**: offering state, units sold, remaining units, raised
  USDC, withdrawn USDC, minimum status, close date, owner, and treasury.
- **Liquid Split**: cap table ownership. Holder balances are read through
  Splits Explorer first, with a direct Base RPC fallback in the browser.

The status and buy pages read the offering contract on load and then poll
while visible. Fresh reads are cached server-side (`onchainOffering`,
`onchainCapTable`) so the next page view can render immediately, but display
state always prefers the live read. The cached snapshots are client-reported
and unauthenticated — they are a display convenience, never a source of truth.

If a purchase settles onchain but the browser dies before the local record is
written, the buyer page recovers it: when the connected wallet has a deposit
in the offering but no recorded purchase, the `Bought` event is looked up and
the allocation is marked funded.

## Generated Files

- `src/generated/offering-contracts.js` is generated from Foundry artifacts by
  `scripts/export-contracts.js` (`npm run build:contracts`). It is checked in
  so frontend builds do not require Foundry.
- `dist/` is the Vite build output (`npm run build`), ignored by git and built
  inside the Docker image.

## Local Runtime Files

These are intentionally ignored by git:

- `dist/`
- `data/`
- `.tmp/`
- `cache/`
- `out/`
- `broadcast/`
- `test-results/`
- `playwright-report/`

An empty database is valid; the server creates the required schema on boot
(and renames the pre-rename `raises` table to `pacts` if it finds one).
