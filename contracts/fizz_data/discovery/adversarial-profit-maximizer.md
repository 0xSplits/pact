# Agent 4: Adversarial Profit Maximizer — output

Several properties propose NEW handlers the synthesizer/implementers should add: usdc_setBlocked (blocklist), stale-owner voucher, claim frontrun, non-owner admin probe, receiver reentrancy, and a MockSplitMain `accounts.length>1` requirement. Several are deliberately falsifiable (ADV-17 public-tranche starvation, ADV-18 single-holder cap table) — the counterexample is the deliverable.

PROPERTY_ID: [ADV-01]
TYPE: SPECIFIC (offering_refund) + GLOBAL trampoline
ENGLISH: A refund cannot be made to revert for a buyer who still holds their full purchased units — that buyer must always be able to pull their entire deposit back. (E-2 liveness.)
SOLIDITY_SKETCH:
```solidity
function offering_refund() public asActor {
    bool eligible = offering.state() == Offering.State.Failed && offering.deposits(actor) > 0
        && token.balanceOf(actor, TOKEN_ID) >= offering.unitsBought(actor) && !usdc.blocked(actor);
    uint256 owed = offering.deposits(actor); uint256 balBefore = usdc.balanceOf(actor);
    try offering.refund() {
        ghosts.refundReceived[actor] += usdc.balanceOf(actor) - balBefore;
        eq(usdc.balanceOf(actor) - balBefore, owed, "ADV-01: refund underpaid");
        eq(offering.deposits(actor), 0, "ADV-01: deposit not cleared");
    } catch { t(!eligible, "ADV-01: eligible buyer could not refund (E-2 broken)"); }
}
```
GHOST_NEEDS: `mapping(address=>uint256) refundReceived`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: E-2; NatSpec `Offering.sol:36-38`; G-16/G-17 (`:308-317`); X-1 (`PactToken.sol:49-51`).
RATIONALE: Core buyer-protection promise, richest DoS target. Detects escrow drained below liability, operator status lost, sweep interfering with reclaim, any third party bricking the reclaim.

PROPERTY_ID: [ADV-02]
TYPE: SPECIFIC (offering_markFailed)
ENGLISH: markFailed must succeed for anyone once closeDate passed with minimum unmet.
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:293-301` permissionless; G-14/G-15; I-7.
RATIONALE: Refunds only exist in Failed; blocking the Funding→Failed edge freezes every deposit.

PROPERTY_ID: [ADV-03]
TYPE: SPECIFIC (offering_withdraw)
ENGLISH: Donating USDC or units into the escrow must never make a permissionless withdraw revert while raised>withdrawn and minMet (treasury not blocklisted).
GHOST_NEEDS: `uint256 treasuryUsdcOut`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:359-368`; E-1.
RATIONALE: Griefing — surplus donations/units or an interleaved skim making payout arithmetic underflow.

PROPERTY_ID: [ADV-04]
TYPE: SPECIFIC (_offering_closeAndWithdraw)
ENGLISH: A unit donor cannot brick the owner's close — closeAndWithdraw must succeed whenever minMet and Funding, however many units strangers pushed in.
GHOST_NEEDS: `uint256 unitsDonatedToEscrow`
PRIORITY: HIGH
GUARANTEE: EXPLORATORY
EVIDENCE: `:371-388` unconditional transfer of remainingUnits() to treasury; X-2. Needs harness extension: allow setTreasury to pick a non-receiver contract, else unfalsifiable.
RATIONALE: A donor forces the unit-transfer leg non-zero; a non-receiver treasury bricks close.

PROPERTY_ID: [ADV-05]
TYPE: GLOBAL
ENGLISH: No sequence leaves the escrow holding less USDC than the outstanding buyer liability.
SOLIDITY_SKETCH:
```solidity
function property_escrowCoversBuyerLiability() public {
    gte(usdc.balanceOf(address(offering)), offering.raised() - offering.withdrawn(), "ADV-05");
}
```
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: E-1; G-20/G-21; `test/Invariant.t.sol:126`.
RATIONALE: Solvency floor. Sub-case: skimUsdc must never be callable when balance==liability and must transfer at most balance−liability. (Duplicates CON-05.)

PROPERTY_ID: [ADV-06]
TYPE: GLOBAL
ENGLISH: An attacker cannot collect more USDC out of the refund machinery than they put in — cumulative refunds received ≤ cumulative buy cost, per address.
GHOST_NEEDS: `mapping(address=>uint256) buyCost`, `refundReceived`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: I-1; the refundAll CEI inversion (`:336` before `:340-342`).
RATIONALE: Direct detector for the documented CEI inversion (refund + refundAll slice off one deposit). Holds today because MockUSDC has no hooks and both paths are nonReentrant — the property makes that assumption falsifiable. (Overlaps RT-03.)

