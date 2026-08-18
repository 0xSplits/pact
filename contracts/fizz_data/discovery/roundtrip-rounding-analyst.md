# Agent 2: Round-Trip & Rounding Analyst — output

Key finding: the curve has NO rounding surface. `units*(units-1)` is a product of consecutive integers (always even), so the `/2` in `costFor` is exact for every input. All RD-01/02/04 are stated as exact equalities, not directional inequalities. The only round trip the state machine admits is buy → markFailed → refund (one-shot; refund needs Failed, Failed blocks _buy). Ownership transfer/accept is the only other inverse pair and it REVERSES rotation-based voucher revocation.

PROPERTY_ID: [RT-01]
TYPE: GLOBAL
ENGLISH: For every actor, USDC paid in across all buys minus USDC received from all refunds equals their current `deposits`.
SOLIDITY_SKETCH:
```solidity
function property_depositLedgerMatchesCashFlow() public {
    for (uint256 i; i < actors.length; i++) {
        address a = actors[i];
        gte(ghosts.usdcPaid[a], ghosts.usdcRefunded[a], "RT-01: refunded more than paid");
        eq(ghosts.usdcPaid[a] - ghosts.usdcRefunded[a], offering.deposits(a), "RT-01: deposits != paid - refunded");
    }
    eq(ghosts.usdcPaid[admin] - ghosts.usdcRefunded[admin], offering.deposits(admin), "RT-01: admin");
}
```
GHOST_NEEDS: `mapping(address=>uint256) usdcPaid` (buy handlers), `mapping(address=>uint256) usdcRefunded` (refund + refundAll)
SNAPSHOT_NEEDS: none
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:244`/`:250` buy pair; `:309/:313/:317` refund; `:329/:336/:340` refundAll; I-1. USDC hardcoded non-fee (`:56`).
RATIONALE: Strongest single statement of round-trip integrity, holds continuously; catches over/under/double-pay refunds.

PROPERTY_ID: [RT-02]
TYPE: SPECIFIC (offering_refund)
ENGLISH: A successful `refund()` is an exact inverse: caller USDC +deposit, caller units −unitsBought, escrow units +unitsBought, `raised` −deposit, both ledgers to zero, `unitsSold` UNCHANGED (must not rewind).
SOLIDITY_SKETCH:
```solidity
function property_refundIsExactInverse(uint256 dep, uint256 units) internal {
    eq(stateAfter.usdcActor,  stateBefore.usdcActor + dep,      "RT-02: usdc delta");
    eq(stateAfter.unitsActor, stateBefore.unitsActor - units,   "RT-02: unit delta");
    eq(stateAfter.escrowUnits, stateBefore.escrowUnits + units, "RT-02: escrow reclaim");
    eq(stateAfter.raised,     stateBefore.raised - dep,         "RT-02: raised delta");
    eq(offering.deposits(actor), 0,     "RT-02: deposits not zeroed");
    eq(offering.unitsBought(actor), 0,  "RT-02: unitsBought not zeroed");
    eq(stateAfter.unitsSold, stateBefore.unitsSold, "RT-02: curve rewound");
}
```
GHOST_NEEDS: usdcRefunded, unitsReclaimed
SNAPSHOT_NEEDS: usdcActor, unitsActor, escrowUsdc, escrowUnits, raised, unitsSold, withdrawn
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:307-319`; X-1 (`PactToken.sol:49-51`); unitsSold non-rewind is I-3.
RATIONALE: The exact-inverse pair; `unitsSold` clause is deliberately opposite polarity.

PROPERTY_ID: [RT-03]
TYPE: GLOBAL
ENGLISH: No actor extracts more USDC than they put in; cumulative refunds never exceed cumulative buy costs, per actor and aggregate.
SOLIDITY_SKETCH:
```solidity
function property_noFreeProfitFromRoundTrip() public {
    uint256 paid; uint256 refunded;
    for (uint256 i; i < actors.length; i++) {
        lte(ghosts.usdcRefunded[actors[i]], ghosts.usdcPaid[actors[i]], "RT-03: per-actor profit");
        paid += ghosts.usdcPaid[actors[i]]; refunded += ghosts.usdcRefunded[actors[i]];
    }
    lte(refunded, paid, "RT-03: aggregate profit");
}
```
GHOST_NEEDS: usdcPaid, usdcRefunded
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Follows from RT-01 + `deposits>=0`; E-1.
RATIONALE: Inequality form survives handler paths RT-01's ghost bookkeeping might not cover.

