# PACT Fuzz Property Plan (consolidated)

Synthesized from the five discovery agents (`fizz_data/discovery/*.md`) after
deduplication and a feasibility pass against the live harness
(`contracts/test/fizz/`). **78 properties: 44 global + 34 specific.**

Spec IDs (`GL-NN` / `SP-NN`) match `/Users/rooh/work/pact/PROPERTIES.md` and are
stable — never renumber. Global properties become `public property_*` functions
in `Properties.sol`; specific properties become `internal property_*` functions
called at the end of the handler named in *Called After*.

Merge rules applied: an exact identity and its ghost-free inequality fallback are
BOTH kept (GL-01/GL-02, GL-13/GL-14, GL-07/GL-08) — the fallback survives ghost
mis-wiring. "Covered by another property" was never a drop reason; only identical
assertion logic was merged.

---

## Global Properties (public `property_*`, evaluated on every fuzzer call)

| Spec ID | Function Name | Property | Category | Guarantee | Evidence | Priority |
|---|---|---|---|---|---|---|
| GL-01 | `property_escrowUsdcExactAccounting` | `usdc.balanceOf(offering) == raised - withdrawn + usdcDonated - usdcSkimmed` — every USDC in escrow attributable to a named cause | HIGH_LEVEL | SHOULD-HOLD | Exact identity over the flow set: inflows `Offering.sol:250` + donations; outflows `:366`, `:379`, `:317`, `:336`, `:407`; `rescue` excludes USDC (G-20); USDC hardcoded non-fee (`:56`) | HIGH |
| GL-02 | `property_escrowCoversLiability` | `withdrawn <= raised` and `usdc.balanceOf(offering) >= raised - withdrawn` (subtraction never underflows) | HIGH_LEVEL | SHOULD-HOLD | invariants.md E-1 + I-5; mirrored by `test/Invariant.t.sol:126` | HIGH |
| GL-03 | `property_raisedEqualsSumDeposits` | `raised == Σ deposits[·]` over the 3 actors plus both owner seats | HIGH_LEVEL | SHOULD-HOLD | invariants.md I-1; Δ-pairs `Offering.sol:244↔246`, `:313↔315`, `:340-342`; NatSpec `:69-70` | HIGH |
| GL-04 | `property_withdrawnEqualsPaid` | `withdrawn == ghosts.withdrawPaid` (cumulative USDC actually pushed to treasury) | HIGH_LEVEL | SHOULD-HOLD | Both writers of `withdrawn` (`:365`, `:378`) increment by exactly what they transfer (`:366`, `:379`); no other writer | MEDIUM |
| GL-05 | `property_grossRaisedDecomposition` | `ghosts.grossRaised == raised + ghosts.usdcRefundedTotal` | HIGH_LEVEL | SHOULD-HOLD | `raised` has one incrementer (`:246`) and two decrementers (`:315`, `:342`), both refund paths | MEDIUM |
| GL-06 | `property_usdcConserved` | Σ USDC over actors, both owner seats, offering, token and payoutSplit `== ghosts.usdcMinted` | HIGH_LEVEL | SHOULD-HOLD | MockUSDC creates balance only in `mint`; transfer/transferFrom self-conserving; harness mints in `setup()` and `offering_donateUsdc_clamped` only | MEDIUM |
| GL-07 | `property_depositLedgerMatchesCashFlow` | Per address: `usdcPaid[a] - usdcRefunded[a] == deposits(a)` | HIGH_LEVEL | SHOULD-HOLD | `Offering.sol:244`/`:250` buy pair; `:309/:313/:317`; `:329/:336/:340`; I-1 | HIGH |
| GL-08 | `property_noRefundProfit` | `usdcRefunded[a] <= usdcPaid[a]` per address and in aggregate | HIGH_LEVEL | SHOULD-HOLD | Follows from I-1 + `deposits >= 0`; E-1; direct detector for the refundAll CEI inversion (`:336` before `:340-342`) | HIGH |
| GL-09 | `property_strayTokenConserved` | escrow + actors stray-token balance `== 1_000e18` always | HIGH_LEVEL | SHOULD-HOLD | `strayToken` minted once to escrow; only mover is `rescue` (full balance); G-20 forbids USDC/pactToken | MEDIUM |
| GL-10 | `property_ethConserved` | Σ actor ETH + token ETH + payoutSplit ETH `== actors.length * INITIAL_ETH_BALANCE` | HIGH_LEVEL | EXPLORATORY | — inferred; LiquidSplit's bare `call` at `vendor/LiquidSplit.sol:81` ignores its return value | LOW |
| GL-11 | `property_unitsSoldDecomposition` | `unitsSold == Σ unitsBought[·] + ghosts.unitsReclaimedTotal` globally, and `unitsSold == Σ unitsBought[·]` exactly while Funding | HIGH_LEVEL | SHOULD-HOLD | invariants.md I-2/I-3; refunds zero `unitsBought` (`:314`, `:341`) without decrementing `unitsSold`, which has no decrementing write site | HIGH |
| GL-12 | `property_tranchesPartitionUnitsSold` | `unitsSold == publicUnitsSold + ghosts.privateUnitsSold` | HIGH_LEVEL | SHOULD-HOLD | `_buy` increments `unitsSold` on both paths (`:247`); `publicUnitsSold` only from `buyPublic` (`:197`) | HIGH |
| GL-13 | `property_escrowUnitsAccounting` | `remainingUnits() == OFFERING_UNITS + unitsDonated + unitsReclaimedTotal - unitsSold - unitsSwept` | HIGH_LEVEL | SHOULD-HOLD | invariants.md X-2 (unenforced equality) made exact by adding the donation and sweep terms; `:172-175`, `:238-239`, `:353`, `:383`, `:438-449` | HIGH |
| GL-14 | `property_unitsSoldBounded` | `Σ unitsBought[·] <= unitsSold <= OFFERING_UNITS + unitsDonated` | HIGH_LEVEL | SHOULD-HOLD | G-11 (`:239`) bounds every sale by the live escrow balance; per-buyer leg from I-2/I-3 | MEDIUM |
| GL-15 | `property_refundReclaimsExactlyUnitsBought` | Per actor `unitsBought(a) + unitsReclaimed[a] == unitsBoughtCum[a]`, and reclaimed never exceeds bought | HIGH_LEVEL | SHOULD-HOLD | `:245`, `:311-316`, `:331-343`; G-17. Unit leg uses a different mechanism (operator ERC-1155 pull) than the USDC leg | HIGH |
| GL-16 | `property_capTableSumsTo1000` | Cap table sums to exactly `TOTAL_SUPPLY` over the deduped holder set; token, payoutSplit and `address(0)` hold zero units | HIGH_LEVEL | SHOULD-HOLD | invariants.md I-11; PactToken NatSpec `:14-15`; G-27 (`PactToken.sol:44`); `_mint` is constructor-only; `vendor/ERC1155.sol:68-74` | HIGH |
| GL-17 | `property_scaledPercentsSumToScale` | Per holder `scaledPercentBalanceOf(a) == balanceOf(a,0) * SUPPLY_TO_PERCENTAGE` compared in uint256, and the sum equals `PERCENTAGE_SCALE` (1e6) | HIGH_LEVEL | SHOULD-HOLD | invariants.md I-12; `PactToken.sol:55-59` unchecked uint32 cast bounded by I-11; MockSplitMain `_validate` requires `sum == 1e6` | HIGH |
| GL-18 | `property_publicTrancheAccounting` | `publicUnitsSold <= publicUnits` (across owner `setPublicUnits`) AND `publicUnitsSold <= unitsSold` | VALID_STATE | SHOULD-HOLD | invariants.md I-4; G-3 (`:196-197`), G-13 (`:265`); the two counters live in different functions | HIGH |
| GL-19 | `property_publicTrancheStaysFillable` | While Funding, `remainingUnits() >= publicUnits - publicUnitsSold` | VALID_STATE | EXPLORATORY | Deliberately falsifiable: `buyPrivate` bypasses `publicUnitsSold` and is bounded only by `remainingUnits()` (`:209-227`); `setPublicUnits` unbounded upward. The counterexample sequence is the deliverable | MEDIUM |
| GL-20 | `property_capTableKeepsTwoHolders` | The set of nonzero unit holders never shrinks below two | VALID_STATE | EXPLORATORY | `vendor/LiquidSplit.sol:65-101`; real SplitMain v1 `_validSplit` rejects `accounts.length < 2` while MockSplitMain is more permissive | MEDIUM |
| GL-21 | `property_costForHasNoRoundingSurface` | `Σ_i costFor(s+i,1) == costFor(s,units)` to the wei, and `2*costFor(s,u) == 2*u*P + S*(2*s*u + u*(u-1))` | VALID_STATE | SHOULD-HOLD | Closed form matches `:185` verbatim; `u*(u-1)` is a product of consecutive integers so the `/2` never truncates. Pinned by `testFuzzBuyPathIsSplitInvariant` | HIGH |
| GL-22 | `property_costForSplitIdentity` | `costFor(s,a) + costFor(s+a,b) == costFor(s,a+b)` at fuzzed positions and at the live `unitsSold`, including zero chunks | VALID_STATE | SHOULD-HOLD | Algebraic identity verified in integers; generalises `testFuzzBuyPathIsSplitInvariant` (which covers only `s == 0`) to the production public/private handoff seam | HIGH |
| GL-23 | `property_costForMonotonicity` | Cost strictly increasing in units; `costFor(s,1) == priceStart + priceSlope*s`; average unit price never below `priceStart`; `costFor(s+1,u) - costFor(s,u) == priceSlope*u` | VALID_STATE | SHOULD-HOLD | `:185`, `:148`; the only sold-dependent term is `priceSlope*sold*units` | MEDIUM |
| GL-24 | `property_costForZeroIsTotal` | `costFor(s,0) == 0` and `quote(0) == 0` without reverting | VALID_STATE | SHOULD-HOLD | `:184` early return prevents the `units-1` underflow; `costFor` must stay total because `OfferingFactory.sol:71` calls it. `_buy` deliberately disagrees at zero (`:235`) | MEDIUM |
| GL-25 | `property_curveWithinFactoryEnvelope` | While `unitsSold <= OFFERING_UNITS` the curve stays inside the factory-validated cost envelope; record when donated units push `unitsSold` past it into the unvalidated region | VALID_STATE | SHOULD-HOLD | `OfferingFactory.sol:71` evaluates `costFor(0, offeringUnits)` without reverting, proving full-sellout cost fits uint256; by GL-22 no in-range buy overflows. Donated-unit escape (X-2) is the exploratory leg | HIGH |
| GL-26 | `property_buysChargePositiveUsdc` | Every buy charges strictly positive USDC; `ghosts.grossRaised >= unitsSold * priceStart` | VALID_STATE | SHOULD-HOLD | `:241`, `:246-247`, `:148`. Must use the gross ghost — refunds decrement `raised` while `unitsSold` never rewinds | MEDIUM |
| GL-27 | `property_flatCurveIsLinear` | With `priceSlope == 0`, `costFor(s,u) == u*priceStart` at every position | VALID_STATE | SHOULD-HOLD | `:185` with slope 0; `:148` permits slope 0. Requires a second (flat-curve) offering — the primary fixture hardcodes slope 1000 | LOW |
| GL-28 | `property_saleCountersNonDecreasing` | `unitsSold`, `withdrawn` and `publicUnitsSold` never decrease between observations | VARIABLE_TRANSITION | SHOULD-HOLD | I-3/I-5/I-4: single `+=` write sites `:247`, `:365`/`:378`, `:197`; no decrementing writer for any of the three | HIGH |
| GL-29 | `property_minMetIsALatch` | `minMet` is a one-shot latch — once true never false, even after refunds drag `raised` below `raiseMin` | VARIABLE_TRANSITION | SHOULD-HOLD | invariants.md I-6 — the single write at `:248` only ever writes true | HIGH |
| GL-30 | `property_raisedFallsOnlyWhileFailed` | `raised` is non-decreasing in Funding and Closed; it may only fall while Failed | VARIABLE_TRANSITION | SHOULD-HOLD | Both decrementers (`:315`, `:342`) sit behind G-16 | MEDIUM |
| GL-31 | `property_actorLedgersMonotone` | While Funding every address's `deposits`/`unitsBought` are non-decreasing; they may only fall — to exactly zero — while Failed | VARIABLE_TRANSITION | SHOULD-HOLD | Incrementers `:244-245`; decrementers zero both (`:313-314`, `:340-341`) behind G-16 | MEDIUM |
| GL-32 | `property_allocationConsumedMonotone` | `allocationConsumed[id]` only ever moves false→true for all 8 harness ids; the consumed count never decreases | VARIABLE_TRANSITION | SHOULD-HOLD | invariants.md I-9; write sites `:224` (G-4) and `:257` | HIGH |
| GL-33 | `property_addressSlotsTransitionLegally` | `pactToken` is a one-shot latch (once non-zero never changes); `owner` only ever becomes the prior `pendingOwner`, leaves `pendingOwner == 0`, and is never `address(0)` | VARIABLE_TRANSITION | SHOULD-HOLD | invariants.md I-8; `:163-169` (G-1/G-2); `:427-433` (G-22); `:421` rejects zero | MEDIUM |
| GL-34 | `property_terminalStatesFreezeTheSale` | Once `state != Funding`, `unitsSold` and `publicUnitsSold` never change again and `raised` never increases (refunds may still decrease it) | VARIABLE_TRANSITION | SHOULD-HOLD | G-8 (`:233`); I-7. The asymmetric treatment of `raised` is the crowdfund shape | MEDIUM |
| GL-35 | `property_stateTransitionsAreLegal` | Between observations `state` either stays put or moves Funding→Failed / Funding→Closed; both terminal states are absorbing and mutually exclusive | STATE_TRANSITION | SHOULD-HOLD | invariants.md I-7; the only writers are `:299` (G-14/G-15) and `:375` (G-18/G-19), both requiring `state == Funding` | HIGH |
| GL-36 | `property_failedStateInvariants` | `state == Failed` implies `minMet == false`, `block.timestamp > closeDate`, `withdrawn == 0`, and `usdc.balanceOf(offering) >= Σ deposits[·]` | VALID_STATE | SHOULD-HOLD | G-14/G-15 (`:297-298`) at the transition, held by I-6 + I-7; I-5 mutual exclusion; E-2 | HIGH |
| GL-37 | `property_closedStateInvariants` | `state == Closed` implies `minMet == true`, `withdrawn == raised`, and the escrow holds zero units with `remainingUnits() == 0` — permanently | VALID_STATE | SHOULD-HOLD | G-18 (`:372`) gates the only Closed edge; `:376-381` drains USDC and `:383-386` sweeps units at the transition; G-23 (`:445`, `:461`) rejects inbound units post-Funding | HIGH |
| GL-38 | `property_withdrawnImpliesMinMet` | `withdrawn > 0` implies `minMet == true` | VALID_STATE | SHOULD-HOLD | Both writers of `withdrawn` sit behind G-18 | HIGH |
| GL-39 | `property_minMetMatchesRaiseMin` | `minMet == (raised >= raiseMin)` — the biconditional | VALID_STATE | EXPLORATORY | Forward direction from `:248`; the reverse rests on `raised` never falling below `raiseMin` after the latch and nothing asserts it. `RAISE_MIN = 100e6` so a failure means a refund reached a minMet offering | MEDIUM |
| GL-40 | `property_minMetOnlyFromBuyProceeds` | `!minMet || ghosts.grossRaised >= RAISE_MIN` — donations and split revenue can never trip the latch | VALID_STATE | SHOULD-HOLD | `:246-248` latches off `raised` (buy proceeds), never `balanceOf`; I-6; G-18 | HIGH |
| GL-41 | `property_depositsPairWithUnitsBought` | Per address `deposits > 0` iff `unitsBought > 0`, and `unitsBought > 0` implies `deposits >= unitsBought` | VALID_STATE | SHOULD-HOLD | Written as a pair at `:244-245` with `unitsWanted >= 1` and `cost >= priceStart > 0`; zeroed as a pair at `:313-314` / `:340-341`. G-17 compares balance against `unitsBought` | HIGH |
| GL-42 | `property_privateClaimsBoundedByAllocations` | Successful private buys never exceed the number of consumed allocation ids, and never exceed 8 | VALID_STATE | SHOULD-HOLD | invariants.md I-9; G-4 (`:216`); the harness uses exactly 8 reusable ids (`_allocationId`) | MEDIUM |
| GL-43 | `property_operatorApprovalSemantics` | The Offering is an operator for EVERY account unconditionally and permanently (revocation cannot remove it); for every other operator `isApprovedForAll` mirrors the owner's last `setApprovalForAll`, defaulting false | VALID_STATE | SHOULD-HOLD | PactToken NatSpec `:47-51`; relied on by `Offering.sol:316`, `:343` (X-1); `vendor/ERC1155.sol:37-39,51-55` — the override at `:50` ORs over `_operatorApprovals` and widens for exactly one address | HIGH |
| GL-44 | `property_uriIsAlwaysRenderable` | `uri(0)` never reverts and returns a non-empty `data:application/json;base64,` payload | VALID_STATE | SHOULD-HOLD | PactToken NatSpec `:61-63`. Constant-input smoke check unless the fuzzed-name second offering is added | LOW |