PROPERTY_ID: [ADV-07]
TYPE: GLOBAL
ENGLISH: Total USDC ever leaving the escrow (treasury via withdraw/close/skim + refunds) never exceeds buy proceeds + donations.
GHOST_NEEDS: treasuryUsdcOut, refundsPaidTotal, buyCostTotal, usdcDonated
PRIORITY: HIGH
GUARANTEE: EXPLORATORY
EVIDENCE: `:361-408`; SplitMain pushes USDC into escrow (recovered via skimUsdc).
RATIONALE: A single global money-conservation ledger across every exit door; catches double-counting the same balance. (Overlaps CON-16.)

PROPERTY_ID: [ADV-08]
TYPE: GLOBAL
ENGLISH: state==Failed and withdrawn>0 can never hold simultaneously.
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-15+G-18+I-5/I-6; I-5 "mutually exclusive". (Same as VS-04.)
RATIONALE: The catastrophic edge state: money out while refund claims live; the exact precondition for raised-withdrawn underflow.

PROPERTY_ID: [ADV-09]
TYPE: GLOBAL
ENGLISH: minMet may only be set by actual buy proceeds reaching raiseMin, never by donations/split revenue: `!minMet || buyCostTotal >= RAISE_MIN`.
GHOST_NEEDS: `uint256 buyCostTotal` (cumulative buy cost, never decremented)
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:246-248` (raised += cost then latch); I-6; G-18.
RATIONALE: If any path computed the latch off balanceOf instead of raised, a 100 USDC donation strips every buyer's refund right and hands the owner the pot.

PROPERTY_ID: [ADV-10]
TYPE: SPECIFIC (_offering_refundAll)
ENGLISH: Every buyer whose deposits went to zero during refundAll received exactly that much USDC; every skipped buyer's ledger untouched.
GHOST_NEEDS: refundReceived, refundsPaidTotal
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:325-346`; audit M-3. Pairs with a proposed usdc_setBlocked handler, without which the skip branch is never exercised.
RATIONALE: A buyer whose deposit is zeroed by a batch whose transfer silently failed — money gone, ledger gone. (Overlaps RT-06.)

PROPERTY_ID: [ADV-11]
TYPE: GLOBAL + SPECIFIC (offering_buyPrivate)
ENGLISH: Each allocationId yields at most one successful claim, never after cancelAllocation, never above its signed USDC cap.
GHOST_NEEDS: `mapping(bytes32=>uint256) claims`, `mapping(bytes32=>bool) cancelled`
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-4 (`:216`), G-7 (`:226`), I-9; NatSpec `:223`. Cap check sits AFTER _buy writes state (`:225-226`) — confirm the revert unwinds the sale.
RATIONALE: The voucher is a bearer capability in a URL fragment. (Overlaps CON-24, SPEC-20.)

PROPERTY_ID: [ADV-12]
TYPE: SPECIFIC (new handler offering_buyPrivate_staleOwner)
ENGLISH: A voucher signed by a former owner cannot be claimed after ownership rotates — rotation must mass-revoke every outstanding link. (Signs with the NON-live owner seat.)
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-5 (`:217`); NatSpec `:204-208`, `:417-419`.
RATIONALE: Key-compromise recovery depends on this; the current harness always re-signs with the live owner so the revocation claim is asserted nowhere. Only way to explore "voucher validity straddling an ownership transfer".

PROPERTY_ID: [ADV-13]
TYPE: SPECIFIC (new handler offering_buyPrivate_frontrun)
ENGLISH: A claim signature bound to buyer A must be unusable by buyer B.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-6 (`:220`); NatSpec `:31-33`.
RATIONALE: The whole two-key design exists for this; harness always signs the acting actor so the binding is never tested.

