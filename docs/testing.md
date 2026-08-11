# Testing

PACT has three test layers plus manual Base dust checks.

## Solidity

```sh
forge test
```

These tests cover the `Offering` and `OfferingFactory` contracts: buys, minimum
thresholds, withdrawals, close, refunds, and factory-created Liquid Split setup.

## API and Domain Logic

```sh
npm test
```

This runs Node tests in `tests/*.test.js`.

Covered areas include:

- API persistence and validation
- local authorization/listing behavior
- Liquid Split allocation math
- onchain metadata sync shape

## Browser Flow

```sh
npm run test:e2e
```

This builds the app with Vite, then runs Playwright against the production
build served by `server.js`. The test uses a mocked EIP-1193 wallet. It does
not submit real Base transactions.

The browser flow creates an issuance, generates an allocation link, opens that
buyer link in a separate browser context, purchases, and verifies the status page
reflects the funded allocation.

## Manual Base Dust Checklist

Before public deployment, manually verify with small USDC amounts on Base:

- Create an issuance from a wallet connected to Base.
- Confirm the wallet prompts for the `OfferingFactory.createOffering` transaction.
- Confirm the issuance saves only after the factory event is decoded.
- Add an allocation and purchase from a buyer wallet.
- Confirm USDC approval appears only when allowance is insufficient.
- Confirm the buy transaction link points to Basescan.
- Confirm status page offering state reads raised, withdrawn, sold, available,
  minimum, and valuation from contract state.
- Confirm `withdraw()` shows the correct claimable amount and pays treasury.
- Confirm `closeAndWithdraw()` is enabled only for `owner`.
- Confirm closing returns unsold Liquid Split units to treasury.
- Create a failed offering path, mark failed after close, and verify buyer refund
  states on the buy page.
- Confirm cap table holder balances refresh from Splits Explorer or direct RPC
  fallback.

## Fast Checks During UI Iteration

For small frontend-only changes, prefer targeted manual browser checks while the
dev server is already running. Run the broader test suite before committing or
before deployment.
