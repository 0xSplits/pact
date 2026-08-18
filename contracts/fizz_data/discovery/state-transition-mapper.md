# Agent 3: State Transition Mapper — output

Sampling note (all VT/latch ghosts): a public global property is only evaluated when the fuzzer schedules it, so it catches changes only between sampled points. For airtight coverage, also refresh/compare these ghosts at the end of each Offering handler via one shared `_syncMonotonicGhosts()`.

PROPERTY_ID: ST-01
TYPE: GLOBAL
ENGLISH: Between observations, `state` stays same or moves Funding→Failed / Funding→Closed. No other edge ever.
SOLIDITY_SKETCH:
```solidity
function property_stateTransitionsAreLegal() public {
    uint8 s = uint8(offering.state()); uint8 prev = ghosts.lastState;
    t(s == prev || (prev == 0 && (s == 1 || s == 2)), "ST-01: illegal state edge");
    ghosts.lastState = s;
    if (s == 1) ghosts.everFailed = true;
    if (s == 2) ghosts.everClosed = true;
}
```
GHOST_NEEDS: `uint8 lastState` (seed 0), `bool everFailed`, `bool everClosed`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: I-7; only writers `Offering.sol:299` (G-14/G-15), `:375` (G-18/G-19).
RATIONALE: The refund-vs-withdraw safety split rests on the two terminal states never being re-entered.

PROPERTY_ID: ST-02
TYPE: GLOBAL
ENGLISH: Failed and Closed are absorbing and mutually exclusive.
GHOST_NEEDS: everFailed, everClosed
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: I-7; both transitions require `state==Funding`.

PROPERTY_ID: ST-03
TYPE: SPECIFIC (offering_markFailed)
ENGLISH: markFailed sets Funding→Failed and touches nothing else (raised, withdrawn, unitsSold, publicUnitsSold, minMet, per-actor ledgers, escrow units all unchanged).
SNAPSHOT_NEEDS: state, minMet, raised, withdrawn, unitsSold, publicUnitsSold, escrowUnits
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:295-301` — only write is `state = Failed`; G-14/G-15.

PROPERTY_ID: ST-04
TYPE: SPECIFIC (_offering_closeAndWithdraw)
ENGLISH: close requires minMet & Funding; after: Closed, withdrawn==raised, raised unchanged, escrow holds zero units.
SNAPSHOT_NEEDS: state, minMet, raised, withdrawn, escrowUnits
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:371-388`; G-18/G-19.

PROPERTY_ID: ST-05
TYPE: SPECIFIC (all handlers except markFailed and closeAndWithdraw)
ENGLISH: No other function may change `state`.
SNAPSHOT_NEEDS: state
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: I-7 — state has exactly two write sites.
RATIONALE: Write-site localisation; catches a hidden writer through the receiver hooks.

PROPERTY_ID: ST-06
TYPE: GLOBAL
ENGLISH: pactToken is a one-shot latch; once non-zero never changes.
GHOST_NEEDS: `address lastPactToken` (seed address(token))
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: I-8; `:163-169` G-1/G-2.

PROPERTY_ID: ST-07
TYPE: GLOBAL
ENGLISH: owner changes only to the prior pendingOwner and leaves pendingOwner==0; owner never address(0).
GHOST_NEEDS: `address lastOwner` (seed admin), `address lastPendingOwner` (seed 0)
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:427-433` G-22; `:421` rejects zero. Pair with ST-08 for per-call precision.

PROPERTY_ID: ST-08
TYPE: SPECIFIC (_offering_transferOwnership, _offering_acceptOwnership)
ENGLISH: transferOwnership sets pendingOwner, leaves owner; acceptOwnership moves owner to pre-call pendingOwner and clears it. Neither touches accounting.
SNAPSHOT_NEEDS: owner, pendingOwner, raised, withdrawn, unitsSold, minMet, state
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:420-424`, `:427-433`.

PROPERTY_ID: ST-09
TYPE: GLOBAL
ENGLISH: allocationConsumed[id] monotonic false→true for every reused id; consumed count never decreases.
GHOST_NEEDS: `bool[8] allocSeen`, `uint256 lastConsumedCount`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: I-9; write sites `:224` (G-4), `:257`.

