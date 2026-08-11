# Onchain Offering

PACT uses a per-issuance `Offering` contract on Base. The offering escrows Liquid
Split units, sells them for USDC along a linear curve, and exposes lifecycle
actions for withdraw, close, failure, and refunds.

## Deployed Addresses

Base OfferingFactory:

```text
0x8bE9950470e0faC28Ed0fa590D972b466a6E0FE3
```

Official Base Liquid Split factory:

```text
0xdEcd8B99b7F763e16141450DAa5EA414B7994831
```

The factory address is embedded in `src/generated/offering-contracts.js`, which
the browser code imports directly.

## Creation Flow

`/create` calls `OfferingFactory.createOffering(...)` through the connected
wallet. The factory:

1. Deploys a per-issuance `Offering`.
2. Calls the official Base Liquid Split factory.
3. Mints founder units to the founder holders.
4. Mints offering units directly to the new `Offering`.
5. Initializes the `Offering` with the Liquid Split address.
6. Emits `OfferingCreated`.

The browser decodes `OfferingCreated` before saving the local issuance. If the
wallet prompt is rejected, the transaction reverts, or the event is missing, the
local issuance is not saved.

## Offering Contract State

The status and buy pages read:

- `remainingUnits`
- `unitsSold`
- `minMet`
- `state`
- `raised`
- `withdrawn`
- `raiseMin`
- `closeDate`
- `owner`
- `treasury`

Reads go through the public Base RPC (batched with Multicall3 where
available), so they work without a connected wallet and keep working if the
wallet is pointed at another chain. The pages poll while visible, and the
latest snapshot is cached locally as `onchainOffering` for faster first
paint — fresh contract reads always win.

## Buying

Buyer links carry a fixed dollar allocation amount from the issuer. The browser:

1. Reads current offering state.
2. Converts the dollar allocation into the largest affordable whole-unit purchase.
3. Reads USDC allowance for the offering.
4. Sends `approve(offering, maxCost)` if allowance is too low.
5. Calls `Offering.buy(unitsWanted, maxCost)`.
6. Marks the local allocation purchased after the buy transaction confirms.

Purchases deliver Liquid Split units immediately.

## Lifecycle Actions

- `withdraw()` is permissionless once `minMet` is true. Funds always go to
  `treasury`, so callers cannot redirect proceeds.
- `closeAndWithdraw()` is owner-only. It closes the offering, withdraws claimable
  USDC, and returns unsold Liquid Split units to treasury.
- `markFailed()` is permissionless after the close date only if `minMet` was never
  reached.
- `refund()` is buyer self-serve after failure.
- `refundAll(address[] buyers)` is owner-only after failure and pushes refunds to
  known buyer wallets.

Once `minMet` becomes true, the raise is successful permanently. The close date
then stops being buyer downside protection; the owner may keep selling, top up
more units, withdraw proceeds, or close.

## Cap Table

The Liquid Split is the cap table. It uses stock 1,000 ERC-1155 units with token
id `0`; one unit is 0.1% ownership.

The cap table section reads holder balances through the local Splits Explorer
proxy. If the indexed read fails, the browser falls back to direct Base RPC logs
and current `balanceOf(holder, 0)` calls.

## Contract Exports

After Solidity changes:

```sh
npm run build:contracts
```

This runs Foundry and exports ABI/bytecode into
`src/generated/offering-contracts.js`, which `src/lib/onchain.js` imports.
