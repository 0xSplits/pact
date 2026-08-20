# PACT Contracts

PACT raises small onchain rounds by selling a slice of a project's cap
table along a linear bonding curve, in USDC on Base. Each raise is its own
`Offering` + `PactToken` pair, deployed and wired in one transaction by
`OfferingFactory`. Behavior is specified in the
[contract specification](docs/contracts.md).

This is a self-contained Foundry project; when running forge from the repo
root, pass `--root contracts`.

## Feature set

- **Liquid-split cap table**: a 1,000-unit ERC-1155 (token id 0) built on
  the 0xSplits LiquidSplit base, so units are live claims on revenue. One
  unit is 0.1% ownership; metadata is fully onchain.
- **Linear bonding curve**: exact integer pricing with no rounding surface
  — N single-unit buys cost the same as one N-unit buy. Every buy is
  slippage-bounded.
- **Two tranches**: permissionless public buys up to an issuer-adjustable,
  always-deliverable cap; the rest is claimable only through private
  allocations.
- **Two-key allocations**: an owner-signed EIP-712 voucher endorses a
  throwaway link key, and the link key signs the claiming buyer — the
  share link is the sole capability and claims cannot be redirected in the
  mempool. Contract-wallet issuers work (ERC-1271); rotating ownership
  mass-revokes outstanding links.
- **Refundable minimum**: a raise that misses its minimum by the close
  date can be declared failed by anyone; refunds reclaim the buyer's units
  and a permissionless sweep reverts the cap table to the founders.
- **Permissionless lifecycle**: withdrawal (proceeds can only reach the
  treasury), failure declaration, and the failed-units sweep need no
  privileged caller.

## Build

`forge build`

From the repo root, `npm run build:contracts` builds and regenerates the
frontend export (`src/generated/offering-contracts.ts`).

## Test

`forge test`

The suite covers units, buy-path fuzz tests, and accounting invariants.

### Stateful fuzzing

`FOUNDRY_PROFILE=fuzz medusa fuzz --config medusa.json`

The Medusa/Echidna harness lives in [test/fizz](test/fizz/README.md);
the properties it asserts are specified in
[PROPERTIES.md](../PROPERTIES.md).

## Format

`forge fmt`

The pinned upstream snapshots under [src/vendor](src/vendor) are excluded
via [foundry.toml](foundry.toml) and are never reformatted or edited.

## Deployment

`npm run deploy:factory` (from the repo root)

Deploys the factory via CREATE2; requires a funded key and
`ETHERSCAN_API_KEY`. The live pin is the v2 `OfferingFactory` at
`0xE07b04A47945DC6BEF217660F772b4D411Cd57fC` on Base (deploy block
49935597), mirrored in `src/generated/offering-contracts.ts`. The frontend
only scans the factory it pins, so a new factory deployment orphans every
offering created through the old one from listings.