PROPERTY_ID: ST-10
TYPE: SPECIFIC (offering_buyPrivate)
ENGLISH: buyPrivate finds allocationConsumed false, leaves it true, and leaves publicUnitsSold/publicUnits untouched.
SNAPSHOT_NEEDS: publicUnits, publicUnitsSold
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:216-227`; publicUnitsSold incremented only in buyPublic (`:197`).

PROPERTY_ID: ST-11
TYPE: SPECIFIC (_offering_cancelAllocation)
ENGLISH: cancelAllocation marks the id consumed and changes nothing else.
SNAPSHOT_NEEDS: raised, unitsSold, escrowUnits, state
PRIORITY: LOW
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:256-259`.

PROPERTY_ID: ST-12
TYPE: SPECIFIC (offering_refund)
ENGLISH: refund requires Failed; zeroes caller deposits & unitsBought; leaves unitsSold, publicUnitsSold, withdrawn, minMet, state; does not touch other actors' ledgers.
SNAPSHOT_NEEDS: state, minMet, withdrawn, unitsSold, publicUnitsSold, deposits[3], unitsBought[3], acting index
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-16 (`:308`); writes `:313-315`; unitsSold has no decrementing writer (I-3).

PROPERTY_ID: ST-13
TYPE: SPECIFIC (_offering_refundAll)
ENGLISH: For each listed buyer, refundAll either fully clears (both zero) or leaves both untouched — never a partial clear — and never changes unitsSold/withdrawn/minMet/state.
SNAPSHOT_NEEDS: same as ST-12 (all three actors)
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:325-346`; clear at `:340-343` behind continue paths.
RATIONALE: The skip-and-continue design is exactly where an atomicity bug hides.

PROPERTY_ID: ST-14
TYPE: SPECIFIC (offering_buyPublic, offering_buyPrivate)
ENGLISH: A buy increases only the caller's ledgers; other actors unchanged; withdrawn and state unchanged.
SNAPSHOT_NEEDS: deposits[3], unitsBought[3], withdrawn, state, acting index (skip when caller not an actor)
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:244-245` keyed on msg.sender only.

PROPERTY_ID: ST-15
TYPE: SPECIFIC (offering_withdraw)
ENGLISH: withdraw requires minMet; leaves withdrawn==raised; changes nothing else.
SNAPSHOT_NEEDS: minMet, raised, withdrawn, unitsSold, escrowUnits, state
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-18 (`:362`); `:363-365`.

PROPERTY_ID: ST-16
TYPE: SPECIFIC (offering_sweepFailedUnits)
ENGLISH: sweep requires Failed; leaves escrow units at zero; changes no accounting variable.
SNAPSHOT_NEEDS: state, escrowUnits, raised, withdrawn, unitsSold, minMet
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-16 (`:352`); `:353-355` full balance, no storage writes.
RATIONALE: Sweep is permissionless and repeatable; must be idempotent in accounting so later refunds work.

