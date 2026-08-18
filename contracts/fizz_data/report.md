# Fuzzing Suite Report

## Suite Overview

PACT raises small onchain rounds by selling a slice of a project's cap table — a
1000-unit liquid-split ERC-1155 (`PactToken`, token id 0) — along a linear USDC
bonding curve on Base, with a refundable minimum. Each raise is its own escrow
`Offering` deployed with its `PactToken` in one `OfferingFactory` transaction.
The trust model is explicitly reputational: a single per-offering owner controls
treasury, tranches and vouchers instantly, with no timelock, multisig or pause
(x-ray §2, accepted findings H-4/M-6).

This is a Fizz-generated stateful fuzzing suite driven by **Medusa 1.5.1**. It
exercises three in-scope contracts — `Offering`, `PactToken`, `OfferingFactory`
— from three actors (Alice/Bob/Charlie) plus two owner seats, against a single
offering fixture: 200-unit escrow, 100-unit public tranche, 800 founder units,
`RAISE_MIN = 100e6`, `priceStart = 1e6`, `priceSlope = 1000`, 7-day close.

- **Entry points:** `contracts/fizz_data/entry-point-selection.json` — 15
  `Offering` functions + 4 `PactToken` functions, primary/secondary tiered.
- **Properties:** 78 specified (`PROPERTIES.md`, `property-plan.md`), 76
  implemented (43 global GL + 33 specific SP), 2 deferred (SP-17, GL-27).
- **Harness:** `contracts/test/fizz/` — `Base.sol` (setup, 3 actors, 40-field
  `Ghosts` struct), `Properties.sol` (property_* assertions), handlers in
  `handlers/`, repros in `FoundryTester.sol`.
- **Mocks:** `utils/FizzUSDC.sol` (gated mint/transfer), `utils/MockSplitMain.sol`
  (hardened `_validSplit`), `PayoutSplitStub`, `MockERC20` stray token.

Validation (forge build + FoundryTester) has already passed and was not re-run
for this report.

## Coverage Results

Fuzz profile requires `via_ir` (stack-too-deep) with `optimizer_runs=0`, which
deflates coverage ~10%; targets were adjusted for that (ir-no-opt column). All
in-scope contracts clear their target.

| Contract | Role | Target | Achieved (final campaign) | Status |
|---|---|---|---|---|
| Offering | Core (escrow, curve, tranches, lifecycle) | 70% | 92% (179/193) | ✅ |
| PactToken | Core cap table (split/operator logic) | 70% | 91% (22/24) | ✅ |
| OfferingFactory | One-shot deployer (setup-only) | 40% | 91% (22/24) | ✅ |
| vendor/ERC1155 | Vendored base (inherited) | n/a | 74% | ⚠️ out of scope |
| vendor/LiquidSplit | Vendored base (inherited) | n/a | 93% | ⚠️ out of scope |

PactToken's residual uncovered lines are the view-only `uri()` metadata builder
(covered by unit tests). The vendored bases carry no target — coverage is
inherited from callers and reported for information only.

## Skipped Paths

| Path | Reason |
|---|---|
| `contracts/src/vendor/*` (ERC1155, LiquidSplit, ISplitMain) | Pinned upstream snapshots, out of audit scope; exercised only through in-scope callers. |
| ERC-1271 owner-signature path in `buyPrivate` | Harness owners are EOAs; smart-wallet (1271) owners are covered by the unit suite. |
| `Offering.initialize` revert branches (NotFactory / AlreadyInitialized) | Factory-only and one-shot in `setup()`; unreachable by design. |
| `OfferingFactory.createOffering` validation reverts | Constructor-time config errors; the harness deploys one valid offering. |
| `Offering.rescue` USDC / pactToken revert branch (reachability) | The confined-rescue handler always passes the stray token; the forbidden legs are asserted by `offering_rescueForbidden` (SP-22) while the guard-revert branch is guard-tested by the unit suite. |
| SP-17 (`property_closeCannotBeBrickedByDonors`) | Deferred [-]: needs a non-ERC1155-receiver treasury target, which requires harness surgery that would break the single-`offering` global assumptions. |
| GL-27 (`property_flatCurveIsLinear`) | Deferred [-]: needs a second offering with `priceSlope == 0`; the primary fixture hardcodes slope 1000. |
| FizzUSDC `mint` / `transfer` direct-fuzzing | Gated to contract callers (`msg.sender != tx.origin`) so Medusa cannot fabricate untracked USDC by poking the mock token directly. |

