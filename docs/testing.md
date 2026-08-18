# Testing

PACT has four checks plus manual Base dust verification. CI
(`.github/workflows/ci.yml`) runs all of them (plus `forge fmt --check`) on
every PR and push to `main`.

## Full pre-PR validation

```sh
npm run validate
```

This is the canonical readiness command. It runs typechecking, unit tests,
Solidity formatting and tests, regenerates/builds contract artifacts, and runs
the anvil-backed Playwright suite. It requires Foundry and an installed
Playwright Chromium browser (`npx playwright install chromium`). If it cannot
complete, keep the pull request in draft and report the exact failure.

When a user flow changes, update the corresponding Playwright scenario. CI's
`E2E Impact` job detects flow-sensitive changes under `src/pages/`,
`src/components/`, `src/lib/chain/`, and `src/lib/routes.ts`. If existing
Playwright coverage is already sufficient, replace the PR template's
`E2E impact override: none` with a concrete rationale. This exception only
documents why the specs did not change; the E2E suite must still pass.

## Solidity

```sh
forge test --root contracts        # or: npm run test:contracts
```

The Foundry suite (`contracts/test/`) covers `Offering`, `OfferingFactory`,
and `PactToken`: tranche buys, voucher verification, minimum thresholds,
withdrawals, close, refunds/sweeps, and metadata. It includes buy-path fuzz
tests and an invariant suite (`Invariant.t.sol`: handler + accounting
invariants, `runs = 1000`, `depth = 100`, `fail_on_revert`).

## Unit Tests

```sh
npm test          # vitest run over src/**/*.test.ts
npm run typecheck # tsc --noEmit
```

Unit tests are colocated with the modules they cover and run against fakes —
never real RPC. Covered areas include the voucher codec and ledger, the
event-scan delta cache and chunk math, allocation math, and routes.

## The Golden Vector

`tests/fixtures/voucher-golden.json` pins the JS↔Solidity voucher boundary:
one fixed voucher, its EIP-712 digest, and its signatures, asserted by both
`src/lib/chain/voucher.test.ts` and `contracts/test/GoldenVector.t.sol`. If
either side's hashing drifts, one of the suites fails. Regenerate it with
`node scripts/generate-voucher-fixture.ts` only when the voucher struct
intentionally changes.

## Browser Flow

```sh
npm run test:e2e
```

This builds the app with Vite, then runs Playwright (`tests/pact-flow.spec.ts`)
against `vite preview`. The global setup boots a throwaway anvil with Base's
chain id and etches MockUSDC at the Base USDC address the `Offering`
hardcodes, using the forge test artifacts — so run `npm run build:contracts`
after contract edits. The page's RPC is pointed at anvil via the
`PACT_RPC_URL` global, and the mocked EIP-1193 wallet forwards everything
(including `eth_signTypedData_v4`) to anvil's unlocked accounts, so the flows
submit real local-chain transactions.

Scenarios: issuer creates and signs a PACT through the UI; an issuer adjusts
the remaining public allocation; public and private buyers accept and sign the
purchase terms before submitting real transactions; a private allocation link
is claimed across two browser contexts (which exercises the real Solidity
voucher verifier); duplicate purchases are grouped in the wallet menu with the
correct page selection; and wallet detection and system-dark-mode behavior.

## Manual Base Dust Checklist

Before releasing meaningful changes, manually verify with small USDC amounts
on Base mainnet:

- Create an issuance from a wallet connected to Base; confirm the wallet
  prompts for `OfferingFactory.createOffering` and the redirect lands on the
  new status page.
- Confirm the offering appears on the home dashboard (event scan + cache).
- Buy from the public tranche; confirm USDC approval appears only when
  allowance is insufficient and the transaction link points to Basescan.
- Create a private allocation link, open it in another browser/wallet, and
  claim it; confirm the allocation shows funded on the status page and a
  revoked link stops being claimable.
- Confirm status page offering state reads raised, withdrawn, sold,
  available, minimum, and valuation from contract state.
- Confirm `withdraw()` shows the correct claimable amount and pays treasury.
- Confirm `closeAndWithdraw()` is enabled only for `owner` and closing
  returns unsold units to treasury.
- Create a failed offering path, mark failed after close, and verify buyer
  refunds reclaim units and `sweepFailedUnits` reverts the cap table.
- Confirm cap table holder balances render from onchain reads.

## Fast Checks During UI Iteration

For small frontend-only changes, prefer targeted manual browser checks while
the dev server is already running. Run the broader suites before committing.
