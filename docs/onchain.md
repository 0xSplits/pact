# Onchain Offering

PACT uses a per-issuance `Offering` contract on Base paired with a custom
`PactToken` cap table. The offering escrows PactToken units, sells them for
USDC along a linear curve in two tranches (public and voucher-gated private),
and exposes lifecycle actions for withdraw, close, failure, and refunds.

## Deployed Addresses

Base `OfferingFactory` (CREATE2, salt `"PACT OfferingFactory v2"`):

```text
0xE07b04A47945DC6BEF217660F772b4D411Cd57fC   (deploy block 49935597)
```

0xSplits `SplitMain` v1 on Base (the factory's only external dependency):

```text
0x2ed6c4B5dA6378c7897AC67Ba9e43102Feb694EE
```

The factory address and deploy block are pinned in
`src/generated/offering-contracts.ts`; the deploy block is the lower bound
for every `OfferingCreated` event scan.

## Creation Flow

`/create` calls `OfferingFactory.createOffering(...)` through the connected
wallet. In one transaction the factory:

1. Deploys a per-issuance `Offering`.
2. Deploys the `PactToken`, minting founder units to the holder accounts and
   offering units directly to the new `Offering`.
3. Initializes the `Offering` with the PactToken address.
4. Emits `OfferingCreated`, which carries everything a listing renders
   (issuer, treasury, offering, token, project name, curve params, minimum,
   close date, public-tranche cap) — the factory keeps no registry.

If any step fails the whole transaction reverts; no partial offering/token
pair is left behind. On success the create page seeds the local delta cache
from the decoded event and redirects to the status page.

## PactToken

The cap table is a custom liquid split: an ERC-1155 inheriting the 0xSplits
`LiquidSplit` base (vendored under `contracts/src/vendor/`), so its 1,000
units of token id `0` are real claims on split proceeds via SplitMain. One
unit is 0.1% ownership.

- `uri()` is fully onchain (name + SVG), so wallets and marketplaces render
  the project without any server.
- Total supply stays exactly 1,000 — LiquidSplit distribution math reverts on
  holes, so there is no burn path anywhere.
- The Offering is hardwired as an approved operator, which is what lets
  refunds reclaim units without a buyer approval transaction.
- `distributeFunds` reverts while the offering is still Funding: the curve
  prices units off `unitsSold` alone, so a mid-raise distribution would let a
  buyer purchase revenue-blind units and atomically capture banked revenue.
  Once Closed or Failed it is permissionless as usual. Accepted residual: in
  Failed, revenue accrued before the failure stays distributable by holders
  who have not yet refunded.

## Two Tranches

Both tranches share one linear curve (`costFor` over total units sold).

- **Public**: `buyPublic(unitsWanted, maxCost, buyerName)` is permissionless
  up to `publicUnits`, an owner-adjustable cap (`setPublicUnits`). The
  advertised cap is always deliverable: private claims cannot consume the
  unsold public tranche (`PublicReservationExceeded`), and `setPublicUnits`
  cannot exceed what the escrow can still deliver — to make a large private
  allocation the owner first lowers `publicUnits`, on the record.
- **Private**: the rest is claimable only via allocation vouchers.
  `buyPrivate` takes an owner-signed EIP-712 voucher endorsing a throwaway
  per-allocation _link key_; the link key rides in the share URL fragment and
  signs the claiming buyer's address at purchase time, so the link is the
  sole capability and a claim in the mempool can't be frontrun. Both
  signatures are EIP-712 under the offering's own domain (chain id +
  contract address), so neither replays against a same-address deployment
  on another chain. Vouchers are
  USDC-capped, one-shot (`AllocationAlreadyConsumed`), and have no expiry;
  the owner can revoke one with `cancelAllocation`. A voucher caps dollars,
  not price: buys between issuance and claim move the shared curve, so the
  claimer's units-per-dollar is set at claim time — they see the live quote
  and bound it with `maxCost`, and no signed field pins a curve position.

Voucher signatures verify against the live `owner()` via ERC-1271-aware
checking, so smart-wallet/passkey issuers work — and an ownership rotation
mass-revokes every outstanding link (the right default under key compromise;
re-issuing links is free). `Bought` events carry the buyer name and
allocation id, which is how purchases render everywhere without a database.