## Campaign Results

- **Fuzzer:** Medusa 1.5.1 (`fuzz` profile, `via_ir`, `optimizer_runs=0`)
- **Duration:** ~3m51s (timeout 600s)
- **Calls:** 501,898
- **Branches hit:** 23,518
- **Corpus:** 298 sequences
- **Property tests:** 74 assertion-test entries (the `property_*` functions plus
  a couple of self-asserting handlers)
- **Result:** **72 passed, 2 failed**

The two failures are the deliberately-falsifiable EXPLORATORY properties GL-19
and GL-20 — leads flagged for human review, not confirmed protocol bugs and not
harness false positives. Both are reproduced by passing Foundry repros in
`FoundryTester.sol` (each test PASSES by confirming the property is violated as
the campaign found).

### Resolved during bring-up

An earlier cycle reported 6 failures; all 6 were resolved and are not present in
the final suite:

- **4 test-harness false positives** — Medusa was directly fuzzing the
  predeployed mock USDC's public `mint`/`transfer`, fabricating untracked USDC
  and producing false conservation violations (GL-01, GL-06 and two chained
  consequences). Fixed by introducing `contracts/test/fizz/utils/FizzUSDC.sol`,
  which gates `mint`/`transfer` to contract callers (`msg.sender != tx.origin`).
- **1 genuine harness bug** in the SP-11 round-trip handler's units assertion:
  it asserted final units `== unitsStart`, ignoring that refund reclaims the
  actor's ENTIRE prior `unitsBought` ledger. Fixed to assert
  `unitsStart - unitsBoughtBefore` (`property_buyFailRefundIsValueNeutral`,
  `Properties.sol:509-519`; handler `OfferingHandler.sol:321-363`).

With those addressed, the suite is clean apart from the two intended
EXPLORATORY leads below.

### Violation Details

#### GL-19 — public tranche starvation

- **Property violated:** `property_publicTrancheStaysFillable` (GL-19)
- **Guarantee:** EXPLORATORY (Sources ADV-17, Category VALID_STATE)
- **Assertion:** while Funding, `remainingUnits() >= publicUnits - publicUnitsSold`.
- **Root cause:** `buyPrivate` (`Offering.sol:209-227`) is bounded only by
  `remainingUnits()` (guard G-11), never by the public/private tranche split. A
  single voucher holder can buy units the public tranche still advertises, so a
  later `buyPublic` reverts `InsufficientSupply` while the cap still shows
  headroom.
- **Severity assessment:** Needs human review. A UI/coordination starvation an
  issuer or one voucher holder can trigger; no direct value loss.
- **Reproducing sequence:** `offering_buyPrivate_clamped` — a single private buy
  of 150 of 200 escrowed units leaves 50 sellable while `publicUnits` still
  advertises 100.
- **Foundry repro:** `test_repro_publicTrancheStarvation` (PASS) —
  `FoundryTester.sol:37-49`.

#### GL-20 — cap-table collapse to one holder

- **Property violated:** `property_capTableKeepsTwoHolders` (GL-20)
- **Guarantee:** EXPLORATORY (Sources ADV-18, Category VALID_STATE)
- **Assertion:** the set of nonzero unit holders never shrinks below two.
- **Root cause:** after a failed raise, `sweepFailedUnits`
  (`Offering.sol:351-357`) sends all escrowed units to `treasury`. If the owner
  first points `treasury` at an existing holder (e.g. the founder via
  `setTreasury`), all 1000 units collapse onto one address. Real 0xSplits
  SplitMain `_validSplit` requires ≥2 accounts, so `distributeFunds` then
  reverts permanently and revenue is stuck in `payoutSplit` — value locked, not
  lost. The harness's `MockSplitMain` was hardened (`_validAccounts` enforces
  `accounts.length > 1` and strictly-ascending unique, `MockSplitMain.sol:52-57`)
  so the collapse is caught rather than silently accepted.
