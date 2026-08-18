# Agent 5: Protocol-Type Specialist — output

Cross-cutting harness notes: (1) lift the deduped `_unitHolders()` set (actors[0..2], vm.addr(1), vm.addr(3), treasury, offering) into Base.sol and reuse in SPEC-01/02/03/06/07/12. (2) MockSplitMain is weaker than mainnet — it checks nonzero+sum but not sorted-unique accounts; SPEC-04 liveness is optimistic until the handler sorts the account array or the mock rejects unsorted input.

PROPERTY_ID: [SPEC-01]
TYPE: GLOBAL
ENGLISH: Cap table totals exactly 1000 units of id 0 over every possible holder (plus defensive checks that the token and payoutSplit never hold units).
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: PactToken NatSpec `:14-15`; G-27 (`:44`); _mint constructor-only; I-11.
RATIONALE: T-01. Overlaps CON-10 — merge; keep the two defensive addresses (token, payoutSplit).

PROPERTY_ID: [SPEC-02]
TYPE: GLOBAL
ENGLISH: Split percents over all holders sum to exactly 1e6 (the form SplitMain validates).
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `PactToken.sol:19`; LiquidSplit `:17`; I-12; mock `:47-54`. Overlaps CON-11.

PROPERTY_ID: [SPEC-03]
TYPE: GLOBAL
ENGLISH: scaledPercentBalanceOf(a) == balanceOf(a)*1000 in uint256; single holder ≤ 1000.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:55-59` unchecked uint32. Overlaps CON-11a, RD-09.

PROPERTY_ID: [SPEC-04]
TYPE: SPECIFIC (_pactToken_distributeFunds)
ENGLISH: distributeFunds with the complete nonzero-holder set must never revert (else revenue permanently stuck). Sort accounts ascending to mirror real SplitMain.
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: LiquidSplit `:65-101`, `:17`; x-ray Protocol-Type Concerns. Wrap the current bare call in try/catch with t(false) on revert. Also: MockSplitMain lacks the sorted-unique requirement — add sorting or the property is weaker than mainnet.
RATIONALE: SPLIT-03 liveness — the only property whose failure means lost money.

PROPERTY_ID: [SPEC-05]
TYPE: SPECIFIC (after ETH distributeFunds)
ENGLISH: After distributeFunds(address(0),…), token balance == 0 and prior balance sits in payoutSplit.
SNAPSHOT_NEEDS: tokenEthBalance, payoutSplitEthBalance
PRIORITY: LOW
GUARANTEE: EXPLORATORY
EVIDENCE: LiquidSplit `:80-88` — payoutSplit.call{value}("") with UNCHECKED return. PayoutSplitStub has receive() so passes today.
RATIONALE: Pins the assumption for a real-SplitMain swap.

PROPERTY_ID: [SPEC-06]
TYPE: GLOBAL
ENGLISH: The Offering escrow is an operator for EVERY account, unconditionally and permanently (including accounts that revoked it).
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: PactToken NatSpec `:47-51`; relied on by `Offering.sol:316`,`:343`; X-1. setApprovalForAll(offering,false) cannot revoke it (`vendor/ERC1155.sol:51-55` writes only _operatorApprovals which the override ORs over).
RATIONALE: Deliberate ERC-1155 deviation. Add a handler attempting that revocation so the property is tested adversarially.

PROPERTY_ID: [SPEC-07]
TYPE: GLOBAL
ENGLISH: For any operator that is NOT the Offering, isApprovedForAll mirrors the owner's last setApprovalForAll (ghost), defaulting false.
GHOST_NEEDS: `mapping(address=>mapping(address=>bool)) approved` — write in _pactToken_setApprovalForAll
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: ERC-1155 MUST; `vendor/ERC1155.sol:37-39,51-55`; override `:50` widens for exactly one operator.
RATIONALE: The safety half of SPEC-06 — the hardwire must be a single extra address, not a hole.

PROPERTY_ID: [SPEC-08]
TYPE: SPECIFIC (new negative handler)
ENGLISH: A caller that is neither owner nor approved operator nor the Offering cannot move another account's units — safeTransferFrom/safeBatchTransferFrom must revert.
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: ERC-1155 MUST; `vendor/ERC1155.sol:61` NOT_AUTHORIZED.
RATIONALE: The harness never exercises an unauthorized path (always pranks as `from`), so the authorization branch of the overridden isApprovedForAll is untested.

PROPERTY_ID: [SPEC-09]
TYPE: SPECIFIC (after unit transfer handlers)
ENGLISH: A transfer moves exactly `amount` from sender to recipient and touches no third party.
SNAPSHOT_NEEDS: fromUnits, toUnits, escrowUnits
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: ERC-1155 MUST; `vendor/ERC1155.sol:63-64`,`:96-97`.
RATIONALE: T-04; catches an override that silently rounds or fee-splits units; assert for the batch variant too.

PROPERTY_ID: [SPEC-10]
TYPE: SPECIFIC (new no-op transfer handler)
ENGLISH: Self-transfer of any amount and zero-amount transfer to another holder both succeed and change nothing.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: ERC-1155 MUST (zero-value = normal transfer); solmate `-=`/`+=` order-safe for from==to.
RATIONALE: toActorNotCurrent structurally excludes self-transfers from every existing handler — the aliasing case (classic mint bug) is currently unreachable. NOT routed at the escrow (a zero transfer into a terminal-state Offering is supposed to revert — receiver rejection, not an ERC-1155 violation).

PROPERTY_ID: [SPEC-11]
TYPE: GLOBAL + SPECIFIC (new negative handler)
ENGLISH: balanceOf(address(0),0)==0 always; a transfer to address(0) or of more than balance reverts.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: ERC-1155 MUST; `vendor/ERC1155.sol:68-74`, checked `-=` at `:63`.
RATIONALE: T-06 + burn-path closure SPEC-01 depends on; proves the no-burn claim by attempt.

PROPERTY_ID: [SPEC-12]
TYPE: GLOBAL
ENGLISH: Per actor, deposits==0 iff unitsBought==0; if unitsBought>0 then deposits>=unitsBought (≥1 base unit per unit).
PRIORITY: HIGH
GUARANTEE: EXPLORATORY
EVIDENCE: `:244-245` written together, `:313-314`/`:340-341` zeroed together; cost>=units from priceStart>0. Overlaps VS-10.
RATIONALE: Per-account pairing; catches an asymmetric refund path (zeroes deposits not unitsBought, or reverse).

PROPERTY_ID: [SPEC-13]
TYPE: SPECIFIC (after buys)
ENGLISH: A buy charges exactly costFor(unitsSold_before, unitsWanted), delivers exactly unitsWanted, escrow unit balance falls by exactly unitsWanted, raised rises by exactly cost.
SNAPSHOT_NEEDS: unitsSold, raised, buyerUsdc, escrowUsdc, buyerUnits, escrowUnits
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:241`, `:250-251`; NatSpec `:54-56` (no-fee). Overlaps CON-18, RD-03.
RATIONALE: SALE-01/SALE-02; transitively pins the no-fee-on-transfer assumption.

