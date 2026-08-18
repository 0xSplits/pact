# Agent 1: Conservation Auditor — output

PROPERTY_ID: [CON-01]
TYPE: GLOBAL
ENGLISH: `raised` always equals the sum of `deposits[·]` over every address that can possibly have bought (the 3 actors plus both owner seats).
SOLIDITY_SKETCH:
```solidity
function property_raisedEqualsSumDeposits() public {
    eq(offering.raised(), _sumDeposits(), "CON-01: raised != sum(deposits)");
}
// helper in Base.sol
function _sumDeposits() internal view returns (uint256 s) {
    address[5] memory c = [actors[0], actors[1], actors[2], vm.addr(OWNER_KEY), vm.addr(OWNER_KEY_B)];
    for (uint256 i; i < 5; i++) s += offering.deposits(c[i]);
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: invariants.md I-1 — "`raised == Σ deposits[buyer]` at all times"; Δ-pairs `Offering.sol:244↔246`, `:313↔315`, `:340-342`; NatSpec `Offering.sol:69-70`.
RATIONALE: `raised - withdrawn` is the liability figure `skimUsdc` (G-21) treats as untouchable and `withdraw` pays out against. If the aggregate drifts from the per-buyer ledger, either buyer money is skimmable or refunds are unpayable.

PROPERTY_ID: [CON-02]
TYPE: GLOBAL
ENGLISH: While `state == Funding`, `unitsSold` equals the sum of `unitsBought[·]` across the candidate buyer set.
SOLIDITY_SKETCH:
```solidity
function property_unitsSoldEqualsSumUnitsBoughtWhileFunding() public {
    if (offering.state() != Offering.State.Funding) return;
    eq(offering.unitsSold(), _sumUnitsBought(), "CON-02: unitsSold != sum(unitsBought) during Funding");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: invariants.md I-2; the only decrementing writer (`Offering.sol:314`) is gated by G-16 (`state == Failed`).
RATIONALE: `unitsSold` is the live curve position. Any divergence means every subsequent buyer is mispriced.

PROPERTY_ID: [CON-03]
TYPE: GLOBAL
ENGLISH: Globally (all states) `unitsSold == Σ unitsBought[·] + (units cleared by refunds)`. The gap is exactly the refund-reclaimed units and nothing else.
SOLIDITY_SKETCH:
```solidity
// handlers bracket every refund path:
//   uint256 before = _sumUnitsBought(); ...call...; ghosts.unitsRefundCleared += before - _sumUnitsBought();
function property_unitsSoldDecomposition() public {
    eq(offering.unitsSold(), _sumUnitsBought() + ghosts.unitsRefundCleared,
       "CON-03: unitsSold != sum(unitsBought) + refund-cleared units");
}
```
GHOST_NEEDS: `uint256 unitsRefundCleared` (bumped in `offering_refund` and `_offering_refundAll` from the before/after delta of `_sumUnitsBought()`)
SNAPSHOT_NEEDS: `uint256 sumUnitsBought` if the delta is taken via snapshots
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: invariants.md I-3 — refunds zero `unitsBought` (`Offering.sol:314`, `:341`) without decrementing `unitsSold`; `unitsSold` has no decrementing write site anywhere.
RATIONALE: I-3 is a documented accounting gap, not a licence for arbitrary drift. Pins the gap to exactly the refund paths.

PROPERTY_ID: [CON-04]
TYPE: GLOBAL
ENGLISH: The escrow's USDC balance is exactly the buyer liability plus un-skimmed donations: `usdc.balanceOf(offering) == raised - withdrawn + donated - skimmed`.
SOLIDITY_SKETCH:
```solidity
function property_escrowUsdcExactAccounting() public {
    eq(usdc.balanceOf(address(offering)),
       offering.raised() - offering.withdrawn() + ghosts.usdcDonated - ghosts.usdcSkimmed,
       "CON-04: escrow USDC != liability + donations - skims");
}
```
GHOST_NEEDS: `uint256 usdcDonated` (add `amount` in `offering_donateUsdc_clamped`), `uint256 usdcSkimmed` (add return of `offering.skimUsdc()`)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Exact identity from the flow set: inflows are buy `cost` (`Offering.sol:250`) and donations; outflows are withdraw/close (`:366`, `:379`, each equal to the `withdrawn` increment), refunds (`:317`, `:336`, each equal to the `raised` decrement), and `skimUsdc` (`:407`); `rescue` excludes USDC (G-20); USDC hardcoded non-fee (`:56`).
RATIONALE: Sharp form of E-1. The `>=` version cannot distinguish "solvent" from "silently accumulating unaccounted USDC" and would not catch a double-paid refund masked by a donation surplus.

PROPERTY_ID: [CON-05]
TYPE: GLOBAL
ENGLISH: The escrow's USDC balance always covers the outstanding buyer liability `raised - withdrawn` (and the subtraction never underflows).
SOLIDITY_SKETCH:
```solidity
function property_escrowCoversLiability() public {
    t(offering.withdrawn() <= offering.raised(), "CON-05a: withdrawn > raised");
    gte(usdc.balanceOf(address(offering)), offering.raised() - offering.withdrawn(),
        "CON-05b: escrow USDC below buyer liability");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: invariants.md E-1, mirrored by `contracts/test/Invariant.t.sol:126`; plus I-5 "`withdrawn <= raised` always".
RATIONALE: Keeps the core solvency statement standing even if CON-04's ghost bookkeeping is mis-wired; directly pins I-5.

PROPERTY_ID: [CON-06]
TYPE: GLOBAL
ENGLISH: `withdrawn` equals the cumulative USDC actually pushed to the treasury by `withdraw()` and `closeAndWithdraw()`.
SOLIDITY_SKETCH:
```solidity
// offering_withdraw:            ghosts.withdrawPaid += offering.withdraw();
// _offering_closeAndWithdraw:   uint256 b = offering.withdrawn(); offering.closeAndWithdraw();
//                               ghosts.withdrawPaid += offering.withdrawn() - b;
function property_withdrawnEqualsPaid() public {
    eq(offering.withdrawn(), ghosts.withdrawPaid, "CON-06: withdrawn != cumulative paid out");
}
```
GHOST_NEEDS: `uint256 withdrawPaid`
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: Exact identity — both writers of `withdrawn` (`Offering.sol:365`, `:378`) increment by the amount they transfer (`:366`, `:379`); no other writer.
RATIONALE: A `withdrawn` bump without a transfer would silently convert buyer money into skimmable surplus.

PROPERTY_ID: [CON-07]
TYPE: GLOBAL
ENGLISH: Gross sale proceeds decompose exactly: `cumulativeGrossRaised == raised + cumulativeRefunded`.
SOLIDITY_SKETCH:
```solidity
// buy handlers:   ghosts.grossRaised += offering.raised() - beforeRaised;
// refund handlers: ghosts.usdcRefunded += beforeRaised - offering.raised();
function property_grossRaisedDecomposition() public {
    eq(ghosts.grossRaised, offering.raised() + ghosts.usdcRefunded,
       "CON-07: gross raised != raised + refunded");
}
```
GHOST_NEEDS: `uint256 grossRaised`, `uint256 usdcRefunded`
SNAPSHOT_NEEDS: `uint256 raised` in `State`
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `raised` has one incrementer (`Offering.sol:246`) and two decrementers (`:315`, `:342`), both refund paths.
RATIONALE: Catches any path that moves `raised` outside buy/refund even when `deposits` moves in lockstep.

PROPERTY_ID: [CON-08]
TYPE: GLOBAL
ENGLISH: `unitsSold` splits exactly into the two tranches: `unitsSold == publicUnitsSold + privateUnitsSold`.
SOLIDITY_SKETCH:
```solidity
// offering_buyPrivate: uint256 b = offering.unitsSold(); ...call...; ghosts.privateUnitsSold += offering.unitsSold() - b;
function property_tranchesPartitionUnitsSold() public {
    eq(offering.unitsSold(), offering.publicUnitsSold() + ghosts.privateUnitsSold,
       "CON-08: unitsSold != public + private tranche sales");
}
```
GHOST_NEEDS: `uint256 privateUnitsSold`
SNAPSHOT_NEEDS: `uint256 unitsSold` in `State`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `_buy` increments `unitsSold` on both paths (`Offering.sol:247`); `publicUnitsSold` incremented only by `buyPublic` (`:197`); no other writer of either.
RATIONALE: The public cap (G-3/I-4) is only meaningful if `publicUnitsSold` counts exactly the public sales.

PROPERTY_ID: [CON-09]
TYPE: GLOBAL
ENGLISH: `publicUnitsSold <= publicUnits` at all times, including across owner `setPublicUnits` adjustments.
SOLIDITY_SKETCH:
```solidity
function property_publicSoldWithinCap() public {
    lte(offering.publicUnitsSold(), offering.publicUnits(), "CON-09: public sales exceed the public cap");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: invariants.md I-4; guard-lift of G-3 (`Offering.sol:196`) and G-13 (`:265`).
RATIONALE: Boundary between the two tranches; handler probes `setPublicUnits` up to 1200.

PROPERTY_ID: [CON-10]
TYPE: GLOBAL
ENGLISH: The cap table always sums to exactly 1000 units over the complete set of addresses that can hold units in this harness.
SOLIDITY_SKETCH:
```solidity
function property_capTableSumsTo1000() public {
    eq(_sumUnits(), token.TOTAL_SUPPLY(), "CON-10: cap table != 1000 units");
}
// helper in Base.sol — deduped holder set (actors[0..2], vm.addr(1), vm.addr(3), treasury, offering)
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: invariants.md I-11 and PactToken NatSpec `PactToken.sol:14-15`; constructor assertion G-27 (`PactToken.sol:44`).
RATIONALE: Every split payout percentage derives from these balances; also a completeness check on the harness's holder-set assumption.

PROPERTY_ID: [CON-11]
TYPE: GLOBAL
ENGLISH: Split percentages are a faithful 1000× scaling of unit balances, and summed over all holders they equal `PERCENTAGE_SCALE` (1e6).
SOLIDITY_SKETCH:
```solidity
function property_scaledPercentsSumToScale() public {
    uint256 sum;
    address[] memory hs = _unitHolders();
    for (uint256 i; i < hs.length; i++) {
        eq(uint256(token.scaledPercentBalanceOf(hs[i])),
           token.balanceOf(hs[i], TOKEN_ID) * token.SUPPLY_TO_PERCENTAGE(),
           "CON-11a: scaled percent != balance * 1000");
        sum += token.scaledPercentBalanceOf(hs[i]);
    }
    eq(sum, token.PERCENTAGE_SCALE(), "CON-11b: percents don't sum to 1e6");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: invariants.md I-12; `PactToken.sol:57` (unchecked cast, bounded by I-11); MockSplitMain `_validate` requires `sum == 1e6`.
RATIONALE: Per-account leg pins the unchecked uint32 cast; sum leg is SplitMain's precondition — violation means revenue permanently stuck.

PROPERTY_ID: [CON-12]
TYPE: GLOBAL
ENGLISH: The escrow's unit balance is fully explained: `remainingUnits == OFFERING_UNITS + donatedUnits + reclaimedUnits - unitsSold - sweptUnits`.
SOLIDITY_SKETCH:
```solidity
// pactToken_donateToEscrow_clamped: ghosts.unitsDonated += amount;
// refund handlers:                  ghosts.unitsReclaimed += (escrow balance delta over the call)
// offering_sweepFailedUnits:        ghosts.unitsSwept += offering.sweepFailedUnits();
// _offering_closeAndWithdraw:       ghosts.unitsSwept += escrow balance before the call
function property_escrowUnitsAccounting() public {
    eq(offering.remainingUnits(),
       OFFERING_UNITS + ghosts.unitsDonated + ghosts.unitsReclaimed - offering.unitsSold() - ghosts.unitsSwept,
       "CON-12: escrow unit balance unexplained");
}
```
GHOST_NEEDS: `uint256 unitsDonated`, `uint256 unitsReclaimed`, `uint256 unitsSwept`
SNAPSHOT_NEEDS: `uint256 escrowUnits` in `State`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: invariants.md X-2 (unenforced equality); adding donation and sweep terms turns it exact. x-ray: "Worth tracing donated units through buy supply, closeAndWithdraw, and sweepFailedUnits accounting."
RATIONALE: Continuous tracing of the X-2 attack surface — any unit entering/leaving the escrow outside mint/sale/donation/reclaim/sweep breaks it.

PROPERTY_ID: [CON-13]
TYPE: GLOBAL
ENGLISH: `Σ unitsBought[·] <= unitsSold <= OFFERING_UNITS + donatedUnits`.
SOLIDITY_SKETCH:
```solidity
function property_unitsSoldBounded() public {
    lte(_sumUnitsBought(), offering.unitsSold(), "CON-13a: sum(unitsBought) exceeds unitsSold");
    lte(offering.unitsSold(), OFFERING_UNITS + ghosts.unitsDonated, "CON-13b: sold more units than ever escrowed");
}
```
GHOST_NEEDS: `uint256 unitsDonated` (shared with CON-12)
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-11 (`Offering.sol:239`) bounds every sale by the live escrow balance; per-buyer leg from I-2/I-3.
RATIONALE: Cheap always-true skeleton behind CON-03/CON-12 that fires even if their ghost wiring is wrong.

PROPERTY_ID: [CON-14]
TYPE: GLOBAL
ENGLISH: Once `state == Closed`, `withdrawn == raised` (zero residual liability).
SOLIDITY_SKETCH:
```solidity
function property_closedIsFullySettled() public {
    if (offering.state() != Offering.State.Closed) return;
    eq(offering.withdrawn(), offering.raised(), "CON-14: closed offering still carries liability");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `closeAndWithdraw` pays `raised - withdrawn` in full (`Offering.sol:376-381`); after Closed no path writes `raised`.
RATIONALE: Close-out identity — leftover escrow USDC after close is unambiguously surplus.

PROPERTY_ID: [CON-15]
TYPE: GLOBAL
ENGLISH: In Failed: `withdrawn == 0` and `usdc.balanceOf(offering) >= Σ deposits[·]`.
SOLIDITY_SKETCH:
```solidity
function property_failedStateFullyBacked() public {
    if (offering.state() != Offering.State.Failed) return;
    eq(offering.withdrawn(), 0, "CON-15a: withdrawal happened on a failed offering");
    gte(usdc.balanceOf(address(offering)), _sumDeposits(), "CON-15b: failed escrow cannot cover all deposits");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: invariants.md I-5 derivation (G-15 + G-18 mutual exclusion); E-2.
RATIONALE: The buyer-protection promise as an accounting fact; catches cross-contamination between withdraw and refund regimes.

PROPERTY_ID: [CON-16]
TYPE: GLOBAL
ENGLISH: USDC conserved across the whole harness universe: sum over every address that can hold USDC equals everything ever minted.
SOLIDITY_SKETCH:
```solidity
// setup(): ghosts.usdcMinted = 4 * INITIAL_USDC_BALANCE;
// offering_donateUsdc_clamped: ghosts.usdcMinted += amount;
function property_usdcConserved() public {
    address[8] memory c = [actors[0], actors[1], actors[2], vm.addr(OWNER_KEY), vm.addr(OWNER_KEY_B),
                           address(offering), address(token), token.payoutSplit()];
    uint256 s; for (uint256 i; i < 8; i++) s += usdc.balanceOf(c[i]);
    eq(s, ghosts.usdcMinted, "CON-16: USDC appeared or vanished");
}
```
GHOST_NEEDS: `uint256 usdcMinted`
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: MockUSDC creates balance only in `mint` and moves it via self-conserving transfer/transferFrom; harness mints exactly in `setup()` and the donation handler.
RATIONALE: Widest-scope conservation; catches double-payment bugs and USDC escaping to unmodeled addresses.

PROPERTY_ID: [CON-17]
TYPE: GLOBAL
ENGLISH: Stray rescue token conserved: escrow + actors always equals the 1000e18 minted at setup.
SOLIDITY_SKETCH:
```solidity
function property_strayTokenConserved() public {
    eq(strayToken.balanceOf(address(offering)) + sumActorsERC20Balances(address(strayToken)), 1_000e18,
       "CON-17: stray token not conserved");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `strayToken` minted once to escrow; only mover is `rescue` (full balance to `toActor(seed)`), G-20 forbids USDC/pactToken.
RATIONALE: Proves `rescue` stays confined to the stray token.

PROPERTY_ID: [CON-18]
TYPE: SPECIFIC (after buys)
ENGLISH: After a buy, all affected quantities move by the same cost and same unit count: `deposits[buyer]`, `raised`, escrow USDC (+cost); buyer USDC (−cost); `unitsBought[buyer]`, `unitsSold`, buyer units (+units); escrow units (−units).
SOLIDITY_SKETCH:
```solidity
function property_buyConservesBothLedgers() internal {
    uint256 cost  = stateAfter.raised - stateBefore.raised;
    uint256 units = stateAfter.unitsSold - stateBefore.unitsSold;
    eq(stateAfter.actorDeposits - stateBefore.actorDeposits, cost, "CON-18a");
    eq(stateBefore.actorUsdc - stateAfter.actorUsdc, cost, "CON-18b");
    eq(stateAfter.escrowUsdc - stateBefore.escrowUsdc, cost, "CON-18c");
    eq(stateAfter.actorUnitsBought - stateBefore.actorUnitsBought, units, "CON-18d");
    eq(stateAfter.actorUnits - stateBefore.actorUnits, units, "CON-18e");
    eq(stateBefore.escrowUnits - stateAfter.escrowUnits, units, "CON-18f");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: `raised`, `unitsSold`, `actorDeposits`, `actorUnitsBought`, `actorUsdc`, `escrowUsdc`, `actorUnits`, `escrowUnits`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `_buy` writes all six ledger slots from the same two locals (`Offering.sol:244-247`), transfers exactly `cost` in and `unitsWanted` out (`:250-251`).
RATIONALE: Per-call version of CON-01/CON-02; the only place money and unit legs are asserted to move together.

PROPERTY_ID: [CON-19]
TYPE: SPECIFIC (after refund)
ENGLISH: A successful refund pays exactly the recorded deposit and reclaims exactly the recorded units; both ledgers land on zero — never partial.
SOLIDITY_SKETCH:
```solidity
function property_refundConservesExactly() internal {
    if (stateAfter.actorDeposits == stateBefore.actorDeposits) return;      // skipped/forfeited buyer
    uint256 d = stateBefore.actorDeposits; uint256 u = stateBefore.actorUnitsBought;
    eq(stateAfter.actorDeposits, 0, "CON-19a"); eq(stateAfter.actorUnitsBought, 0, "CON-19b");
    eq(stateAfter.actorUsdc - stateBefore.actorUsdc, d, "CON-19c");
    eq(stateBefore.escrowUsdc - stateAfter.escrowUsdc, d, "CON-19d");
    eq(stateBefore.raised - stateAfter.raised, d, "CON-19e");
    eq(stateAfter.escrowUnits - stateBefore.escrowUnits, u, "CON-19f");
    eq(stateBefore.actorUnits - stateAfter.actorUnits, u, "CON-19g");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: same set as CON-18
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:309-318`; NatSpec `:303-306`.
RATIONALE: Rules out a partial refund (paying the deposit while reclaiming fewer units, or vice versa); early return keeps the forfeit path (G-17) honest.

PROPERTY_ID: [CON-20]
TYPE: SPECIFIC (after withdraw/closeAndWithdraw)
ENGLISH: withdraw/close move exactly `Δwithdrawn` USDC from escrow to treasury — no more, no less, nowhere else.
SOLIDITY_SKETCH:
```solidity
function property_withdrawPaysTreasuryExactly() internal {
    uint256 d = stateAfter.withdrawn - stateBefore.withdrawn;
    eq(stateBefore.escrowUsdc - stateAfter.escrowUsdc, d, "CON-20a: escrow debit != withdrawn delta");
    eq(stateAfter.treasuryUsdc - stateBefore.treasuryUsdc, d, "CON-20b: treasury credit != withdrawn delta");
    eq(stateAfter.raised, stateBefore.raised, "CON-20c: withdraw moved raised");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: `withdrawn`, `escrowUsdc`, `treasuryUsdc` (snapshot the treasury address itself so before/after read the same address)
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:363-366`, `:376-379`; NatSpec `:360`.
RATIONALE: Permissionless caller, fixed beneficiary — verified rather than assumed; CON-20c catches liability tampering.

PROPERTY_ID: [CON-21]
TYPE: SPECIFIC (after skimUsdc)
ENGLISH: `skimUsdc()` leaves the escrow holding exactly the buyer liability; treasury receives exactly the surplus removed; `raised`/`withdrawn` untouched.
SOLIDITY_SKETCH:
```solidity
function property_skimLeavesExactlyLiability() internal {
    uint256 skimmed = stateBefore.escrowUsdc - stateAfter.escrowUsdc;
    eq(stateAfter.escrowUsdc, stateAfter.raised - stateAfter.withdrawn, "CON-21a: skim cut into liability");
    eq(stateAfter.treasuryUsdc - stateBefore.treasuryUsdc, skimmed, "CON-21b: skimmed USDC != treasury credit");
    eq(stateAfter.raised, stateBefore.raised, "CON-21c: skim moved raised");
    eq(stateAfter.withdrawn, stateBefore.withdrawn, "CON-21d: skim moved withdrawn");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: `escrowUsdc`, `treasuryUsdc`, `raised`, `withdrawn`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:402-408`; G-21.
RATIONALE: Forfeited deposits stay untouchable inside `raised`; the donation handler creates the surplus this call is allowed to take.

PROPERTY_ID: [CON-22]
TYPE: SPECIFIC (after sweepFailedUnits / closeAndWithdraw)
ENGLISH: Sweep/close move the escrow's entire unit balance to the treasury, conserving units exactly.
SOLIDITY_SKETCH:
```solidity
function property_unitSweepConserves() internal {
    uint256 moved = stateBefore.escrowUnits - stateAfter.escrowUnits;
    eq(stateAfter.escrowUnits, 0, "CON-22a: sweep left units in escrow");
    eq(stateAfter.treasuryUnits - stateBefore.treasuryUnits, moved, "CON-22b: swept units != treasury credit");
    eq(moved, stateBefore.escrowUnits, "CON-22c: partial sweep");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: `escrowUnits`, `treasuryUnits` (treasury address snapshotted alongside)
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:351-357`, `:383-386`; NatSpec `:348-349`.
RATIONALE: The other half of E-2 — a failed raise must not leave equity stranded in a dead escrow.

PROPERTY_ID: [CON-23]
TYPE: SPECIFIC (after rescue)
ENGLISH: `rescue()` moves the escrow's entire stray-token balance to the recipient and touches nothing else (USDC and units untouched).
SOLIDITY_SKETCH:
```solidity
function property_rescueConserves() internal {
    eq(stateAfter.escrowStray, 0, "CON-23a: rescue left stray tokens behind");
    eq(stateAfter.recipientStray - stateBefore.recipientStray, stateBefore.escrowStray, "CON-23b: stray tokens lost in transit");
    eq(stateAfter.escrowUsdc, stateBefore.escrowUsdc, "CON-23c: rescue touched USDC");
    eq(stateAfter.escrowUnits, stateBefore.escrowUnits, "CON-23d: rescue touched the cap table");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: `escrowStray`, `recipientStray`, `escrowUsdc`, `escrowUnits`
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:392-397`; G-20; NatSpec `:390-391`.
RATIONALE: The negative legs (c/d) assert the exclusion guard held for this specific call.

PROPERTY_ID: [CON-24]
TYPE: GLOBAL
ENGLISH: Private claims conserved against the fixed pool of allocation ids: successful private buys never exceed consumed ids, never exceed 8.
SOLIDITY_SKETCH:
```solidity
// offering_buyPrivate: on success, ghosts.privateBuyCount += 1;
function property_privateClaimsBoundedByAllocations() public {
    uint256 consumed;
    for (uint8 i; i < 8; i++) if (offering.allocationConsumed(_allocationId(i))) consumed++;
    lte(ghosts.privateBuyCount, consumed, "CON-24a: more private claims than consumed allocations");
    lte(ghosts.privateBuyCount, 8, "CON-24b: an allocation id was spent twice");
}
```
GHOST_NEEDS: `uint256 privateBuyCount`
SNAPSHOT_NEEDS: none
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: invariants.md I-9; G-4 (`Offering.sol:216`); harness uses exactly 8 ids.
RATIONALE: Converts "each voucher is spendable once" into arithmetic the fuzzer can break.

PROPERTY_ID: [CON-25]
TYPE: GLOBAL
ENGLISH: ETH conserved across actors, PactToken, and payoutSplit: `Σ actor ETH + token ETH + payoutSplit ETH == 3 * INITIAL_ETH_BALANCE`.
SOLIDITY_SKETCH:
```solidity
function property_ethConserved() public {
    eq(sumActorsBalances() + address(token).balance + token.payoutSplit().balance,
       actors.length * INITIAL_ETH_BALANCE, "CON-25: ETH not conserved");
}
```
GHOST_NEEDS: none
SNAPSHOT_NEEDS: none
PRIORITY: LOW
GUARANTEE: EXPLORATORY
EVIDENCE: none — inferred. ETH enters only via the actors' constructor endowment, moves actor→token and token→payoutSplit; MockSplitMain's stub never forwards.
RATIONALE: Cheapest way to notice ETH silently failing to reach the payout split (LiquidSplit's bare `call` at `:81` ignores the return).