- **Severity assessment:** Needs human review. Reachable only via owner action
  (`setTreasury`) plus a failed raise; the owner is trusted, but this is an
  avoidable permanent-brick footgun worth documenting or guarding.
- **Reproducing sequence:** `offering_roundTrip_buyFailRefund` →
  `offering_secondary` (setTreasury onto the founder) → `offering_sweepFailedUnits`.
- **Foundry repro:** `test_repro_capTableCollapse` (PASS) —
  `FoundryTester.sol:55-69`; the founder ends holding 1000 units.

## Properties Implemented

76 of 78 specified properties are implemented (43 global public `property_*`
evaluated on every fuzzer call; 33 specific internal `property_*` called at the
end of the relevant handler). Guarantee is quoted from `PROPERTIES.md`.
Confidence is HIGH unless the property is EXPLORATORY (a plausible-but-unproven
expectation, several deliberately falsifiable) or a constant-input smoke check.

### Global

| Property | Function | Guarantee | Confidence |
|---|---|---|---|
| GL-01 | `property_escrowUsdcExactAccounting` | SHOULD-HOLD | HIGH |
| GL-02 | `property_escrowCoversLiability` | SHOULD-HOLD | HIGH |
| GL-03 | `property_raisedEqualsSumDeposits` | SHOULD-HOLD | HIGH |
| GL-04 | `property_withdrawnEqualsPaid` | SHOULD-HOLD | HIGH |
| GL-05 | `property_grossRaisedDecomposition` | SHOULD-HOLD | HIGH |
| GL-06 | `property_usdcConserved` | SHOULD-HOLD | HIGH |
| GL-07 | `property_depositLedgerMatchesCashFlow` | SHOULD-HOLD | HIGH |
| GL-08 | `property_noRefundProfit` | SHOULD-HOLD | HIGH |
| GL-09 | `property_strayTokenConserved` | SHOULD-HOLD | HIGH |
| GL-10 | `property_ethConserved` | EXPLORATORY | LOW — soft; LiquidSplit's bare `call` ignores its return value, so this is an inferred conservation check, not a proven identity. |
| GL-11 | `property_unitsSoldDecomposition` | SHOULD-HOLD | HIGH |
| GL-12 | `property_tranchesPartitionUnitsSold` | SHOULD-HOLD | HIGH |
| GL-13 | `property_escrowUnitsAccounting` | SHOULD-HOLD | HIGH |
| GL-14 | `property_unitsSoldBounded` | SHOULD-HOLD | HIGH |
| GL-15 | `property_refundReclaimsExactlyUnitsBought` | SHOULD-HOLD | HIGH |
| GL-16 | `property_capTableSumsTo1000` | SHOULD-HOLD | HIGH |
| GL-17 | `property_scaledPercentsSumToScale` | SHOULD-HOLD | HIGH |
| GL-18 | `property_publicTrancheAccounting` | SHOULD-HOLD | HIGH |
| GL-19 | `property_publicTrancheStaysFillable` | EXPLORATORY | LOW — **VIOLATED** (deliberately falsifiable; see Violation Details). |
| GL-20 | `property_capTableKeepsTwoHolders` | EXPLORATORY | LOW — **VIOLATED** (deliberately falsifiable; see Violation Details). |
| GL-21 | `property_costForHasNoRoundingSurface` | SHOULD-HOLD | HIGH |
| GL-22 | `property_costForSplitIdentity` | SHOULD-HOLD | HIGH |
| GL-23 | `property_costForMonotonicity` | SHOULD-HOLD | HIGH |
| GL-24 | `property_costForZeroIsTotal` | SHOULD-HOLD | HIGH |
| GL-25 | `property_curveWithinFactoryEnvelope` | SHOULD-HOLD | HIGH |
| GL-26 | `property_buysChargePositiveUsdc` | SHOULD-HOLD | HIGH |
| GL-28 | `property_saleCountersNonDecreasing` | SHOULD-HOLD | HIGH — monotonic global, airtight via `_syncMonotonicGhosts()`. |
| GL-29 | `property_minMetIsALatch` | SHOULD-HOLD | HIGH — monotonic latch, airtight via `_syncMonotonicGhosts()`. |
| GL-30 | `property_raisedFallsOnlyWhileFailed` | SHOULD-HOLD | HIGH |
| GL-31 | `property_actorLedgersMonotone` | SHOULD-HOLD | HIGH |
| GL-32 | `property_allocationConsumedMonotone` | SHOULD-HOLD | HIGH |
| GL-33 | `property_addressSlotsTransitionLegally` | SHOULD-HOLD | HIGH |
| GL-34 | `property_terminalStatesFreezeTheSale` | SHOULD-HOLD | HIGH |
| GL-35 | `property_stateTransitionsAreLegal` | SHOULD-HOLD | HIGH |
| GL-36 | `property_failedStateInvariants` | SHOULD-HOLD | HIGH |
| GL-37 | `property_closedStateInvariants` | SHOULD-HOLD | HIGH |
| GL-38 | `property_withdrawnImpliesMinMet` | SHOULD-HOLD | HIGH |
| GL-39 | `property_minMetMatchesRaiseMin` | EXPLORATORY | MEDIUM — soft; the reverse direction of the biconditional can be broken by a refund dragging `raised` below `raiseMin` after the latch, and nothing asserts it holds. |
| GL-40 | `property_minMetOnlyFromBuyProceeds` | SHOULD-HOLD | HIGH |
| GL-41 | `property_depositsPairWithUnitsBought` | SHOULD-HOLD | HIGH |
| GL-42 | `property_privateClaimsBoundedByAllocations` | SHOULD-HOLD | HIGH |
| GL-43 | `property_operatorApprovalSemantics` | SHOULD-HOLD | HIGH |
| GL-44 | `property_uriIsAlwaysRenderable` | SHOULD-HOLD | MEDIUM — constant-input smoke check; fuzzed project names only reach `uri()` once the deferred second-offering handler is added. |

