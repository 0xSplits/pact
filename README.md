# pact

PACT (Purchase Agreement for Community Tokens) is a prototype for raising
small rounds by creating a cap table and selling a slice of the project's
tokens (ERC-1155) along a bonding curve. A minimum threshold makes the raise
refundable if it is not met by the close date.

The app targets Base mainnet, uses USDC for purchases, and is fully
serverless: a static site whose only backend is the chain.

> **Status: prototype.** The contracts are unaudited beyond a first review and
> the lifecycle flows have only been exercised with small amounts. Use at your
> own risk and with caution.

## Integration

Base mainnet (chain id `8453`). `OfferingFactory`:
[`0x68DA9a884A6B5758a21490CeA5A1325C5f02eCdD`](https://basescan.org/address/0x68DA9a884A6B5758a21490CeA5A1325C5f02eCdD#code).

- [`docs/integrate.md`](docs/integrate.md) — create, read status, approve + buy, withdraw/refund, by direct contract call
- [`/llms.txt`](https://pact.splits.org/llms.txt) — index for agents; [`/.well-known/pact.json`](https://pact.splits.org/.well-known/pact.json) — machine-readable addresses and pointers
- `npx @splits/pact --help` — CLI + MCP server (`--mcp`) + agent skill (`skills add`), see [`packages/pact`](packages/pact)

## App Surfaces

- `/` — connected-wallet dashboard, or a short explainer for what PACT is and how it works.
- `/create` — issuer form for creating a PACT and deploying the onchain offering.
- `/status?offering=0x…` — issuer dashboard for allocations, offering state, lifecycle actions, and cap table.
- `/buy?offering=0x…` — buyer-facing purchase and receipt page; private allocation links append `#<fragment>`.

Under the hood:

- `src/pages/` + `src/lib/` — the modules behind each page (React + strict
  TypeScript, built with Vite; wallets via wagmi; styling is Tailwind v4
  compiled at build time).
- `contracts/` — self-contained Foundry project: `Offering`,
  `OfferingFactory`, and the `PactToken` cap table.

More detail:

- [Architecture](docs/architecture.md) — system-level design and vocabulary
- [Contract Specification](contracts/docs/contracts.md)

## Local Development

Requires Node 22.18+ (`.nvmrc` pins 22.20.0; `nvm use` or `asdf install`
picks it up).

Install dependencies and start the dev server:

```sh
npm install
npm run dev
```

Open the URL Vite prints (<http://localhost:5173/> by default).

To run the production shape locally, build and preview the static output:

```sh
npm run build
npx vite preview
```

## Onchain Configuration

The app and the CLI read contract ABIs and the pinned `OfferingFactory`
address and deploy block from `packages/core/src/generated/offering-contracts.ts`, the shared chain layer. All contract reads go through the
app's own Base transport; the connected wallet is only asked to switch chains
and sign.

Current Base OfferingFactory (see status note above):

```text
0x68DA9a884A6B5758a21490CeA5A1325C5f02eCdD
```

Regenerate the contract exports (requires Foundry) with:

```sh
npm run build:contracts
```

## Tests

```sh
npm run validate              # full pre-PR suite (Foundry + Playwright required)

forge test --root contracts   # Solidity: unit, fuzz, invariants
npm test                      # colocated unit tests against fakes

cd contracts && FOUNDRY_PROFILE=fuzz medusa fuzz --config medusa.json
                              # stateful fuzzing campaign (see contracts/test/fizz/README.md)
npm run typecheck             # tsc --noEmit
npm run test:e2e              # anvil-backed Playwright browser flow
```

CI runs all of these plus `forge fmt --check` on every PR and push to `main`.
Pull requests also run an E2E-impact check: flow-sensitive frontend changes
must update a Playwright spec or include the template's explicit, concrete
`E2E impact override` rationale. The override does not waive running E2E.

## Deployment

Vercel serves the static build and auto-deploys `main`
(`https://pact.splits.org`); contracts redeploy rarely via
`npm run deploy:factory`, followed by re-pinning the factory address in
`packages/core/src/generated/offering-contracts.ts`.

## Current Limitations

- Base mainnet only.
- The issuer's private allocation links live only in that browser's
  localStorage ledger; losing it loses unclaimed links (claims are onchain
  events and survive). Links rely on being unguessable and one-shot.
- Issuer/buyer authorization is wallet-address gated in the UI plus
  `onlyOwner` onchain; there is no signature login.
- First cold visit per device scans factory events over RPC before listings
  appear; later visits only scan the delta.
- Lifecycle flows have been manually tested with dust, but still need broader
  real-world testing before public use.

## License

[MIT](LICENSE).
