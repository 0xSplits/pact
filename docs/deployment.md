# Deployment

Two independent deployables: the static app on Vercel, and the contracts on
Base mainnet. There is no server to operate.

## App (Vercel)

Production is `https://pact.splits.org`, served by Vercel as static files.
The GitHub integration auto-deploys `main` (and builds previews for PRs);
`vercel.json` is just `{ "cleanUrls": true }`, which maps `/create` →
`create.html` etc. — no rewrites, no functions.

Build-time environment variables (both optional; set them in the Vercel
project, mirror `.env.example` locally):

```sh
VITE_ALCHEMY_API_KEY=...            # Base RPC via Alchemy; falls back to the
                                    # rate-limited public RPC when unset
VITE_WALLETCONNECT_PROJECT_ID=...   # enables the WalletConnect connector
```

Both ship in the bundle, so the Alchemy key must be domain-restricted in the
Alchemy dashboard. Wallet `wallet_addEthereumChain` metadata is pinned to the
public RPC, so the keyed URL never enters a wallet.

## Contracts (Base)

The live pin is the v2 `OfferingFactory` at
`0xE07b04A47945DC6BEF217660F772b4D411Cd57fC` (deploy block 49935597,
Basescan-verified). Redeploying is only needed for contract changes, and
orphans every offering created through the old factory — the frontend only
scans the pinned factory's events.

To deploy a new factory:

1. Bump the CREATE2 salt in `contracts/script/Deploy.s.sol`
   (`"PACT OfferingFactory vN"`).
2. Run the deploy (broadcasts and verifies; needs a funded key and
   `ETHERSCAN_API_KEY` in the environment):

   ```sh
   npm run deploy:factory
   ```

3. Pin the new address and deploy block in
   `src/generated/offering-contracts.ts` from the broadcast output
   (`contracts/broadcast/Deploy.s.sol/8453/run-latest.json`), regenerating
   via `npm run build:contracts` and editing the pin if needed.
4. Ship the frontend pin change through a normal PR.

## CI

`.github/workflows/ci.yml` runs three jobs on PRs and pushes to `main`:
contracts (`forge fmt --check` + `forge test`), app (`typecheck` + unit
tests), and the anvil-backed Playwright e2e. There is no deploy step — Vercel
deploys independently of CI, so a red check does not block a push from going
live. Solidity deps (forge-std, solady) install with `npm ci`;
foundry-toolchain provides forge/anvil.

## Pre-Release Checklist

- `npm run typecheck`, `npm test`, `forge test --root contracts`, and
  `npm run test:e2e` pass.
- `src/generated/offering-contracts.ts` contains the intended factory address
  and deploy block (and is regenerated after any Solidity change).
- Manual Base dust checklist (see testing doc) for changes touching money
  flows.

## Operational Notes

Durable state is onchain (offerings, purchases, cap table) — losing a browser
profile loses only display caches and the issuer's unclaimed allocation
links, which can be re-issued.

The app has no login. Issuer actions are gated by the connected wallet
address in the UI (and by `onlyOwner` onchain); private allocations rely on
the voucher link being unguessable and one-shot.