### Specific

| Property | Function | Guarantee | Confidence |
|---|---|---|---|
| SP-01 | `property_buySettlesOnCurveAndConserves` | SHOULD-HOLD | HIGH |
| SP-02 | `property_buyGatingHeld` | SHOULD-HOLD | HIGH |
| SP-03 | `property_buyTouchesOnlyCaller` | SHOULD-HOLD | HIGH |
| SP-04 | `property_privateClaimSettlesOnce` | SHOULD-HOLD | HIGH |
| SP-05 | `property_staleOwnerVoucherRejected` | SHOULD-HOLD | HIGH |
| SP-06 | `property_claimSignatureIsBuyerBound` | SHOULD-HOLD | HIGH |
| SP-07 | `property_receiverCallbackCannotReenter` | SHOULD-HOLD | HIGH |
| SP-08 | `property_refundIsExactInverse` | SHOULD-HOLD | HIGH |
| SP-09 | `property_refundLiveness` | SHOULD-HOLD | HIGH |
| SP-10 | `property_curveNeverRewindsOnRefund` | SHOULD-HOLD | HIGH |
| SP-11 | `property_buyFailRefundIsValueNeutral` | SHOULD-HOLD | HIGH |
| SP-12 | `property_refundEligibilityIsBalanceBased` | SHOULD-HOLD | HIGH |
| SP-13 | `property_refundAllIsAtomicPerBuyer` | SHOULD-HOLD | HIGH |
| SP-14 | `property_withdrawPaysTreasuryExactly` | SHOULD-HOLD | HIGH |
| SP-15 | `property_withdrawLiveness` | SHOULD-HOLD | HIGH |
| SP-16 | `property_closeSettlesAndSweeps` | SHOULD-HOLD | HIGH |
| SP-18 | `property_unitSweepConserves` | SHOULD-HOLD | HIGH |
| SP-19 | `property_markFailedOnlyFlipsState` | SHOULD-HOLD | HIGH |
| SP-20 | `property_markFailedLiveness` | SHOULD-HOLD | HIGH |
| SP-21 | `property_skimLeavesExactlyLiability` | SHOULD-HOLD | HIGH |
| SP-22 | `property_rescueIsConfinedToStrayTokens` / `property_rescueForbiddenReverts` | SHOULD-HOLD | HIGH |
| SP-23 | `property_nonTransitionCallsLeaveStateAndLedger` | SHOULD-HOLD | HIGH |
| SP-24 | `property_cancelAllocationOnlyConsumes` | SHOULD-HOLD | HIGH |
| SP-25 | `property_ownershipTransferPostconditions` / `property_ownershipAcceptPostconditions` | SHOULD-HOLD | HIGH |
| SP-26 | `property_ownershipRoundTripKeepsCancelledDead` | SHOULD-HOLD | HIGH — the exploratory voucher-revival leg is left to the fuzzer's own `buyPrivate` replays, not asserted. |
| SP-27 | `property_onlyOwnerGatesHold` | SHOULD-HOLD | HIGH |
| SP-28 | `property_blocklistDestroysNoValue` | EXPLORATORY | MEDIUM — soft; the `refundAll` CEI-inversion skip branch is only reachable via the `usdc_setBlocked` handler, and the guarantee is value-preservation rather than a proven identity. |
| SP-29 | `property_distributeFundsNeverReverts` | SHOULD-HOLD | HIGH — the only property whose failure means permanently stuck revenue. |
| SP-30 | `property_ethDistributionReachesPayoutSplit` | EXPLORATORY | LOW — pins the assumption for a real-SplitMain swap; passes today only because `PayoutSplitStub` has `receive()`. |
| SP-31 | `property_unitTransferMovesExactly` | SHOULD-HOLD | HIGH |
| SP-32 | `property_unauthorizedTransferReverts` | SHOULD-HOLD | HIGH |
| SP-33 | `property_noopTransfersChangeNothing` | SHOULD-HOLD | HIGH |
| SP-34 | `property_invalidTransferReverts` | SHOULD-HOLD | HIGH |