PROPERTY_ID: ST-17
TYPE: SPECIFIC (setTreasury, setPublicUnits, skimUsdc, rescue)
ENGLISH: Admin/config calls never touch state machine or sale ledger.
SNAPSHOT_NEEDS: full State
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:264-268` (only publicUnits), `:392-397`, `:402-408`, `:411-415`.
RATIONALE: setTreasury unrestricted mid-raise (M-6) and skimUsdc reads raised-withdrawn; both must be strictly outside the ledger.

PROPERTY_ID: VT-01
TYPE: GLOBAL
ENGLISH: unitsSold non-decreasing forever.
GHOST_NEEDS: `uint256 lastUnitsSold`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: I-3 — one write site `:247` (+=), no decrementing writer.

PROPERTY_ID: VT-02
TYPE: GLOBAL
ENGLISH: withdrawn non-decreasing.
GHOST_NEEDS: `uint256 lastWithdrawn`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: I-5 — both writes are += (`:365`, `:378`).

PROPERTY_ID: VT-03
TYPE: GLOBAL
ENGLISH: publicUnitsSold non-decreasing.
GHOST_NEEDS: `uint256 lastPublicUnitsSold`
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: I-4 — single write `:197`.

PROPERTY_ID: VT-04
TYPE: GLOBAL
ENGLISH: publicUnitsSold <= publicUnits always, including after owner lowers publicUnits.
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: I-4; G-3 (`:196`), G-13 (`:265`).

PROPERTY_ID: VT-05
TYPE: GLOBAL
ENGLISH: withdrawn <= raised always.
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: I-5 — the two decrementing regimes never overlap.
RATIONALE: A violation reverts every subsequent buy/withdraw/skim via underflow.

PROPERTY_ID: VT-06
TYPE: GLOBAL
ENGLISH: minMet one-shot latch: once true never false, even after refunds drag raised below raiseMin.
GHOST_NEEDS: `bool minMetEver`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: I-6 — single write `:248` writes only true.

PROPERTY_ID: VT-07
TYPE: GLOBAL
ENGLISH: raised may only decrease while Failed; in Funding and Closed non-decreasing.
GHOST_NEEDS: `uint256 lastRaised`
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: decrementers `:315`, `:342` behind G-16.

PROPERTY_ID: VT-08
TYPE: GLOBAL
ENGLISH: While Funding, every actor's deposits/unitsBought non-decreasing; may only fall (to exactly zero) while Failed.
GHOST_NEEDS: `uint256[3] lastDeposits`, `uint256[3] lastUnitsBought`
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: incrementers `:244-245`; decrementers zero both `:313-314`,`:340-341` behind G-16.
RATIONALE: Global form of ST-12/ST-13 — catches a partial clear via a no-snapshot path.

PROPERTY_ID: VS-01
TYPE: GLOBAL
ENGLISH: state==Failed implies minMet==false.
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-15 (`:298`) at transition, held by I-6 + I-7.
RATIONALE: Refund rights and withdrawal rights provably disjoint.

PROPERTY_ID: VS-02
TYPE: GLOBAL
ENGLISH: state==Closed implies minMet==true.
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-18 (`:372`) gates the only Closed transition.

PROPERTY_ID: VS-03
TYPE: GLOBAL
ENGLISH: withdrawn>0 implies minMet==true.
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: both withdrawn writers behind G-18.

PROPERTY_ID: VS-04
TYPE: GLOBAL
ENGLISH: state==Failed implies withdrawn==0.
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: composition of VS-01 + VS-03; I-5 derivation.
RATIONALE: Makes refund solvency (E-2) reachable; localises a break faster than E-1.

PROPERTY_ID: VS-05
TYPE: GLOBAL
ENGLISH: state==Failed implies block.timestamp > closeDate.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-14 (`:297`); closeDate immutable.

PROPERTY_ID: VS-06
TYPE: GLOBAL
ENGLISH: state==Closed implies withdrawn==raised (zero residual liability, permanently).
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:376-380` drains at transition; afterward raised frozen (G-8/G-16), withdraw reverts NothingToWithdraw.

PROPERTY_ID: VS-07
TYPE: GLOBAL
ENGLISH: state==Closed implies escrow holds zero units, never regains any.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:383-386` sweep at close; G-23 (`:445`,`:461`) rejects inbound transfers post-Funding.
RATIONALE: Exercises X-2 donation surface against a terminal state.

PROPERTY_ID: VS-08
TYPE: GLOBAL
ENGLISH: minMet == (raised >= raiseMin) — biconditional.
PRIORITY: MEDIUM
GUARANTEE: EXPLORATORY
EVIDENCE: forward from `:248`; reverse rests on raised never falling below raiseMin after the latch (refunds need Failed⇒!minMet). Nothing asserts the biconditional; raiseMin==0 edge. Harness RAISE_MIN=100e6 so treat a failure as a real bug (refund reached a minMet offering).

PROPERTY_ID: VS-09
TYPE: SPECIFIC (offering_buyPublic, offering_buyPrivate)
ENGLISH: Any successful buy satisfies: block.timestamp <= closeDate OR minMet was already true BEFORE the call.
SNAPSHOT_NEEDS: minMet (before)
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-10 (`:236`), receiver hooks `:447`/`:462`; I-10.
RATIONALE: Snapshot-of-minMet-before is essential — checking after lets a buy that itself crossed the minimum past the deadline pass trivially.

PROPERTY_ID: VS-10
TYPE: GLOBAL
ENGLISH: Per actor, deposits>0 iff unitsBought>0.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: written as a pair `:244-245` with unitsWanted>=1 and cost>=priceStart>0; zeroed as a pair `:313-314`,`:340-341`.
RATIONALE: G-17 compares balance against unitsBought — a desync makes refunds impossible or free.