PROPERTY_ID: [ADV-14]
TYPE: SPECIFIC (new handler offering_adminAsRandomActor)
ENGLISH: Every onlyOwner entry point + acceptOwnership from a non-pending address must revert when called by an arbitrary non-owner actor.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:133-136` onlyOwner, G-22 (`:428`).
RATIONALE: The harness only ever calls admin functions asAdmin, so the gate is untested. setTreasury and refundAll are the prizes.

PROPERTY_ID: [ADV-15]
TYPE: GLOBAL + SPECIFIC (both buy handlers)
ENGLISH: No successful buy while state!=Funding or past closeDate with minimum unmet; publicUnitsSold never exceeds publicUnits.
SNAPSHOT_NEEDS: offeringState, minMet, timestamp, publicUnitsSold (before each buy)
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-3, G-8, G-10, I-4, I-10. (Overlaps VS-09, CON-09, VT-04.)

PROPERTY_ID: [ADV-16]
TYPE: GLOBAL
ENGLISH: An attacker cannot rewind the curve to buy at a stale cheap price, and can never acquire a unit for zero USDC.
GHOST_NEEDS: `uint256 maxUnitsSoldSeen`
PRIORITY: MEDIUM
GUARANTEE: EXPLORATORY
EVIDENCE: I-3; x-ray "Curve position never rewinds"; `:183-186`.
RATIONALE: Tripwire on the "no path returns to Funding" assumption; cost>=units*priceStart closes the near-zero boundary. (Overlaps VT-01, RD-05/RD-10.)

PROPERTY_ID: [ADV-17]
TYPE: GLOBAL
ENGLISH: A voucher holder cannot starve the public tranche — escrow always retains at least `publicUnits - publicUnitsSold` units while Funding.
SOLIDITY_SKETCH:
```solidity
function property_publicTrancheStaysFillable() public {
    if (offering.state() != Offering.State.Funding) return;
    gte(offering.remainingUnits(), offering.publicUnits() - offering.publicUnitsSold(), "ADV-17");
}
```
PRIORITY: MEDIUM
GUARANTEE: EXPLORATORY (deliberately falsifiable — the finding is HOW cheaply)
EVIDENCE: buyPrivate bypasses publicUnitsSold and is bounded only by remainingUnits() (`:209-227`); setPublicUnits unbounded upward.
RATIONALE: Two tranches share one supply but only public has a reservation. A single private claim can drain all escrowed units while publicUnits still reads open → subsequent buyPublic reverts InsufficientSupply. Let the fuzzer produce the minimal sequence.

PROPERTY_ID: [ADV-18]
TYPE: GLOBAL
ENGLISH: The set of nonzero unit holders never shrinks below two.
PRIORITY: MEDIUM
GUARANTEE: EXPLORATORY
EVIDENCE: `vendor/LiquidSplit.sol:65-101`; real SplitMain v1 `_validSplit` rejects `accounts.length<2`; the mock is more permissive.
RATIONALE: After closeAndWithdraw the treasury holds all unsold units; founder can transfer 800 to the same address → single-holder cap table passes the mock but reverts on Base, stranding all split revenue. Harness fix: add `require(accounts.length>1)` to MockSplitMain.

PROPERTY_ID: [ADV-19]
TYPE: SPECIFIC (_offering_skimUsdc, _offering_rescue)
ENGLISH: skimUsdc removes strictly less than the surplus above liability and never breaks E-1; rescue moves neither USDC nor a unit. Also attempt rescue(USDC) and rescue(pactToken) and assert both revert.
GHOST_NEEDS: treasuryUsdcOut
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-20 (`:393`), G-21 (`:405`).
RATIONALE: Answers the x-ray forfeited-deposit question — a forfeiter's USDC stays in raised; property fails the moment skimUsdc computes its bound off anything other than raised-withdrawn. (Overlaps CON-21, CON-23.)

PROPERTY_ID: [ADV-20]
TYPE: SPECIFIC (new reentrancy handler; arm Actor's receiver)
ENGLISH: A contract buyer cannot re-enter the offering from the ERC-1155 delivery callback to buy twice, refund during a batch, or nest any state-changing call.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: ReentrancyGuard (`:46`); `:251` unit delivery is the last external call in _buy. test/Mocks.sol ships an unused ReenterOnReceive.
RATIONALE: _buy hands control to the buyer via safeTransferFrom while nonReentrant is engaged; refund does the same on the reclaim leg; the guard is never fuzzed. NOTE: this requires arming Actor's receiver to re-enter; keep the re-entry attempt asserting it reverts.

PROPERTY_ID: [ADV-21]
TYPE: GLOBAL + new handler usdc_setBlocked(uint256 actorSeed, bool value)
ENGLISH: A payment-token blocklist cannot cost a buyer their deposit or equity — a blocked buyer's ledger stays intact until unblocked; a blocked treasury never destroys value.
GHOST_NEEDS: `mapping(address=>uint256) blockedDeposit`
PRIORITY: MEDIUM
GUARANTEE: EXPLORATORY (M-3 accepted; what must not happen is value destruction)
EVIDENCE: NatSpec `:321-324`; MockUSDC.blocked exists but no handler toggles it.
RATIONALE: The blocklist branch of refundAll is dead code under the current harness — precisely the branch where the CEI inversion bites. This handler makes ADV-10's skip assertions and ADV-01's eligibility carve-out reachable.