---

## Specific Properties (internal `property_*`, called from handlers)

| Spec ID | Function Name | Property | Category | Guarantee | Evidence | Priority | Called After |
|---|---|---|---|---|---|---|---|
| SP-01 | `property_buySettlesOnCurveAndConserves` | The buy charges exactly `costFor(unitsSold_before, unitsWanted)` (== the `quote` passed as `maxCost`) and `<= maxCost`; all eight legs move together — `deposits[buyer]`, `raised`, escrow USDC `+cost`; buyer USDC `−cost`; `unitsBought[buyer]`, `unitsSold`, buyer units `+units`; escrow units `−units` | HIGH_LEVEL | SHOULD-HOLD | `_buy` writes all six ledger slots from the same two locals (`:244-247`) and transfers exactly `cost` in / `unitsWanted` out (`:250-251`); `:178-180`, `:241`, `:242` (G-12); NatSpec `:54-56` no-fee; pinned by `Offering.t.sol:50-60` | HIGH | `offering_buyPublic`, `offering_buyPrivate` |
| SP-02 | `property_buyGatingHeld` | Any successful buy had `state == Funding` before the call, and `block.timestamp <= closeDate` OR `minMet` was already true BEFORE the call | STATE_TRANSITION | SHOULD-HOLD | G-8 (`:233`), G-10 (`:236`), receiver hooks `:447`/`:462`; I-10. The before-snapshot of `minMet` is essential — reading it after lets a buy that itself crossed the minimum past the deadline pass trivially | HIGH | `offering_buyPublic`, `offering_buyPrivate` |
| SP-03 | `property_buyTouchesOnlyCaller` | A buy increases only the caller's ledgers; other addresses' `deposits`/`unitsBought`, plus `withdrawn` and `state`, are unchanged | STATE_TRANSITION | SHOULD-HOLD | `:244-245` are keyed on `msg.sender` only | MEDIUM | `offering_buyPublic`, `offering_buyPrivate` |
| SP-04 | `property_privateClaimSettlesOnce` | `buyPrivate` finds `allocationConsumed == false` and leaves it true; each id settles at most one purchase ever and never after `cancelAllocation`; the buyer's USDC delta across the whole call is `<= amountCapUsdc`; `publicUnits`/`publicUnitsSold` untouched | STATE_TRANSITION | SHOULD-HOLD | G-4 (`:216`), G-7 (`:226`), I-9; NatSpec `:223`. The cap check sits AFTER `_buy` writes state (`:225-226`), so measure the balance delta over the whole call to confirm the revert unwinds the sale | MEDIUM | `offering_buyPrivate` |
| SP-05 | `property_staleOwnerVoucherRejected` | A voucher signed by a former owner cannot be claimed after ownership rotates — rotation mass-revokes every outstanding link | STATE_TRANSITION | SHOULD-HOLD | G-5 (`:217`); NatSpec `:204-208`, `:417-419`. The existing handler always re-signs with the live owner, so the revocation claim is asserted nowhere today | MEDIUM | `offering_buyPrivate_staleOwner` (NEW) |
| SP-06 | `property_claimSignatureIsBuyerBound` | A claim signature bound to buyer A must be unusable by buyer B | STATE_TRANSITION | SHOULD-HOLD | G-6 (`:220`); NatSpec `:31-33`. The whole two-key design exists for this and the harness always signs the acting actor | MEDIUM | `offering_buyPrivate_frontrun` (NEW) |
| SP-07 | `property_receiverCallbackCannotReenter` | A contract buyer cannot re-enter the Offering from the ERC-1155 delivery callback — no nested buy, refund, or any state-changing call succeeds | STATE_TRANSITION | SHOULD-HOLD | ReentrancyGuard (`:46`); `:251` unit delivery is the last external call in `_buy`; `test/Mocks.sol` ships an unused `ReenterOnReceive` | MEDIUM | `offering_buy_reenter` (NEW) |
| SP-08 | `property_refundIsExactInverse` | A successful `refund()` pays exactly the recorded deposit and reclaims exactly the recorded units — both ledgers land on zero, never partial; `raised` falls by the deposit; escrow units rise by the units; `unitsSold`, `publicUnitsSold`, `withdrawn`, `minMet`, `state` and other actors' ledgers are untouched. Requires Failed | HIGH_LEVEL | SHOULD-HOLD | `:303-319`; G-16 (`:308`); writes `:313-315`; the unitsSold non-rewind is I-3; X-1 (`PactToken.sol:49-51`). Early-return on an unchanged deposit keeps the G-17 forfeit path honest | HIGH | `offering_refund` |
| SP-09 | `property_refundLiveness` | In Failed, a buyer still holding their full purchased units can ALWAYS pull their entire deposit — the call cannot be made to revert, and pays exactly `deposits` for exactly `unitsBought` | HIGH_LEVEL | SHOULD-HOLD | invariants.md E-2; NatSpec `Offering.sol:36-38`; G-16/G-17 (`:308-317`); X-1. Detects escrow drained below liability, operator status lost, sweep interfering with reclaim, any third party bricking the reclaim | HIGH | `offering_refund` (try/catch form) |
| SP-10 | `property_curveNeverRewindsOnRefund` | A refunded buyer cannot re-enter at their old price: re-buying the returned units costs `>=` the original, strictly more when `priceSlope > 0` and the position advanced | VARIABLE_TRANSITION | SHOULD-HOLD | I-3; monotonicity in position from `:185`. C2 dust extraction is structurally unreachable here (G-8), so this pins the residual economic statement I-3 rests on | MEDIUM | `offering_refund`, `_offering_refundAll` |
| SP-11 | `property_buyFailRefundIsValueNeutral` | A full buy→markFailed→refund cycle is value-neutral: the actor ends with `usdcStart + depositsAtStart` USDC and exactly `unitsStart` units | HIGH_LEVEL | SHOULD-HOLD | G-14/G-15/G-16, `:307-319`; E-2. The ONLY round trip the state machine admits — the `depStart` term matters because earlier buys refund in the same call | MEDIUM | `offering_roundTrip_buyFailRefund` (NEW) |
| SP-12 | `property_refundEligibilityIsBalanceBased` | A buyer who transfers units away and then reacquires the same NUMBER from anyone can still refund in full — eligibility is a balance test, not provenance | STATE_TRANSITION | SHOULD-HOLD | `:312` is a pure balance comparison and units are fungible; NatSpec `:305-306`. G-17 forfeiture is therefore recoverable | LOW | `offering_refund_afterReacquire` (NEW) |
| SP-13 | `property_refundAllIsAtomicPerBuyer` | For every listed buyer, `refundAll` either fully clears both ledgers AND pays exactly that deposit in USDC while reclaiming exactly `unitsBought`, or leaves both ledgers completely untouched — never a partial clear, never a cleared ledger without payment. `unitsSold`, `withdrawn`, `minMet`, `state` unchanged | HIGH_LEVEL | SHOULD-HOLD | `:325-346`; the ledger clear at `:340-343` sits behind continue paths; `_tryTransfer` at `:336` executes BEFORE the ledger writes — the documented CEI inversion (audit M-3). The skip branches are where an atomicity bug hides | HIGH | `_offering_refundAll` |
| SP-14 | `property_withdrawPaysTreasuryExactly` | `withdraw` requires `minMet`, leaves `withdrawn == raised`, moves exactly `Δwithdrawn` USDC from escrow to the treasury (no more, nowhere else) and moves `raised` not at all | STATE_TRANSITION | SHOULD-HOLD | G-18 (`:362`); `:363-366`; NatSpec `:360`. Permissionless caller with a fixed beneficiary — verified rather than assumed | HIGH | `offering_withdraw` |
| SP-15 | `property_withdrawLiveness` | Donating USDC or units into the escrow can never make a permissionless `withdraw` revert while `raised > withdrawn` and `minMet` (treasury not blocklisted) | HIGH_LEVEL | SHOULD-HOLD | `:359-368`; E-1. Griefing target: surplus donations or an interleaved skim making the payout arithmetic underflow | HIGH | `offering_withdraw` (try/catch form) |
| SP-16 | `property_closeSettlesAndSweeps` | `closeAndWithdraw` requires `minMet` and Funding; afterwards `state == Closed`, `withdrawn == raised`, `raised` unchanged, escrow holds zero units | STATE_TRANSITION | SHOULD-HOLD | `:371-388`; G-18/G-19 | HIGH | `_offering_closeAndWithdraw` |
| SP-17 | `property_closeCannotBeBrickedByDonors` | A unit donor cannot brick the owner's close — `closeAndWithdraw` must succeed whenever `minMet` and Funding, however many units strangers pushed in | HIGH_LEVEL | EXPLORATORY | `:371-388` transfers `remainingUnits()` to the treasury unconditionally; X-2. Unfalsifiable until the harness can point `setTreasury` at a non-ERC1155-receiver contract | HIGH | `_offering_closeAndWithdraw` + `offering_setTreasuryNonReceiver` (NEW, heavy) |
| SP-18 | `property_unitSweepConserves` | Sweep and close move the escrow's ENTIRE unit balance to the treasury (never partial), leave escrow units at zero, and change no accounting variable; sweep requires Failed | HIGH_LEVEL | SHOULD-HOLD | `:351-357`, `:383-386`; G-16 (`:352`); NatSpec `:348-349`. Sweep is permissionless and repeatable, so it must be idempotent in accounting for later refunds to work | MEDIUM | `offering_sweepFailedUnits`, `_offering_closeAndWithdraw` |
| SP-19 | `property_markFailedOnlyFlipsState` | `markFailed` sets Funding→Failed and touches nothing else — `raised`, `withdrawn`, `unitsSold`, `publicUnitsSold`, `minMet`, per-actor ledgers and escrow units all unchanged | STATE_TRANSITION | SHOULD-HOLD | `:295-301` — the only write is `state = Failed`; G-14/G-15 | HIGH | `offering_markFailed` |
| SP-20 | `property_markFailedLiveness` | `markFailed` must succeed for anyone once `closeDate` has passed with the minimum unmet | HIGH_LEVEL | SHOULD-HOLD | `:293-301` is permissionless; G-14/G-15; I-7. Refunds exist only in Failed, so blocking this edge freezes every deposit | HIGH | `offering_markFailed` (try/catch form) |
| SP-21 | `property_skimLeavesExactlyLiability` | `skimUsdc()` leaves the escrow holding exactly `raised - withdrawn`, credits the treasury exactly the surplus removed, and moves neither `raised` nor `withdrawn` | HIGH_LEVEL | SHOULD-HOLD | `:402-408`; G-21. Forfeited deposits stay untouchable inside `raised`; fails the moment the bound is computed off anything other than `raised - withdrawn` | HIGH | `_offering_skimUsdc` |
| SP-22 | `property_rescueIsConfinedToStrayTokens` | `rescue()` moves the escrow's entire stray-token balance to the recipient and touches neither USDC nor the cap table; `rescue(USDC, …)` and `rescue(pactToken, …)` both revert | HIGH_LEVEL | SHOULD-HOLD | `:392-397`; G-20 (`:393`); NatSpec `:390-391` | MEDIUM | `_offering_rescue`, `offering_rescueForbidden` (NEW) |
| SP-23 | `property_nonTransitionCallsLeaveStateAndLedger` | No function other than `markFailed`/`closeAndWithdraw` may change `state`; admin and config calls (`setTreasury`, `setPublicUnits`, `skimUsdc`, `rescue`) never touch the state machine or the sale ledger | STATE_TRANSITION | SHOULD-HOLD | I-7 — `state` has exactly two write sites; `:264-268` writes only `publicUnits`; `:392-397`, `:402-408`, `:411-415`. `setTreasury` is unrestricted mid-raise (audit M-6) and `skimUsdc` reads `raised - withdrawn` | MEDIUM | every handler except `offering_markFailed` and `_offering_closeAndWithdraw` |
| SP-24 | `property_cancelAllocationOnlyConsumes` | `cancelAllocation` marks the id consumed and changes nothing else | STATE_TRANSITION | SHOULD-HOLD | `:256-259` | LOW | `_offering_cancelAllocation` |
| SP-25 | `property_ownershipHandoffPostconditions` | `transferOwnership` sets `pendingOwner` and leaves `owner`; `acceptOwnership` moves `owner` to the pre-call `pendingOwner` and clears it. Neither touches accounting | STATE_TRANSITION | SHOULD-HOLD | `:420-424`, `:427-433` | MEDIUM | `_offering_transferOwnership`, `_offering_acceptOwnership` |
| SP-26 | `property_ownershipRoundTripRevivesVouchers` | Ownership round-trips exactly on the owner slot (A→B→A restores `owner == A`, `pendingOwner == 0`); a cancelled allocation stays dead through rotations; BUT a voucher merely mass-revoked by rotating away from its signer becomes spendable again when ownership returns | STATE_TRANSITION | SHOULD-HOLD | `:420-433`; I-9; `:217` validates `ownerSig` against the LIVE owner with no nonce or epoch. NatSpec `:417-419` claims rotation "revokes every outstanding link" — true only while ownership does not rotate back. The revival leg is the exploratory half | MEDIUM | `_offering_acceptOwnership` |
| SP-27 | `property_onlyOwnerGatesHold` | Every `onlyOwner` entry point, plus `acceptOwnership` from a non-pending address, reverts when called by an arbitrary non-owner actor | STATE_TRANSITION | SHOULD-HOLD | `:133-136` `onlyOwner`; G-22 (`:428`). The harness only ever calls admin functions `asAdmin`, so the gate is untested today; `setTreasury` and `refundAll` are the prizes | MEDIUM | `offering_adminAsRandomActor` (NEW) |
| SP-28 | `property_blocklistDestroysNoValue` | A payment-token blocklist cannot cost a buyer their deposit or their equity — a blocked buyer's ledger stays intact until unblocked, and a blocked treasury never destroys value | HIGH_LEVEL | EXPLORATORY | NatSpec `:321-324`; `MockUSDC.blocked` exists but nothing toggles it, so the `refundAll` skip branch — exactly where the CEI inversion bites — is dead code today. Audit M-3 is accepted; what must not happen is value destruction | MEDIUM | `usdc_setBlocked` (NEW) + `_offering_refundAll`, `offering_refund`, `offering_withdraw` |
| SP-29 | `property_distributeFundsNeverReverts` | `distributeFunds` called with the complete nonzero-holder set must never revert — otherwise revenue is permanently stuck | HIGH_LEVEL | SHOULD-HOLD | `vendor/LiquidSplit.sol:65-101`, `:17`; x-ray Protocol-Type Concerns. The only property whose failure means lost money | HIGH | `_pactToken_distributeFunds` (wrap the bare call in try/catch with `t(false)` on revert) |
| SP-30 | `property_ethDistributionReachesPayoutSplit` | After `distributeFunds(address(0), …)` the token's ETH balance is 0 and the prior balance sits in `payoutSplit` | STATE_TRANSITION | EXPLORATORY | `vendor/LiquidSplit.sol:80-88` — `payoutSplit.call{value}("")` with an UNCHECKED return. `PayoutSplitStub` has `receive()` so it passes today; the value is pinning the assumption for a real-SplitMain swap | LOW | `_pactToken_distributeFunds` (ETH branch) |
| SP-31 | `property_unitTransferMovesExactly` | A transfer moves exactly `amount` from sender to recipient and touches no third party; same for the batch variant | HIGH_LEVEL | SHOULD-HOLD | ERC-1155 MUST; `vendor/ERC1155.sol:63-64`, `:96-97`. Catches an override that silently rounds or fee-splits units | MEDIUM | `pactToken_safeTransferFrom`, `_pactToken_safeBatchTransferFrom` |
| SP-32 | `property_unauthorizedTransferReverts` | A caller that is neither the owner, nor an approved operator, nor the Offering cannot move another account's units — `safeTransferFrom` and `safeBatchTransferFrom` must revert | STATE_TRANSITION | SHOULD-HOLD | ERC-1155 MUST; `vendor/ERC1155.sol:61` `NOT_AUTHORIZED`. Existing handlers always prank as `from`, so the authorization branch of the overridden `isApprovedForAll` is untested | HIGH | `pactToken_transferUnauthorized` (NEW) |
| SP-33 | `property_noopTransfersChangeNothing` | A self-transfer of any amount and a zero-amount transfer to another holder both succeed and change nothing | STATE_TRANSITION | SHOULD-HOLD | ERC-1155 MUST (zero-value is a normal transfer); solmate's `-=`/`+=` order is safe for `from == to`. `toActorNotCurrent` structurally excludes self-transfers from every existing handler, so the aliasing case (the classic mint bug) is unreachable today | MEDIUM | `pactToken_transferNoop` (NEW) |
| SP-34 | `property_invalidTransferReverts` | A transfer to `address(0)` or of more than the balance reverts | STATE_TRANSITION | SHOULD-HOLD | ERC-1155 MUST; `vendor/ERC1155.sol:68-74`, checked `-=` at `:63`. Proves the no-burn claim GL-16 depends on, by attempt | MEDIUM | `pactToken_transferInvalid` (NEW) |