## Offering Contract State

The status and buy pages read `state` (`Funding`/`Failed`/`Closed`),
`remainingUnits`, `unitsSold`, `publicUnitsSold`, `minMet`, `raised`,
`withdrawn`, `raiseMin`, `closeDate`, `owner`, and `treasury`.

Reads go through the app's Base transport (batched with Multicall3), so they
work without a connected wallet and keep working if the wallet is pointed at
another chain. The pages poll while visible; listings come from chunked
event scans with a localStorage delta cache (see architecture doc).

## Lifecycle Actions

- `withdraw()` is permissionless once `minMet` is true. Funds always go to
  `treasury`, so callers cannot redirect proceeds.
- `closeAndWithdraw()` is owner-only. It closes the offering, withdraws
  claimable USDC, and returns unsold units to treasury.
- `markFailed()` is permissionless after the close date only if `minMet` was
  never reached.
- `refund()` is buyer self-serve after failure. It reclaims the buyer's full
  purchased units back to escrow in the same call and pays only if the full
  amount is recovered — a buyer who transferred units away mid-raise forfeits.
  A forfeited or undeliverable deposit (units gone, or the buyer permanently
  USDC-blocklisted) stays counted as buyer liability: no one — buyer, owner,
  or treasury — can reach it, an accepted trade-off for keeping deposits
  unstealable.
- `refundAll(address[] buyers)` is owner-only after failure. Each buyer is an
  atomic step; a failing transfer (e.g. USDC blocklist) emits
  `RefundSkipped` and continues, and skipped buyers keep the pull path.
- `sweepFailedUnits()` is permissionless and repeatable after failure: it
  sweeps escrow-held units (unsold + reclaimed) to treasury, reverting the
  cap table to the founders. If the sweep lands all 1000 units on one address
  (treasury pointed at the sole remaining holder), `distributeFunds` reverts —
  SplitMain requires at least two recipients — until any 1 unit moves; revenue
  meanwhile sits in the PactToken/split, retryable. Accepted as a documented
  footgun: owner-triggered, self-inflicted, and self-healing.
- `rescue(token, to)` / `skimUsdc()` are owner-only recovery for stray tokens
  and USDC in excess of buyer liability (e.g. split revenue pushed in by
  SplitMain's permissionless withdraw). Buyer liability is always
  `raised − withdrawn` (`raised` decrements on refund).
- Ownership transfer is two-step (`transferOwnership` + `acceptOwnership`).

Once `minMet` becomes true, the raise is successful permanently. The close
date then stops being buyer downside protection; the owner may keep selling,
withdraw proceeds, or close.

## Audit Posture

The 2026 audit findings are addressed in this deployment: refunds reclaim
units and failure sweeps them (H-1/H-2), Base USDC is hardcoded
(H-3/M-1/M-2, with `rescue`/`skimUsdc` for recovery), `refundAll` skips
blocklisted buyers (M-3), ownership transfer is two-step (M-4), and the
factory rejects a `raiseMin` the curve cannot reach (M-5). Two findings are
**accepted with rationale** rather than fixed:

- **H-4 — owner can self-fund the minimum, then withdraw.** Any owner-keyed
  restriction is sybil-trivial to defeat with a fresh wallet, and delaying
  withdrawals to the close date degrades the honest-creator product without
  closing the hole. The minimum is a coordination signal, not a trustless
  guarantee; PACT's trust model is reputational.
- **M-6 — treasury is hot-swappable mid-raise.** `setTreasury` grants the
  owner no power they don't already hold (the owner is the party being
  funded; withdrawals go to treasury either way). Re-pointing to a multisig
  mid-raise is the legitimate use.

M-7 (open `buy()`) is resolved by the two-tranche design itself.

## Contract Exports

After Solidity changes:

```sh
npm run build:contracts
```

This runs Foundry (`--root contracts`) and exports ABI/bytecode plus the
factory pin into `src/generated/offering-contracts.ts`, which the browser
code imports. It is checked in so frontend builds do not require Foundry.