PROPERTY_ID: [RT-04]
TYPE: GLOBAL
ENGLISH: No free shares on the reverse leg: `unitsBought(a) + unitsReclaimed(a) == unitsBoughtCum(a)`, and reclaimed never exceeds bought.
SOLIDITY_SKETCH:
```solidity
function property_refundReclaimsExactlyUnitsBought() public {
    for (uint256 i; i < actors.length; i++) {
        address a = actors[i];
        eq(offering.unitsBought(a) + ghosts.unitsReclaimed[a], ghosts.unitsBoughtCum[a], "RT-04: unit round-trip leak");
        lte(ghosts.unitsReclaimed[a], ghosts.unitsBoughtCum[a], "RT-04: over-reclaim");
    }
}
```
GHOST_NEEDS: `mapping(address=>uint256) unitsBoughtCum`, unitsReclaimed
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:245`, `:311-316`, `:331-343`; G-17.
RATIONALE: USDC leg (RT-01) and unit leg use different mechanisms (ERC20 transfer vs operator ERC1155 pull); a wrong unit count leaves RT-01 happy.

PROPERTY_ID: [RT-05]
TYPE: SPECIFIC (new dedicated handler offering_roundTrip_buyFailRefund)
ENGLISH: A full buy→fail→refund cycle is value-neutral: actor ends holding exactly the USDC and units they started with. NOTE the `depStart` term — earlier buys refund in the same call, so naive "balance returns to pre-buy" is wrong.
SOLIDITY_SKETCH: (self-contained handler that buys under minMet, warps past closeDate, markFailed, refund; asserts usdc == usdcStart+depStart and units == unitsStart)
GHOST_NEEDS: none beyond shared
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-14/G-15/G-16, `:307-319`; E-2. This is the ONLY round trip the state machine admits (no repeatable cycle; C2 dust extraction structurally unreachable).
RATIONALE: Balance-relative end-to-end check; catches escrow paying the right number from the wrong place. Drives the offering into terminal Failed — schedule alongside markFailed.

PROPERTY_ID: [RT-06]
TYPE: SPECIFIC (_offering_refundAll)
ENGLISH: Push variant is payout-identical to pull: each non-skipped buyer's USDC paid == their deposits and units reclaimed == unitsBought; every skipped buyer's ledgers completely untouched.
GHOST_NEEDS: usdcRefunded, unitsReclaimed (this handler MUST maintain them or RT-01 breaks)
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:325-346`; `_tryTransfer` at `:336` executes BEFORE ledger writes at `:340` — CEI inversion, safe today.
RATIONALE: refundAll duplicates refund logic; the skip branches are where an atomicity bug hides.

PROPERTY_ID: [RT-07]
TYPE: SPECIFIC (after refund/refundAll)
ENGLISH: A refunded buyer cannot re-enter the curve at their old price — because unitsSold never rewinds, re-buying returned units costs ≥ original, strictly more when priceSlope>0.
SOLIDITY_SKETCH:
```solidity
function property_curveNeverRewindsOnRefund(uint256 units, uint256 soldAtBuy) internal {
    if (units == 0) return;
    gte(offering.costFor(offering.unitsSold(), units), offering.costFor(soldAtBuy, units), "RT-07: refund rewound the curve");
    if (offering.priceSlope() > 0 && offering.unitsSold() > soldAtBuy)
        gt(offering.costFor(offering.unitsSold(), units), offering.costFor(soldAtBuy, units), "RT-07: re-entry not strictly dearer");
}
```
GHOST_NEEDS: `mapping(address=>uint256) firstBuyPosition`
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: I-3; monotonicity in position from `Offering.sol:185`.
RATIONALE: C2 adapted — dust attack structurally unreachable (G-8), so pin the residual economic statement I-3 rests on.