---

## Ghost Variables (40)

Names reconciled across agents — where several agents proposed the same quantity
under different names (`usdcRefunded`/`refundReceived`, `grossRaised`/`buyCostTotal`,
`unitsRefundCleared`/`unitsReclaimedTotal`, `maxUnitsSoldSeen`/`lastUnitsSold`,
`unitsInNonSale`/`unitsDonated`+`unitsReclaimedTotal`, `treasuryUsdcOut`/`withdrawPaid`+`usdcSkimmed`)
there is exactly ONE ghost below. All live in `Base.sol`'s `Ghosts` struct.

| # | Ghost | Type | Written by | Used by |
|---|---|---|---|---|
| 1 | `usdcMinted` | `uint256` | `setup()` (= 4 × `INITIAL_USDC_BALANCE`), `offering_donateUsdc_clamped` | GL-06 |
| 2 | `usdcDonated` | `uint256` | `offering_donateUsdc_clamped` | GL-01 |
| 3 | `usdcSkimmed` | `uint256` | `_offering_skimUsdc` (return value) | GL-01 |
| 4 | `withdrawPaid` | `uint256` | `offering_withdraw` (return), `_offering_closeAndWithdraw` (Δ`withdrawn`) | GL-04 |
| 5 | `grossRaised` | `uint256` | both buy handlers (Δ`raised`); never decremented | GL-05, GL-26, GL-40 |
| 6 | `usdcPaid` | `mapping(address=>uint256)` | both buy handlers | GL-07, GL-08 |
| 7 | `usdcRefunded` | `mapping(address=>uint256)` | `offering_refund`, `_offering_refundAll` (per-buyer balance delta) | GL-07, GL-08, SP-13 |
| 8 | `usdcRefundedTotal` | `uint256` | same two handlers | GL-05 |
| 9 | `privateUnitsSold` | `uint256` | `offering_buyPrivate` (Δ`unitsSold`) | GL-12 |
| 10 | `unitsDonated` | `uint256` | `pactToken_donateToEscrow_clamped` | GL-13, GL-14, GL-25, SP-17 |
| 11 | `unitsReclaimed` | `mapping(address=>uint256)` | both refund handlers (per-buyer escrow-unit delta) | GL-15 |
| 12 | `unitsReclaimedTotal` | `uint256` | both refund handlers | GL-11, GL-13 |
| 13 | `unitsSwept` | `uint256` | `offering_sweepFailedUnits` (return), `_offering_closeAndWithdraw` (escrow units before) | GL-13 |
| 14 | `unitsBoughtCum` | `mapping(address=>uint256)` | both buy handlers | GL-15 |
| 15 | `privateBuyCount` | `uint256` | `offering_buyPrivate` on success | GL-42 |
| 16 | `allocationClaims` | `mapping(bytes32=>uint256)` | `offering_buyPrivate` on success | SP-04 |
| 17 | `allocationCancelled` | `mapping(bytes32=>bool)` | `_offering_cancelAllocation` | SP-04, SP-26 |
| 18 | `lastState` | `uint8` (seed 0) | `property_stateTransitionsAreLegal`, `_syncMonotonicGhosts()` | GL-35 |
| 19 | `everFailed` | `bool` | same | GL-35 |
| 20 | `everClosed` | `bool` | same | GL-35 |
| 21 | `lastPactToken` | `address` (seed `address(token)`) | `_syncMonotonicGhosts()` | GL-33 |
| 22 | `lastOwner` | `address` (seed `admin`) | `_syncMonotonicGhosts()` | GL-33 |
| 23 | `lastPendingOwner` | `address` (seed 0) | `_syncMonotonicGhosts()` | GL-33 |
| 24 | `lastUnitsSold` | `uint256` | `_syncMonotonicGhosts()` | GL-28, GL-25 |
| 25 | `lastWithdrawn` | `uint256` | `_syncMonotonicGhosts()` | GL-28 |
| 26 | `lastPublicUnitsSold` | `uint256` | `_syncMonotonicGhosts()` | GL-28 |
| 27 | `lastRaised` | `uint256` | `_syncMonotonicGhosts()` | GL-30 |
| 28 | `minMetEver` | `bool` | `_syncMonotonicGhosts()` | GL-29 |
| 29 | `lastDeposits` | `mapping(address=>uint256)` | `_syncMonotonicGhosts()` | GL-31 |
| 30 | `lastUnitsBought` | `mapping(address=>uint256)` | `_syncMonotonicGhosts()` | GL-31 |
| 31 | `allocSeen` | `bool[8]` | `_syncMonotonicGhosts()` | GL-32 |
| 32 | `lastConsumedCount` | `uint256` | `_syncMonotonicGhosts()` | GL-32 |
| 33 | `terminalRecorded` | `bool` | `_syncMonotonicGhosts()` on the first non-Funding observation | GL-34 |
| 34 | `terminalUnitsSold` | `uint256` | same | GL-34 |
| 35 | `terminalPublicUnitsSold` | `uint256` | same | GL-34 |
| 36 | `terminalRaised` | `uint256` | same | GL-34 |
| 37 | `approvedGhost` | `mapping(address=>mapping(address=>bool))` | `_pactToken_setApprovalForAll` | GL-43 |
| 38 | `soldPastEscrow` | `bool` | `_syncMonotonicGhosts()` when `unitsSold > OFFERING_UNITS` | GL-25 |
| 39 | `lastBuyPosition` | `mapping(address=>uint256)` | both buy handlers (`unitsSold` before the buy) | SP-10 |
| 40 | `blockedDeposit` | `mapping(address=>uint256)` | `usdc_setBlocked` (NEW) | SP-28 |