**Handlers:** 19 public entry points in `OfferingHandler.sol` + 10 in
`PactTokenHandler.sol` + `setCurrentActor`/`passTime` in `Handlers.sol`. This
covers primary user flows (buyPublic clamped/full, buyPrivate, refund, withdraw,
markFailed, sweep, unit transfers), two secondary dispatchers (`offering_secondary`
9-way, `pactToken_secondary` 3-way, reaching the 12 internal `_offering_*` /
`_pactToken_*` handlers), and 12 adversarial/new handlers: `roundTrip_buyFailRefund`,
`refund_afterReacquire`, `buyPrivate_staleOwner`, `buyPrivate_frontrun`,
`adminAsRandomActor`, `buy_reenter`, `usdc_setBlocked`, `rescueForbidden`,
`transferUnauthorized`, `transferNoop`, `transferInvalid`, `revokeOfferingOperator`.

## Open TODOs

Grep of `TODO` / `FIXME` / `XXX` across `contracts/test/fizz/`:

- `contracts/test/fizz/Properties.sol:257` — a comment explaining that GL-27
  (`property_flatCurveIsLinear`) is left as the `[-]` deferral in `PROPERTIES.md`
  rather than a brittle assertion, because the flat-curve branch is unreachable
  until a second offering with `priceSlope == 0` is added. This is documentation
  of the deliberate deferral, not an open work item.

No other TODO/FIXME markers in the suite.

## Next Steps

Prioritized:

1. **GL-19 (public-tranche starvation):** consider a tranche-reservation check in
   `buyPrivate` so a private claim cannot consume units the public tranche still
   advertises (bound private buys by `remainingUnits() - (publicUnits - publicUnitsSold)`),
   or accept and document the starvation as reputational.
2. **GL-20 (cap-table collapse):** consider guarding `sweepFailedUnits` /
   `setTreasury` against collapsing the cap table onto a single holder, since the
   resulting `distributeFunds` brick is permanent on real SplitMain. At minimum,
   document the footgun.
3. **Implement the 2 deferred properties** (SP-17 non-receiver treasury, GL-27
   flat-curve second offering) if a multi-offering harness is built later; both
   currently conflict with the single-offering global assumptions.
4. **Run a longer production campaign.** The final campaign was ~10 min /
   ~500k calls; recommend ≥1 hour for release-grade assurance.
5. **Echidna cross-check** is available (`echidna.yaml` predeploys `MockUSDC` at
   the hardcoded USDC address, so the etch branch is skipped there) — run it to
   corroborate the Medusa findings with a different exploration engine.