PROPERTY_ID: [RT-08]
TYPE: SPECIFIC (_offering_acceptOwnership)
ENGLISH: Ownership round-trips exactly on the owner slot (A→B→A restores owner==A, pendingOwner==0), a cancelled allocation stays dead through rotations, BUT a voucher merely mass-revoked by rotating away from its signer becomes spendable again when ownership returns.
GHOST_NEEDS: `mapping(bytes32=>bool) cancelled`
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD (owner-slot + cancellation); EXPLORATORY (voucher-replay leg)
EVIDENCE: `Offering.sol:420-433`; I-9; `:217` validates ownerSig against LIVE owner with no nonce/epoch. NatSpec `:417-419` claims rotation "revokes every outstanding link" — true only while ownership doesn't rotate back.
RATIONALE: Two revocation mechanisms have opposite round-trip behaviour and the code doesn't say so.

PROPERTY_ID: [RT-09]
TYPE: SPECIFIC (new handler)
ENGLISH: Refund eligibility is a balance test, not provenance: a buyer who transfers units away then reacquires the same NUMBER from anyone can still refund in full.
PRIORITY: LOW
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:312` is a pure balance comparison; units are fungible. NatSpec `:305-306`. Harness has pactToken_transferAll to create the deficient state.
RATIONALE: G-17 forfeiture is recoverable — the one place "the same units come back" is false while "the same value comes back" stays true.

PROPERTY_ID: [RD-01]
TYPE: GLOBAL (stateless over fuzzed inputs)
ENGLISH: Buying one unit at a time costs exactly the same as buying the whole amount at once: `Σ_{i} costFor(s+i,1) == costFor(s,units)` to the wei.
SOLIDITY_SKETCH:
```solidity
function property_costForHasNoChunkingDust(uint256 sold, uint256 units) public {
    sold = clampBetween(sold, 0, 1000); units = clampBetween(units, 1, 64);
    uint256 acc; for (uint256 i; i < units; i++) acc += offering.costFor(sold + i, 1);
    eq(acc, offering.costFor(sold, units), "RD-01: per-unit sum != bulk cost");
}
```
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Closed form matches `Offering.sol:185` verbatim; `u*(u-1)` always even so `/2` never truncates. Pinned two-chunk case: `testFuzzBuyPathIsSplitInvariant`.
RATIONALE: Strongest anti-dust statement; answers the x-ray "floors" note — there is no rounding surface.

PROPERTY_ID: [RD-02]
TYPE: GLOBAL (stateless)
ENGLISH: No seam at any split point: `costFor(s,a+b) == costFor(s,a) + costFor(s+a,b)` exactly, including zero chunks.
SOLIDITY_SKETCH:
```solidity
function property_costForSplitIdentity(uint256 sold, uint256 a, uint256 b) public {
    sold = clampBetween(sold, 0, 1000); a = clampBetween(a, 0, 1000); b = clampBetween(b, 0, 1000);
    eq(offering.costFor(sold, a) + offering.costFor(sold + a, b), offering.costFor(sold, a + b), "RD-02: curve seam");
}
```
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: Algebraic identity verified in integers. Generalises `testFuzzBuyPathIsSplitInvariant` (which covers only s==0) to nonzero position and zero boundaries.
RATIONALE: The production seam is the public/private handoff at arbitrary s.

PROPERTY_ID: [RD-03]
TYPE: SPECIFIC (after buys)
ENGLISH: Quote equals charge: cost debited equals `quote(unitsWanted)` evaluated immediately before in the same state, and ≤ maxCost.
GHOST_NEEDS: usdcPaid, unitsBoughtCum
SNAPSHOT_NEEDS: usdcEscrow, raised, unitsSold
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:178-180`, `:241`, `:242` (G-12), `:250`. Pinned `Offering.t.sol:50-60`.
RATIONALE: Clamped handlers pass quote() as maxCost, so any quote/charge divergence becomes a silent revert — assert equality on the success path to make it visible.

