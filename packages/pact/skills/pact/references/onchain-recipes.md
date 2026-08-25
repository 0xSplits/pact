<!-- Generated from docs/integrate.md by packages/pact/scripts/sync.ts. Edit the source. -->

# Integrating with PACT

How to drive a PACT raise with direct contract calls, from any language or
agent. PACT has no HTTP API: the
[Offering contract](https://pact.splits.org/docs/contracts.md) is the whole backend.
This guide covers the calls every integration needs; the contract
specification holds the exact semantics, and the
[architecture](https://pact.splits.org/docs/architecture.md) the vocabulary.

Prefer a ready-made tool? `npx @splits/pact --help` wraps everything below
(unsigned transactions by default, `--format json` when relaying to a
signer), and `npx @splits/pact skills add` installs a knowledge skill into
every detected agent harness.

## Hard facts

|                       |                                                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chain                 | Base mainnet, chain id `8453`                                                                                                                                                                       |
| `OfferingFactory`     | `0x68DA9a884A6B5758a21490CeA5A1325C5f02eCdD` ([verified](https://basescan.org/address/0x68DA9a884A6B5758a21490CeA5A1325C5f02eCdD#code)); listings are `OfferingCreated` scans from block `50274529` |
| USDC                  | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals; every amount below is in base units                                                                                                       |
| ABIs                  | [`packages/core/src/generated/offering-contracts.ts`](https://github.com/0xSplits/pact/blob/main/packages/core/src/generated/offering-contracts.ts)                                                 |
| Machine-readable copy | [`/.well-known/pact.json`](https://pact.splits.org/.well-known/pact.json)                                                                                                                           |

The generated file is the pin: every copy of an address on every surface is
derived from it, so if this table and the file ever disagree, the file wins.

## Create an offering

One call on the factory deploys an `Offering` (escrow + curve + lifecycle)
and its `PactToken` (the 1,000-unit cap table) and emits `OfferingCreated`:

```solidity
function createOffering(
    string   projectName,      // stored on the token, emitted for listings
    uint256  raiseMin,         // minimum successful raise, USDC base units
    uint64   closeDate,        // unix seconds; buy deadline while the minimum is unmet
    uint256  priceStart,       // price of the first unit, USDC base units
    uint256  priceSlope,       // price increase per unit sold
    uint256  publicUnits,      // cap on permissionless buys; the rest needs vouchers
    address  treasury,         // receives proceeds and unsold units
    address  owner,            // signs vouchers, administers the offering
    address[] holderAccounts,  // founders (non-offering holders), at least one
    uint32[]  holderAllocations,
    uint32   offeringUnits     // units escrowed for sale
) external returns (address offering, address pactToken);
```

Rules the factory enforces: `holderAllocations` sum + `offeringUnits` must
equal `1000`; `publicUnits <= offeringUnits`; every founder allocation is
nonzero; `raiseMin` must be reachable by selling every offered unit; the
close date is in the future and `priceStart` is nonzero.

Pricing: unit `n` (zero-indexed across both tranches) costs
`priceStart + priceSlope * n`, so a valuation band maps to
`priceStart = floor / 1000` and `priceSlope = (ceiling - floor) / 1000 / offeringUnits`.

Decode `OfferingCreated(issuer, treasury, offering, pactToken, projectName,
raiseMin, closeDate, priceStart, priceSlope, publicUnits)` from the receipt;
`offering` is the id the app routes and the CLI take.

## Read status

All reads are plain `view` calls on the offering; the app batches them
through Multicall3.

| Getter                                              | Meaning                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `state()`                                           | `0` Funding, `1` Failed, `2` Closed                                |
| `minMet()`                                          | latched true once the minimum was met; refunds are then impossible |
| `raised()`, `withdrawn()`                           | deposits not yet refunded; proceeds already sent to treasury       |
| `raiseMin()`, `closeDate()`                         | the minimum and the deadline                                       |
| `unitsSold()`, `remainingUnits()`                   | curve position; units still in escrow                              |
| `publicUnits()`, `publicUnitsSold()`                | public cap and how much of it is sold                              |
| `priceStart()`, `priceSlope()`                      | curve parameters                                                   |
| `quote(units)`                                      | cost of `units` from the current position                          |
| `deposits(buyer)`, `unitsBought(buyer)`             | a buyer's refundable deposit and units                             |
| `allocationConsumed(id)`                            | whether a voucher was claimed or cancelled                         |
| `owner()`, `treasury()`, `pactToken()`, `factory()` | addresses                                                          |

Derived: an offering is _live_ while `state == 0` and either `minMet` or
`now <= closeDate`; past the close date with the minimum unmet it is
_expired_ and only `markFailed` applies.

Listing every offering: scan the factory's `OfferingCreated` logs from the
deploy block. Purchases are `Bought(buyer, allocationId, units, cost,
buyerName)` logs on each offering; the cap table is `TransferSingle` /
`TransferBatch` on the `PactToken` plus `balanceOf(holder, 0)`.

## Buy publicly

Two transactions, in order:

1. `USDC.approve(offering, maxCost)` with `maxCost = quote(units)`; exact
   amount, no infinite approvals.
2. `offering.buyPublic(units, maxCost, buyerName)`; reverts with `Slippage()`
   if the live cost moved above `maxCost`, `PublicAllocationExceeded()`
   past the public cap, `PastCloseDate()` after the deadline with the
   minimum unmet. `buyerName` is emitted only; pass `""` to stay anonymous.

Simulate both with `eth_call` before signing. Units land in the buyer's
wallet in the same transaction.

Before approving, confirm the address really is a PACT offering: it must
appear as `offering` in an `OfferingCreated` log of the pinned factory. A
contract that merely claims `factory()` could otherwise collect an approval.

## Withdraw, close, fail, refund

- `withdraw()`: permissionless once `minMet`; always pays the treasury.
- `closeAndWithdraw()`: owner only, requires `minMet`; ends the sale,
  withdraws, returns unsold units to the treasury.
- `markFailed()`: anyone, once the close date passed with the minimum unmet.
- `refund()`: a buyer in Failed reclaims their USDC; their full purchased
  unit balance must be in their wallet (the escrow pulls it back). Owners
  can push `refundAll(buyers[])`; `sweepFailedUnits()` then returns escrowed
  units to the treasury.

## Private allocations (vouchers)

A private buy is `buyPrivate(voucher, ownerSig, claimSig, units, maxCost)`
with two EIP-712 signatures under the offering's domain
(`name "PACT", version "1", chainId 8453, verifyingContract offering`):
the owner signs `Voucher(bytes32 allocationId, string buyerName, uint256
amountCapUsdc, address linkKey)` and the throwaway link key signs
`Claim(bytes32 allocationId, address buyer)`. The link key rides in the
claim URL fragment: `https://pact.splits.org/buy?offering=0x…#<fragment>`.
Mechanics and the fragment codec are in the
[contract specification](https://pact.splits.org/docs/contracts.md#allocations) and
`packages/core/src/chain/voucher.ts`; the CLI's `voucher issue` / `buy private`
implement both sides.