PROPERTY_ID: [SPEC-14]
TYPE: GLOBAL
ENGLISH: Curve split-invariance at the LIVE unitsSold: costFor(sold,a)+costFor(sold+a,b)==costFor(sold,a+b).
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:183-186`; testFuzzBuyPathIsSplitInvariant. Overlaps RD-02 — merge (this anchors at live unitsSold, RD-02 fuzzes position). Clamp inputs to avoid uint256 overflow spurious counterexamples.

PROPERTY_ID: [SPEC-15]
TYPE: GLOBAL
ENGLISH: Marginal price priceStart+priceSlope*unitsSold, non-decreasing; any nonzero purchase costs ≥1 base unit.
PRIORITY: LOW
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:148`, `:185`. Overlaps RD-05.
RATIONALE: Regression pin — priceSlope is unbounded uint256; a future formula change lands here first.

PROPERTY_ID: [SPEC-16]
TYPE: GLOBAL
ENGLISH: Escrow unit ledger including donations: `remainingUnits + unitsSold + unitsOutNonSale == OFFERING_UNITS + unitsInNonSale`.
GHOST_NEEDS: `unitsInNonSale` (donations to escrow + reclaimed unitsBought before each refund), `unitsOutNonSale` (sweep returns + remainingUnits before close)
SNAPSHOT_NEEDS: escrowUnits, unitsBought per refunding buyer
PRIORITY: HIGH
GUARANTEE: EXPLORATORY
EVIDENCE: `:172-175`, `:238-239`, `:353`, `:383`, `:438-449`; X-2 explicitly not enforced on-chain. Overlaps CON-12 — merge (CON-12's decomposition is equivalent).
RATIONALE: Attributes every unit entering/leaving the escrow to a named cause.

PROPERTY_ID: [SPEC-17]
TYPE: GLOBAL
ENGLISH: Terminal states freeze the curve: once state!=Funding, unitsSold and publicUnitsSold never change again and raised never increases (refunds may decrease it).
GHOST_NEEDS: terminalRecorded, terminalUnitsSold, terminalPublicUnitsSold, terminalRaised
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-8 (`:233`); I-7.
RATIONALE: SALE-03 over the sale counters (state-machine agent owns the enum). Asymmetric treatment of raised (frozen up, free to fall) is the crowdfund shape.

PROPERTY_ID: [SPEC-18]
TYPE: SPECIFIC (after buys)
ENGLISH: If a buy settles after closeDate, minMet must already have been true before it.
SNAPSHOT_NEEDS: minMet (before)
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-10 (`:236`), receiver hooks `:447`/`:462`; I-10. Same as VS-09 — merge.

PROPERTY_ID: [SPEC-19]
TYPE: SPECIFIC (offering_refund)
ENGLISH: Refund liveness — in Failed, an eligible buyer can always refund and receives exactly deposits, surrendering exactly unitsBought.
SNAPSHOT_NEEDS: buyerUsdc, buyerUnits, deposits, unitsBought
PRIORITY: HIGH
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:303-319`; E-2; G-17. Same core as ADV-01 — merge (keep the eligible⇒succeeds direction plus exact payout).
RATIONALE: E-1 says money is present; this says it's reachable — the half no balance-sheet invariant sees.

PROPERTY_ID: [SPEC-20]
TYPE: SPECIFIC (offering_buyPrivate)
ENGLISH: Each allocationId settles at most one purchase ever; USDC charged ≤ owner-signed amountCapUsdc. Observe the buyer's balance delta across the whole call (cap checked after _buy pulls USDC).
GHOST_NEEDS: `mapping(bytes32=>uint256) allocationClaims`
SNAPSHOT_NEEDS: buyerUsdc
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-4 (`:216`), G-7 (`:226`); I-9. Overlaps CON-24, ADV-11 — merge (counts settlements, not signatures).

PROPERTY_ID: [SPEC-21]
TYPE: GLOBAL
ENGLISH: publicUnitsSold <= publicUnits AND publicUnitsSold <= unitsSold.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: G-3 (`:196-197`), G-13 (`:265`), I-4. First clause overlaps CON-09/VT-04; the second (tranche composition, publicUnitsSold ≤ unitsSold) is NOT in the catalog — keep it.
RATIONALE: The two counters are incremented in different functions; a refactor can desync them.

PROPERTY_ID: [SPEC-22]
TYPE: GLOBAL
ENGLISH: Once Closed, escrow holds zero units forever and remainingUnits()==0.
PRIORITY: MEDIUM
GUARANTEE: SHOULD-HOLD
EVIDENCE: `:383-386`, `:445`, `:233`. Overlaps VS-07 — merge. NatSpec `:370`. Failed counterpart deliberately NOT asserted (sweep is repeatable because refunds keep pulling units back).

PROPERTY_ID: [SPEC-23]
TYPE: GLOBAL
ENGLISH: uri(id) never reverts and returns a non-empty `data:application/json;base64,` payload.
PRIORITY: LOW
GUARANTEE: SHOULD-HOLD
EVIDENCE: PactToken NatSpec `:61-63`.
RATIONALE: Low as written — harness fixes projectName="Fizz". The interesting inputs are hostile project names hitting escapeHTML/escapeJSON via a second offering with a fuzzed name; otherwise a constant-input smoke check that can be dropped.