PROPERTY_ID: [RD-04]
TYPE: GLOBAL (stateless)
ENGLISH: The `/2` is exact never a floor: `2*costFor(s,u) == 2*u*P + S*(2*s*u + u*(u-1))`, and `u*(u-1)` is even.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:185`; consecutive-integer parity.
RATIONALE: Future curve change introducing a genuine floor fails here first with an unambiguous message.

PROPERTY_ID: [RD-05]
TYPE: GLOBAL (stateless)
ENGLISH: Cost strictly increasing in units; average unit price never below priceStart; `costFor(s,1) == priceStart + priceSlope*s`.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:185`, `:148`.
RATIONALE: Floor-price clause protects the protocol.

PROPERTY_ID: [RD-06]
TYPE: GLOBAL (stateless)
ENGLISH: Cost non-decreasing in position, strictly increasing when priceSlope>0: `costFor(s+1,u) - costFor(s,u) == priceSlope*u`.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:185` — only sold-dependent term is `priceSlope*sold*units`.
RATIONALE: Exact-step form pairs with RT-07; quantifies how much dearer re-entry is.

PROPERTY_ID: [RD-07]
TYPE: GLOBAL (stateless) + SPECIFIC revert check
ENGLISH: `costFor(s,0)==0` and `quote(0)==0` without revert; a buy of 0 units reverts with InvalidConfig and moves no state.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:184` early return prevents `units-1` underflow; `:235` blocks the buy. costFor must stay total (factory calls it at `OfferingFactory.sol:71`).
RATIONALE: The two functions intentionally disagree at zero; unifying either direction breaks something.

PROPERTY_ID: [RD-08]
TYPE: GLOBAL
ENGLISH: The curve stays inside the factory-validated cost envelope while unitsSold ≤ offeringUnits; donated units (X-2) can push unitsSold past offeringUnits into an unvalidated, unbounded-above region.
GHOST_NEEDS: `uint256 maxUnitsSoldSeen`, `bool soldPastEscrow`
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD (in-range leg); EXPLORATORY (donated-unit leg)
EVIDENCE: `OfferingFactory.sol:71` evaluates `costFor(0, offeringUnits)` without reverting (proves full-sellout cost fits uint256); by RD-02 no in-range buy overflows. X-2 escape via `pactToken_donateToEscrow_clamped` (founder's 800 units → unitsSold to 1000 vs 200 offeringUnits).
RATIONALE: The factory's reachability guard doubles as overflow-safety proof, scoped to minted units; donations void the scope. Harness params can't overflow — value is pinning WHY.

PROPERTY_ID: [RD-09]
TYPE: GLOBAL
ENGLISH: `scaledPercentBalanceOf(a) == balanceOf(a)*1000` in full 256-bit width for every holder; percents sum to 1e6.
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `PactToken.sol:55-59` unchecked uint32 cast; exact only because supply pinned at 1000. I-11/I-12.
RATIONALE: Compare in uint256 not uint32 (a uint32-width assertion wraps exactly as the impl does). Sum clause detects units at an out-of-set address (distributeFunds then reverts).

PROPERTY_ID: [RD-10]
TYPE: GLOBAL
ENGLISH: Every buy charges strictly positive USDC and advances the curve by exactly units delivered; `grossRaised >= unitsSold * priceStart`.
GHOST_NEEDS: `uint256 grossRaised` (cumulative cost, never decremented — distinct from raised)
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:241`, `:246-247`, `:148`.
RATIONALE: Must be against a gross ghost — refunds decrement raised while unitsSold never rewinds (naive `raised >= unitsSold*priceStart` is false after any refund).

PROPERTY_ID: [RD-11]
TYPE: GLOBAL (stateless) — requires a second flat-curve deployment
ENGLISH: With priceSlope==0 cost is exactly linear `units*priceStart` at every position; position no longer affects price.
PRIORITY: LOW
GUARANTEE: SHOULD-HOLD
EVIDENCE: `Offering.sol:185` with slope 0; `:148` allows slope 0. x-ray:149.
RATIONALE: Deliberately LOW — the single Fizz fixture hardcodes slope 1000, so slope-dependent props only run on a strictly-increasing curve. Adding a second offering is real harness surface for a trivially-correct curve; do only if extending anyway.