**Sampling note (all latch/monotonic ghosts, #18–#38):** a public global property is
only evaluated when the fuzzer schedules it, so it catches changes only between
sampled points. Add one shared `_syncMonotonicGhosts()` and call it at the end of
every Offering handler for airtight coverage; the global property then only
asserts and re-seeds.

---

## Snapshot Fields (27) — `Snapshots.State`

| Field | Type | Needed by |
|---|---|---|
| `state` | `uint8` | SP-02, SP-08, SP-16, SP-18, SP-19, SP-23, SP-24 |
| `minMet` | `bool` | SP-02, SP-08, SP-13, SP-14, SP-16, SP-18, SP-19 |
| `raised` | `uint256` | SP-01, SP-08, SP-14, SP-16, SP-19, SP-21, SP-23, SP-24 |
| `withdrawn` | `uint256` | SP-03, SP-08, SP-13, SP-14, SP-16, SP-18, SP-19, SP-21 |
| `unitsSold` | `uint256` | SP-01, SP-08, SP-10, SP-13, SP-18, SP-19, SP-23, SP-24 |
| `publicUnits` | `uint256` | SP-04 |
| `publicUnitsSold` | `uint256` | SP-04, SP-08, SP-19 |
| `escrowUsdc` | `uint256` | SP-01, SP-08, SP-14, SP-21, SP-22 |
| `escrowUnits` | `uint256` | SP-01, SP-08, SP-16, SP-18, SP-19, SP-22, SP-24, SP-31 |
| `escrowStray` | `uint256` | SP-22 |
| `treasury` | `address` | SP-14, SP-18, SP-21 (snapshot the address so before/after read the same account) |
| `treasuryUsdc` | `uint256` | SP-14, SP-21 |
| `treasuryUnits` | `uint256` | SP-18 |
| `owner` | `address` | SP-25, SP-26 |
| `pendingOwner` | `address` | SP-25, SP-26 |
| `actorUsdc` | `uint256` | SP-01, SP-04, SP-08, SP-09, SP-11 |
| `actorUnits` | `uint256` | SP-01, SP-08, SP-09, SP-11, SP-12 |
| `actorDeposits` | `uint256` | SP-01, SP-03, SP-08, SP-09, SP-11 |
| `actorUnitsBought` | `uint256` | SP-01, SP-03, SP-08, SP-09 |
| `sumDeposits` | `uint256` | SP-03 (other-actor isolation), GL-36 helper |
| `sumUnitsBought` | `uint256` | SP-03, GL-11 helper |
| `rescueRecipientStray` | `uint256` | SP-22 |
| `tokenEth` | `uint256` | SP-30 |
| `payoutSplitEth` | `uint256` | SP-30 |
| `timestamp` | `uint256` | SP-02 |
| `transferFromUnits` | `uint256` | SP-31, SP-33, SP-34 |
| `transferToUnits` | `uint256` | SP-31, SP-33, SP-34 |

**Per-batch properties use handler locals, not this struct.** `State` is
single-actor-oriented (one `actor*` set). SP-13 (`refundAll`), SP-17 and any other
property that must reason about all three buyers in one call MUST capture
per-buyer before/after arrays as locals inside the handler and pass them into the
property function — do not widen `State` into per-actor arrays.

---

## Handler Wiring (35 handlers)

### Existing handlers

| Handler | Calls |
|---|---|
| `offering_buyPublic` (via `_clamped`, `_full`) | SP-01, SP-02, SP-03, SP-23; ghosts 5, 6, 14, 24–38, 39 |
| `offering_buyPrivate` (via `_clamped`) | SP-01, SP-02, SP-03, SP-04, SP-23; ghosts 5, 6, 9, 14, 15, 16, 39 |
| `offering_refund` | SP-08, SP-09, SP-10, SP-23; ghosts 7, 8, 11, 12 |
| `offering_withdraw` | SP-14, SP-15, SP-23; ghost 4 |
| `offering_markFailed` | SP-19, SP-20 |
| `offering_sweepFailedUnits` | SP-18, SP-23; ghost 13 |
| `_offering_closeAndWithdraw` | SP-16, SP-17, SP-18; ghosts 4, 13 |
| `_offering_refundAll` | SP-10, SP-13, SP-23; ghosts 7, 8, 11, 12 |
| `_offering_cancelAllocation` | SP-24, SP-23; ghost 17 |
| `_offering_setPublicUnits` | SP-23 |
| `_offering_setTreasury` | SP-23 |
| `_offering_skimUsdc` | SP-21, SP-23; ghost 3 |
| `_offering_rescue` | SP-22, SP-23 |
| `_offering_transferOwnership` | SP-25, SP-23 |
| `_offering_acceptOwnership` | SP-25, SP-26, SP-23 |
| `offering_donateUsdc_clamped` | SP-23; ghosts 1, 2 |
| `pactToken_safeTransferFrom` (via `_clamped`, `transferAll`, `donateToEscrow_clamped`) | SP-31; ghost 10 (escrow variant) |
| `_pactToken_safeBatchTransferFrom` | SP-31 |
| `_pactToken_setApprovalForAll` | ghost 37 |
| `_pactToken_distributeFunds` | SP-29, SP-30 |
| `pactToken_donateETH_clamped` | — (feeds GL-10, SP-30) |

Every Offering handler additionally calls `_syncMonotonicGhosts()` last.

### New handlers to add (14)

| Handler | Needed by | Notes |
|---|---|---|
| `offering_roundTrip_buyFailRefund()` | SP-11 | Self-contained: buy under `minMet`, warp past `closeDate`, `markFailed`, `refund`. Drives the offering into terminal Failed — schedule it alongside `markFailed`. This plus SP-10 are the stand-ins for the C2 dust round trip, which is structurally UNREACHABLE in this protocol (no repeatable buy/sell cycle; `_buy` is blocked outside Funding). Do not build a C2 handler. |
| `offering_refund_afterReacquire(address seed)` | SP-12 | Transfer units away with `pactToken_transferAll`, reacquire the same count from another holder, then refund. |
| `offering_buyPrivate_staleOwner(uint8 idSeed, uint256 units)` | SP-05 | Sign `ownerSig` with the NON-live owner seat (`ownerKey == OWNER_KEY ? OWNER_KEY_B : OWNER_KEY`); assert the claim reverts. |
| `offering_buyPrivate_frontrun(uint8 idSeed, uint256 units, address other)` | SP-06 | Build `claimSig` over `toActorNotCurrent(other)` but call as `actor`; assert revert. |
| `offering_adminAsRandomActor(uint8 selector, uint256 arg0, address arg1)` | SP-27 | Mirror the `offering_secondary` selector switch but prank a non-owner actor; assert every branch reverts. Include `acceptOwnership` from a non-pending address. |
| `offering_buy_reenter(uint256 units)` | SP-07 | Requires arming the receiver: either extend `Actor` with a re-entry flag or route the buy through `test/Mocks.sol`'s existing unused `ReenterOnReceive`. Keep the re-entry attempt asserting that it reverts. |
| `usdc_setBlocked(uint256 actorSeed, bool value)` | SP-28 | Toggles `MockUSDC.blocked`. Without it, the `refundAll` skip branch (where the CEI inversion bites), SP-13's skip assertions and SP-09's eligibility carve-out are all unreachable. |
| `offering_rescueForbidden(uint8 which, address seed)` | SP-22 | Calls `rescue(USDC, …)` and `rescue(pactToken, …)`; asserts both revert (G-20). |
| `pactToken_transferUnauthorized(address fromSeed, address toSeed, uint256 amount)` | SP-32 | Prank a caller that is neither owner nor operator nor the Offering; assert `NOT_AUTHORIZED`. Batch variant too. |
| `pactToken_transferNoop(address toSeed, uint256 amount)` | SP-33 | Self-transfer of any amount, and a zero-amount transfer to another holder. NOT routed at the escrow — a zero transfer into a terminal-state Offering is supposed to revert (receiver rejection, not an ERC-1155 violation). |
| `pactToken_transferInvalid(uint8 which, uint256 amount)` | SP-34 | Transfer to `address(0)`, and a transfer above balance; assert both revert. |
| `pactToken_revokeOfferingOperator()` | GL-43 | `setApprovalForAll(address(offering), false)` as an actor — makes the permanent-operator claim adversarial rather than assumed. |
| `offering_setTreasuryNonReceiver()` | SP-17 | **HEAVY — defer if time-boxed.** Needs a deployed non-ERC1155-receiver contract added as a `setTreasury` target (today `_offering_setTreasury` maps every seed to an `Actor`, all of which accept 1155). Without it SP-17 is unfalsifiable. |
| `factory_createSecondOffering(string name, uint256 slope)` | GL-44, GL-27 | **HEAVY — defer if time-boxed.** A second `createOffering` with a fuzzed project name (drives `escapeHTML`/`escapeJSON` through `uri()`) and `priceSlope == 0` (the only way to exercise the flat-curve branch, since the primary fixture hardcodes slope 1000). |

### Mock changes (not handlers)

- `MockSplitMain._validate`: add the sorted-unique-accounts requirement so SP-29's
  liveness claim is as strong as mainnet SplitMain — otherwise `_pactToken_distributeFunds`
  must sort its account array itself.
- `MockSplitMain._validate`: add `require(accounts.length > 1)` to make GL-20
  falsifiable against real SplitMain v1 `_validSplit` behaviour.

### Feasibility notes / nothing dropped as infeasible

Every referenced function and storage slot exists and is reachable: `costFor`,
`quote`, `remainingUnits`, `allocationConsumed`, `deposits`, `unitsBought`,
`publicUnits(Sold)`, `minMet`, `state`, `owner`/`pendingOwner`,
`token.TOTAL_SUPPLY/SUPPLY_TO_PERCENTAGE/PERCENTAGE_SCALE/scaledPercentBalanceOf/payoutSplit`,
`MockUSDC.blocked/setBlocked`, `strayToken`. `admin` in `Base.sol` tracks the live
owner and `ownerKey` its signing key, both updated by `_offering_acceptOwnership`;
per-address ghost mappings are used instead of fixed `[3]` arrays so a rotated
owner seat is still tracked. The two heavy new handlers above are the only
properties gated on non-trivial harness surface.
