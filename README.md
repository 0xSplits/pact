# splits-pact

PACT (Purchase Agreement for Community Tokens) is a prototype for raising
small rounds by creating a cap table and selling a slice of the project's tokens (ERC-1155) along a bonding curve. A
minimum threshold makes the raise refundable if it is not met by the close
date.

The app currently targets Base mainnet and uses USDC for purchases.

> **Status: prototype.** The contracts are unaudited and the lifecycle flows
> have only been exercised with small amounts. Use at your own risk and with caution.

## App Surfaces

- `/` — connected-wallet dashboard, or a short explainer for what PACT is and how it works.
- `/create` — issuer form for creating a PACT and deploying the onchain offering.
- `/pacts/:id` — issuer dashboard for allocations, offering state, lifecycle actions, and cap table.
- `/pacts/:id/allocations/:allocationId` — buyer-facing purchase and receipt page.

Under the hood:

- `src/pages/` + `src/lib/` — the ES modules behind each page (built with Vite; styling is Tailwind v4 compiled at build time).
- `server.js` + `server/` — single Node process serving the Vite build (`dist/`) plus `/api`.
- `contracts/` — the `Offering` and `OfferingFactory` Solidity sources.
- `data/pact.sqlite` — local runtime database, ignored by git.

More detail:

- [Architecture](docs/architecture.md) (includes a full repository layout map)
- [Onchain Offering](docs/onchain.md)
- [Deployment](docs/deployment.md)
- [Testing](docs/testing.md)

## Local Development

Use Node 22.15.1 or newer. With `asdf`:

```sh
asdf install
asdf local nodejs 22.15.1
```

Install dependencies:

```sh
npm install
```

Start the dev server (Vite with the API mounted in-process):

```sh
npm run dev
```

Open the URL Vite prints (<http://localhost:5173/> by default).

To run the production shape locally, build and start the Node server:

```sh
npm run build
npm start
```

Open <http://localhost:7228/>.

By default the SQLite database is stored at `data/pact.sqlite`. Override it with:

```sh
PACT_DB_PATH=/tmp/pact.sqlite npm start
```

Reset a local database on boot with:

```sh
PACT_RESET_DB=1 npm start
```

## Environment

Local defaults are enough to run the app. Production should set:

```sh
PACT_DB_PATH=/data/pact.sqlite
SPLITS_EXPLORER_API_KEY=...
```

Optional:

```sh
PORT=7228
SPLITS_EXPLORER_GRAPHQL_URL=https://api.splits.org/graphql
PACT_RESET_DB=1
```

Do not use `PACT_RESET_DB=1` in production unless intentionally clearing data.

## Onchain Configuration

The browser code reads contract ABIs and the deployed OfferingFactory address
from `src/generated/offering-contracts.js`. All contract reads go through the
public Base RPC; the connected wallet is only asked to switch chains and sign.

Current Base OfferingFactory (unaudited — see status note above):

```text
0x8bE9950470e0faC28Ed0fa590D972b466a6E0FE3
```

Official Base Liquid Split factory:

```text
0xdEcd8B99b7F763e16141450DAa5EA414B7994831
```

Regenerate the contract exports (requires Foundry) with:

```sh
npm run build:contracts
```

The generated file is checked in so frontend builds do not require Foundry.

## Tests

Run Solidity tests:

```sh
forge test
```

Run API/domain tests:

```sh
npm test
```

Run browser flow tests:

```sh
npm run test:e2e
```

`npm run test:e2e` builds the app with Vite before running Playwright.

## Fly.io Deployment

See [Deployment](docs/deployment.md). The short version:

1. Fly app `splits-pact` runs from the checked-in `fly.toml`.
2. Persistent volume `pact_data` is mounted at `/data`.
3. `SPLITS_EXPLORER_API_KEY` is set as a Fly secret.
4. GitHub secret `FLY_API_TOKEN` enables auto-deploys from `main`.
5. Manual deploys still work with `fly deploy -a splits-pact`.

## Current Limitations

- Base mainnet only.
- SQLite is the persistence layer; Fly deployment needs a persistent volume.
- Allocation links are unauthenticated and rely on unguessable IDs.
- Issuer/buyer authorization is wallet-address gated in the UI, not
  signature-authenticated, and the cached onchain snapshots (`offering-state`,
  `cap-table-state`) are client-reported. Both are display conveniences; the
  contract remains the source of truth.
- Lifecycle flows have been manually tested with dust, but still need broader
  real-world testing before public use.
