// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Snapshots} from "./Snapshots.sol";
import {Offering} from "../../src/Offering.sol";

/// @notice Contains the functions that check the properties (invariants)
// PropertiesAsserts is inherited via Base, so its assert helpers are in scope.
abstract contract Properties is Snapshots {
    // ―――――――――――――――――――― Global properties ―――――――――――――――――――――
    // These properties must always hold after any function call.
    // They MUST BE PUBLIC so that fuzzers can find and call them.

    /// @notice GL-01: escrow USDC is exactly liability plus un-skimmed donations.
    function property_escrowUsdcExactAccounting() public {
        eq(
            usdc.balanceOf(address(offering)),
            offering.raised() - offering.withdrawn() + ghosts.usdcDonated - ghosts.usdcSkimmed,
            "GL-01: escrow USDC not attributable"
        );
    }

    /// @notice GL-02: withdrawn never exceeds raised and escrow covers liability.
    function property_escrowCoversLiability() public {
        lte(offering.withdrawn(), offering.raised(), "GL-02: withdrawn exceeds raised");
        gte(usdc.balanceOf(address(offering)), offering.raised() - offering.withdrawn(), "GL-02: escrow underwater");
    }

    /// @notice GL-03: raised equals the sum of deposits over every buyer.
    function property_raisedEqualsSumDeposits() public {
        eq(offering.raised(), _sumDeposits(), "GL-03: raised != sum deposits");
    }

    /// @notice GL-04: withdrawn equals cumulative USDC pushed to treasury.
    function property_withdrawnEqualsPaid() public {
        eq(offering.withdrawn(), ghosts.withdrawPaid, "GL-04: withdrawn != cumulative paid");
    }

    /// @notice GL-05: gross proceeds decompose into raised plus everything refunded.
    function property_grossRaisedDecomposition() public {
        eq(ghosts.grossRaised, offering.raised() + ghosts.usdcRefundedTotal, "GL-05: gross != raised + refunded");
    }

    /// @notice GL-06: USDC is conserved across the whole harness universe.
    function property_usdcConserved() public {
        uint256 sum;
        address[] memory h = _unitHolders();
        for (uint256 i; i < h.length; i++) {
            sum += usdc.balanceOf(h[i]);
        }
        sum += usdc.balanceOf(address(token));
        sum += usdc.balanceOf(token.payoutSplit());
        eq(sum, ghosts.usdcMinted, "GL-06: USDC not conserved");
    }

    /// @notice GL-07: per address, USDC paid minus USDC refunded equals deposits.
    function property_depositLedgerMatchesCashFlow() public {
        address[] memory h = _unitHolders();
        for (uint256 i; i < h.length; i++) {
            eq(ghosts.usdcPaid[h[i]] - ghosts.usdcRefunded[h[i]], offering.deposits(h[i]), "GL-07: ledger != cashflow");
        }
    }

    /// @notice GL-08: no address ever refunds more USDC than it paid.
    function property_noRefundProfit() public {
        address[] memory h = _unitHolders();
        for (uint256 i; i < h.length; i++) {
            lte(ghosts.usdcRefunded[h[i]], ghosts.usdcPaid[h[i]], "GL-08: refund exceeds paid");
        }
        lte(ghosts.usdcRefundedTotal, ghosts.grossRaised, "GL-08: aggregate refund exceeds gross");
    }

    /// @notice GL-09: the stray rescue token is conserved across escrow and actors.
    function property_strayTokenConserved() public {
        uint256 sum = strayToken.balanceOf(address(offering));
        for (uint256 i; i < actors.length; i++) {
            sum += strayToken.balanceOf(actors[i]);
        }
        eq(sum, strayToken.totalSupply(), "GL-09: stray token not conserved");
    }

    /// @notice GL-10: ETH is conserved across actors, the token and its payout split.
    function property_ethConserved() public {
        uint256 sum = sumActorsBalances();
        sum += address(token).balance;
        sum += token.payoutSplit().balance;
        eq(sum, actors.length * INITIAL_ETH_BALANCE, "GL-10: ETH not conserved");
    }

    /// @notice GL-11: unitsSold equals bought plus reclaimed, and bought alone while Funding.
    function property_unitsSoldDecomposition() public {
        eq(offering.unitsSold(), _sumUnitsBought() + ghosts.unitsReclaimedTotal, "GL-11: unitsSold decomposition");
        if (offering.state() == Offering.State.Funding) {
            eq(offering.unitsSold(), _sumUnitsBought(), "GL-11: unitsSold != sum bought while Funding");
        }
    }

    /// @notice GL-12: unitsSold partitions exactly into public plus private sales.
    function property_tranchesPartitionUnitsSold() public {
        eq(
            offering.unitsSold(),
            offering.publicUnitsSold() + ghosts.privateUnitsSold,
            "GL-12: tranches don't partition unitsSold"
        );
    }

    /// @notice GL-13: escrow unit balance is fully explained by the flow terms.
    function property_escrowUnitsAccounting() public {
        eq(
            offering.remainingUnits(),
            uint256(OFFERING_UNITS) + ghosts.unitsDonated + ghosts.unitsReclaimedTotal - offering.unitsSold()
                - ghosts.unitsSwept,
            "GL-13: escrow units unexplained"
        );
    }

    /// @notice GL-14: sum bought <= unitsSold <= units ever escrowed.
    function property_unitsSoldBounded() public {
        lte(_sumUnitsBought(), offering.unitsSold(), "GL-14: sum bought exceeds unitsSold");
        lte(offering.unitsSold(), uint256(OFFERING_UNITS) + ghosts.unitsDonated, "GL-14: unitsSold exceeds escrowed");
    }

    /// @notice GL-15: per actor, current bought plus reclaimed equals cumulative bought.
    function property_refundReclaimsExactlyUnitsBought() public {
        address[] memory h = _unitHolders();
        for (uint256 i; i < h.length; i++) {
            eq(
                offering.unitsBought(h[i]) + ghosts.unitsReclaimed[h[i]],
                ghosts.unitsBoughtCum[h[i]],
                "GL-15: unit leg mismatch"
            );
            lte(ghosts.unitsReclaimed[h[i]], ghosts.unitsBoughtCum[h[i]], "GL-15: reclaimed exceeds bought");
        }
    }

    /// @notice GL-16: cap table sums to 1000; token, payout split and zero hold none.
    function property_capTableSumsTo1000() public {
        eq(_sumUnits(), token.TOTAL_SUPPLY(), "GL-16: cap table != TOTAL_SUPPLY");
        eq(token.balanceOf(address(token), TOKEN_ID), 0, "GL-16: token holds units");
        eq(token.balanceOf(token.payoutSplit(), TOKEN_ID), 0, "GL-16: payout split holds units");
        eq(token.balanceOf(address(0), TOKEN_ID), 0, "GL-16: zero address holds units");
    }

    /// @notice GL-17: scaled percents are a faithful 1000x scaling and sum to 1e6.
    function property_scaledPercentsSumToScale() public {
        uint256 sum;
        address[] memory h = _unitHolders();
        for (uint256 i; i < h.length; i++) {
            uint256 scaled = token.balanceOf(h[i], TOKEN_ID) * token.SUPPLY_TO_PERCENTAGE();
            eq(uint256(token.scaledPercentBalanceOf(h[i])), scaled, "GL-17: scaled percent mismatch");
            sum += scaled;
        }
        eq(sum, token.PERCENTAGE_SCALE(), "GL-17: percents don't sum to scale");
    }

    /// @notice GL-18: publicUnitsSold never exceeds publicUnits nor unitsSold.
    function property_publicTrancheAccounting() public {
        lte(offering.publicUnitsSold(), offering.publicUnits(), "GL-18: publicUnitsSold exceeds cap");
        lte(offering.publicUnitsSold(), offering.unitsSold(), "GL-18: publicUnitsSold exceeds unitsSold");
    }

    /// @notice GL-19: while Funding, the escrow retains the unsold public tranche.
    /// @dev SHOULD-HOLD — buyPrivate reserves `publicUnits - publicUnitsSold`
    /// and setPublicUnits is bounded by deliverable supply.
    function property_publicTrancheStaysFillable() public {
        if (offering.state() != Offering.State.Funding) return;
        uint256 pu = offering.publicUnits();
        uint256 pus = offering.publicUnitsSold();
        if (pu > pus) gte(offering.remainingUnits(), pu - pus, "GL-19: public tranche not fillable");
    }

    // GL-20 (cap table never shrinks below two holders) is retired from the
    // campaign: the collapse is an accepted, documented state (`sweepFailedUnits`
    // NatSpec, contracts/docs/contracts.md) pinned by `test_repro_capTableCollapse`.

    /// @notice GL-21: the curve has no rounding surface — per-unit sum equals the
    /// bulk cost and the doubled closed form is exact.
    function property_costForHasNoRoundingSurface(uint256 soldSeed, uint256 unitsSeed) public {
        uint256 s = clampBetween(soldSeed, 0, 1_000_000);
        uint256 u = clampBetween(unitsSeed, 0, 300);
        uint256 sumOnes;
        for (uint256 i; i < u; i++) {
            sumOnes += offering.costFor(s + i, 1);
        }
        eq(sumOnes, offering.costFor(s, u), "GL-21: per-unit sum != bulk cost");
        eq(
            2 * offering.costFor(s, u),
            2 * u * PRICE_START + PRICE_SLOPE * (2 * s * u + u * (u - 1)),
            "GL-21: doubled closed form mismatch"
        );
    }

    /// @notice GL-22: no seam at any split point, at fuzzed and live positions.
    function property_costForSplitIdentity(uint256 sSeed, uint256 aSeed, uint256 bSeed) public {
        uint256 s = clampBetween(sSeed, 0, 1_000_000);
        uint256 a = clampBetween(aSeed, 0, 300);
        uint256 b = clampBetween(bSeed, 0, 300);
        eq(
            offering.costFor(s, a) + offering.costFor(s + a, b),
            offering.costFor(s, a + b),
            "GL-22: split identity (fuzzed)"
        );
        uint256 live = offering.unitsSold();
        eq(
            offering.costFor(live, a) + offering.costFor(live + a, b),
            offering.costFor(live, a + b),
            "GL-22: split identity (live)"
        );
    }

    /// @notice GL-23: cost is strictly increasing in units, marginal price and
    /// position step match the closed form, average never below priceStart.
    function property_costForMonotonicity(uint256 sSeed, uint256 uSeed) public {
        uint256 s = clampBetween(sSeed, 0, 1_000_000);
        uint256 u = clampBetween(uSeed, 1, 300);
        eq(offering.costFor(s, 1), PRICE_START + PRICE_SLOPE * s, "GL-23: marginal price");
        gt(offering.costFor(s, u + 1), offering.costFor(s, u), "GL-23: not strictly increasing in units");
        gte(offering.costFor(s, u), u * PRICE_START, "GL-23: average below priceStart");
        eq(offering.costFor(s + 1, u) - offering.costFor(s, u), PRICE_SLOPE * u, "GL-23: position step");
    }

    /// @notice GL-24: costFor(s,0) and quote(0) are zero without reverting.
    function property_costForZeroIsTotal(uint256 sSeed) public {
        uint256 s = clampBetween(sSeed, 0, type(uint128).max);
        eq(offering.costFor(s, 0), 0, "GL-24: costFor zero nonzero");
        eq(offering.quote(0), 0, "GL-24: quote zero nonzero");
    }

    /// @notice GL-25: while in range the curve stays inside the factory-validated
    /// envelope; a donated-unit escape past OFFERING_UNITS is recorded via the marker.
    function property_curveWithinFactoryEnvelope() public {
        uint256 sold = offering.unitsSold();
        uint256 full = offering.costFor(0, OFFERING_UNITS); // factory proved this fits uint256
        if (sold <= OFFERING_UNITS) {
            uint256 tail = offering.costFor(sold, uint256(OFFERING_UNITS) - sold);
            lte(tail, full, "GL-25: in-range curve escaped factory envelope");
        } else {
            t(ghosts.soldPastEscrow, "GL-25: sold past escrow without donation marker");
        }
    }

    /// @notice GL-26: every buy charges positive USDC; gross never below the floor.
    function property_buysChargePositiveUsdc() public {
        gte(ghosts.grossRaised, offering.unitsSold() * PRICE_START, "GL-26: gross below floor");
    }

    // GL-27 (property_flatCurveIsLinear): needs a second offering with
    // priceSlope == 0 — the primary fixture hardcodes slope 1000, so the flat
    // branch is unreachable until 7B adds factory_createSecondOffering. Left as
    // a TODO ([-] in PROPERTIES.md) rather than a brittle assertion here.

    /// @notice GL-28: unitsSold, withdrawn and publicUnitsSold never decrease.
    function property_saleCountersNonDecreasing() public {
        _glSaleCountersNonDecreasing();
    }

    /// @notice GL-29: minMet is a one-shot latch.
    function property_minMetIsALatch() public {
        _glMinMetLatch();
    }

    /// @notice GL-30: raised may only fall while Failed.
    function property_raisedFallsOnlyWhileFailed() public {
        _glRaisedFallsOnlyWhileFailed();
    }

    /// @notice GL-31: per-actor ledgers are monotone, falling only to zero while Failed.
    function property_actorLedgersMonotone() public {
        _glActorLedgersMonotone();
    }

    /// @notice GL-32: allocationConsumed only moves false->true; count never falls.
    function property_allocationConsumedMonotone() public {
        _glAllocationConsumedMonotone();
    }

    /// @notice GL-33: address slots transition legally.
    function property_addressSlotsTransitionLegally() public {
        _glAddressSlotsTransitionLegally();
    }

    /// @notice GL-34: terminal states freeze the sale.
    function property_terminalStatesFreezeTheSale() public {
        _glTerminalFreeze();
    }

    /// @notice GL-35: state transitions are legal, absorbing and mutually exclusive.
    function property_stateTransitionsAreLegal() public {
        _glStateTransitionsLegal();
    }

    /// @notice GL-36: a Failed offering's invariants (min unmet, past close, no
    /// withdrawal, escrow covers deposits).
    function property_failedStateInvariants() public {
        if (offering.state() != Offering.State.Failed) return;
        t(!offering.minMet(), "GL-36: Failed but minMet");
        t(block.timestamp > offering.closeDate(), "GL-36: Failed before closeDate");
        eq(offering.withdrawn(), 0, "GL-36: Failed with nonzero withdrawn");
        gte(usdc.balanceOf(address(offering)), _sumDeposits(), "GL-36: Failed escrow underwater");
    }

    /// @notice GL-37: a Closed offering holds no residual liability and no units.
    function property_closedStateInvariants() public {
        if (offering.state() != Offering.State.Closed) return;
        t(offering.minMet(), "GL-37: Closed but not minMet");
        eq(offering.withdrawn(), offering.raised(), "GL-37: Closed residual liability");
        eq(offering.remainingUnits(), 0, "GL-37: Closed still holds units");
    }

    /// @notice GL-38: any nonzero withdrawn implies minMet.
    function property_withdrawnImpliesMinMet() public {
        if (offering.withdrawn() > 0) t(offering.minMet(), "GL-38: withdrawn without minMet");
    }

    /// @notice GL-39: minMet is exactly equivalent to raised >= raiseMin.
    /// @dev EXPLORATORY — the reverse direction can be broken by a refund below the min.
    function property_minMetMatchesRaiseMin() public {
        t(offering.minMet() == (offering.raised() >= offering.raiseMin()), "GL-39: minMet != (raised>=raiseMin)");
    }

    /// @notice GL-40: minMet can only be tripped by actual buy proceeds.
    function property_minMetOnlyFromBuyProceeds() public {
        if (offering.minMet()) gte(ghosts.grossRaised, RAISE_MIN, "GL-40: minMet without buy proceeds");
    }

    /// @notice GL-41: deposits and unitsBought pair, deposit >= one base unit per unit.
    function property_depositsPairWithUnitsBought() public {
        address[] memory h = _unitHolders();
        for (uint256 i; i < h.length; i++) {
            uint256 d = offering.deposits(h[i]);
            uint256 ub = offering.unitsBought(h[i]);
            t((d > 0) == (ub > 0), "GL-41: deposits/unitsBought pairing broken");
            if (ub > 0) gte(d, ub, "GL-41: deposit below one base unit per unit");
        }
    }

    /// @notice GL-42: private claims never exceed the consumed ids, nor eight.
    function property_privateClaimsBoundedByAllocations() public {
        uint256 consumed;
        for (uint256 i; i < 8; i++) {
            if (offering.allocationConsumed(_fizzAllocationId(uint8(i)))) consumed++;
        }
        lte(ghosts.privateBuyCount, consumed, "GL-42: private buys exceed consumed ids");
        lte(ghosts.privateBuyCount, 8, "GL-42: private buys exceed eight");
    }

    /// @notice GL-43: the offering is a universal permanent operator; every other
    /// operator's approval mirrors the owner's last setApprovalForAll.
    function property_operatorApprovalSemantics() public {
        address[] memory h = _unitHolders();
        for (uint256 i; i < h.length; i++) {
            t(token.isApprovedForAll(h[i], address(offering)), "GL-43: offering not universal operator");
            for (uint256 j; j < actors.length; j++) {
                address op = actors[j];
                if (op == address(offering)) continue;
                t(
                    token.isApprovedForAll(h[i], op) == ghosts.approvedGhost[h[i]][op],
                    "GL-43: operator approval mismatch"
                );
            }
        }
    }

    /// @notice GL-44: uri(0) never reverts and returns a base64 JSON data payload.
    function property_uriIsAlwaysRenderable() public {
        bytes memory bs = bytes(token.uri(0));
        bytes memory prefix = bytes("data:application/json;base64,");
        gt(bs.length, prefix.length, "GL-44: uri empty or too short");
        bool ok = true;
        for (uint256 i; i < prefix.length; i++) {
            if (bs[i] != prefix[i]) {
                ok = false;
                break;
            }
        }
        t(ok, "GL-44: uri missing data:application/json;base64, prefix");
    }

    // ――――――――――――――――――― Specific properties ――――――――――――――――――――
    // These properties must hold after specific function calls.
    // They MUST BE INTERNAL and called at the end of the relevant handlers.
    // Every one reads the stateBefore/stateAfter snapshots (or handler locals)
    // captured around the external call in its handler.

    /// @notice SP-01: a buy charges exactly costFor(unitsSold_before, units) and
    /// all eight ledger legs move together by cost / units.
    function property_buySettlesOnCurveAndConserves(uint256 unitsWanted, uint256 cost, uint256 maxCost) internal {
        eq(cost, offering.costFor(stateBefore.unitsSold, unitsWanted), "SP-01: cost off the curve");
        lte(cost, maxCost, "SP-01: cost exceeds maxCost");
        eq(stateAfter.actorDeposits - stateBefore.actorDeposits, cost, "SP-01: deposits delta != cost");
        eq(stateAfter.raised - stateBefore.raised, cost, "SP-01: raised delta != cost");
        eq(stateAfter.escrowUsdc - stateBefore.escrowUsdc, cost, "SP-01: escrow USDC delta != cost");
        eq(stateBefore.actorUsdc - stateAfter.actorUsdc, cost, "SP-01: buyer USDC delta != cost");
        eq(stateAfter.actorUnitsBought - stateBefore.actorUnitsBought, unitsWanted, "SP-01: unitsBought delta != units");
        eq(stateAfter.unitsSold - stateBefore.unitsSold, unitsWanted, "SP-01: unitsSold delta != units");
        eq(stateAfter.actorUnits - stateBefore.actorUnits, unitsWanted, "SP-01: buyer units delta != units");
        eq(stateBefore.escrowUnits - stateAfter.escrowUnits, unitsWanted, "SP-01: escrow units delta != units");
    }

    /// @notice SP-02: a successful buy was gated on Funding and (still open or
    /// already minMet) as observed BEFORE the call.
    function property_buyGatingHeld() internal {
        eq(uint256(stateBefore.state), uint256(Offering.State.Funding), "SP-02: buy not from Funding");
        t(stateBefore.timestamp <= offering.closeDate() || stateBefore.minMet, "SP-02: buy past close without minMet");
    }

    /// @notice SP-03: a buy moves only the caller's ledgers; no other address's
    /// deposits/unitsBought, nor withdrawn, nor state, changes.
    function property_buyTouchesOnlyCaller() internal {
        eq(
            stateAfter.sumDeposits - stateBefore.sumDeposits,
            stateAfter.actorDeposits - stateBefore.actorDeposits,
            "SP-03: a non-caller deposit moved"
        );
        eq(
            stateAfter.sumUnitsBought - stateBefore.sumUnitsBought,
            stateAfter.actorUnitsBought - stateBefore.actorUnitsBought,
            "SP-03: a non-caller unitsBought moved"
        );
        eq(stateAfter.withdrawn, stateBefore.withdrawn, "SP-03: withdrawn changed on buy");
        eq(uint256(stateAfter.state), uint256(stateBefore.state), "SP-03: state changed on buy");
    }

    /// @notice SP-04: buyPrivate consumes its id exactly once, never after
    /// cancel, keeps the USDC outflow within the cap, and leaves the public
    /// tranche untouched.
    function property_privateClaimSettlesOnce(bytes32 id, uint256 cap) internal {
        t(offering.allocationConsumed(id), "SP-04: allocation not consumed after claim");
        lte(ghosts.allocationClaims[id], 1, "SP-04: id settled more than once");
        t(!ghosts.allocationCancelled[id], "SP-04: claim settled on a cancelled id");
        lte(stateBefore.actorUsdc - stateAfter.actorUsdc, cap, "SP-04: USDC outflow exceeds cap");
        eq(stateAfter.publicUnits, stateBefore.publicUnits, "SP-04: publicUnits touched by private buy");
        eq(stateAfter.publicUnitsSold, stateBefore.publicUnitsSold, "SP-04: publicUnitsSold touched by private buy");
    }

    /// @notice SP-05: a voucher signed by a former owner reverts on claim.
    function property_staleOwnerVoucherRejected(bool reverted) internal {
        t(reverted, "SP-05: stale-owner voucher accepted");
    }

    /// @notice SP-06: a claim signature bound to buyer A is unusable by buyer B.
    function property_claimSignatureIsBuyerBound(bool reverted) internal {
        t(reverted, "SP-06: claim signature reused by a different buyer");
    }

    /// @notice SP-07: a receiver callback cannot re-enter the Offering.
    function property_receiverCallbackCannotReenter(bool reverted) internal {
        t(reverted, "SP-07: reentrant buy from receiver callback succeeded");
    }

    /// @notice SP-08: a successful refund is an exact inverse — pays the recorded
    /// deposit, reclaims the recorded units, zeroes both ledgers, and touches
    /// nothing else. Requires Failed.
    function property_refundIsExactInverse() internal {
        eq(uint256(stateBefore.state), uint256(Offering.State.Failed), "SP-08: refund not from Failed");
        eq(stateAfter.actorUsdc - stateBefore.actorUsdc, stateBefore.actorDeposits, "SP-08: payout != recorded deposit");
        eq(stateAfter.actorDeposits, 0, "SP-08: deposits not zeroed");
        eq(stateAfter.actorUnitsBought, 0, "SP-08: unitsBought not zeroed");
        eq(stateBefore.raised - stateAfter.raised, stateBefore.actorDeposits, "SP-08: raised delta != deposit");
        eq(
            stateAfter.escrowUnits - stateBefore.escrowUnits,
            stateBefore.actorUnitsBought,
            "SP-08: escrow units delta != reclaimed"
        );
        eq(stateAfter.unitsSold, stateBefore.unitsSold, "SP-08: unitsSold rewound on refund");
        eq(stateAfter.publicUnitsSold, stateBefore.publicUnitsSold, "SP-08: publicUnitsSold changed on refund");
        eq(stateAfter.withdrawn, stateBefore.withdrawn, "SP-08: withdrawn changed on refund");
        t(stateAfter.minMet == stateBefore.minMet, "SP-08: minMet changed on refund");
        eq(uint256(stateAfter.state), uint256(stateBefore.state), "SP-08: state changed on refund");
        eq(
            stateBefore.sumDeposits - stateAfter.sumDeposits,
            stateBefore.actorDeposits,
            "SP-08: a non-caller deposit moved on refund"
        );
    }

    /// @notice SP-10: a refunded buyer cannot re-enter the curve at their old
    /// price — re-buying the reclaimed units never costs less, and costs strictly
    /// more once the position advanced under a nonzero slope.
    function property_curveNeverRewindsOnRefund() internal {
        uint256 u = stateBefore.actorUnitsBought;
        if (u == 0) return;
        uint256 rebuyNow = offering.costFor(offering.unitsSold(), u);
        uint256 rebuyThen = offering.costFor(ghosts.lastBuyPosition[actor], u);
        gte(rebuyNow, rebuyThen, "SP-10: curve rewound - rebuy cheaper than original position");
        if (PRICE_SLOPE > 0 && offering.unitsSold() > ghosts.lastBuyPosition[actor]) {
            gt(rebuyNow, rebuyThen, "SP-10: no price penalty despite an advanced position");
        }
    }

    /// @notice SP-09: an eligible buyer's refund can never be made to revert.
    function property_refundLiveness(bool expectSuccess, bool success) internal {
        if (expectSuccess) t(success, "SP-09: an eligible refund reverted");
    }

    /// @notice SP-11: a buy -> markFailed -> refund cycle fully unwinds the
    /// actor's position. A failed raise refunds every deposit and reclaims every
    /// purchased unit, so the actor ends with all their USDC back (their whole
    /// pre-cycle deposit ledger, plus this cycle's cost) and with their prior
    /// unit position surrendered — refund clears the entire `unitsBought` ledger,
    /// not just the one unit bought in this cycle.
    function property_buyFailRefundIsValueNeutral(
        uint256 usdcStart,
        uint256 depStart,
        uint256 unitsStart,
        uint256 unitsBoughtBefore,
        uint256 usdcEnd,
        uint256 unitsEnd
    ) internal {
        eq(usdcEnd, usdcStart + depStart, "SP-11: round trip did not return every deposit");
        eq(unitsEnd, unitsStart - unitsBoughtBefore, "SP-11: round trip did not unwind the unit position");
    }

    /// @notice SP-12: refund eligibility is a balance test, not provenance — a
    /// buyer who reacquires the same number of units can still refund in full.
    function property_refundEligibilityIsBalanceBased(bool success) internal {
        t(success, "SP-12: refund denied after reacquiring the same unit count");
    }

    /// @notice SP-13: refundAll is atomic per buyer — each buyer is fully cleared
    /// AND paid, or left entirely untouched.
    function property_refundAllIsAtomicPerBuyer(
        address[] memory buyers,
        uint256[] memory depBefore,
        uint256[] memory ubBefore,
        uint256[] memory usdcBefore
    ) internal {
        for (uint256 i; i < buyers.length; i++) {
            address b = buyers[i];
            uint256 depNow = offering.deposits(b);
            uint256 ubNow = offering.unitsBought(b);
            uint256 paid = usdc.balanceOf(b) - usdcBefore[i];
            bool cleared = depNow == 0 && depBefore[i] > 0;
            if (cleared) {
                eq(paid, depBefore[i], "SP-13: cleared buyer paid != deposit");
                eq(ubNow, 0, "SP-13: cleared deposit but unitsBought remains");
            } else {
                eq(depNow, depBefore[i], "SP-13: deposit partially changed");
                eq(ubNow, ubBefore[i], "SP-13: unitsBought changed without full clear");
                eq(paid, 0, "SP-13: untouched buyer still paid");
            }
        }
        eq(uint256(stateAfter.unitsSold), uint256(stateBefore.unitsSold), "SP-13: unitsSold changed");
        eq(stateAfter.withdrawn, stateBefore.withdrawn, "SP-13: withdrawn changed");
        t(stateAfter.minMet == stateBefore.minMet, "SP-13: minMet changed");
        eq(uint256(stateAfter.state), uint256(stateBefore.state), "SP-13: state changed");
    }

    /// @notice SP-14: withdraw requires minMet, drains the whole liability to the
    /// treasury and nowhere else, and leaves raised untouched.
    function property_withdrawPaysTreasuryExactly() internal {
        t(stateBefore.minMet, "SP-14: withdraw without minMet");
        eq(stateAfter.withdrawn, stateAfter.raised, "SP-14: withdrawn != raised after");
        eq(stateAfter.raised, stateBefore.raised, "SP-14: raised moved on withdraw");
        uint256 d = stateAfter.withdrawn - stateBefore.withdrawn;
        eq(stateAfter.treasuryUsdc - stateBefore.treasuryUsdc, d, "SP-14: treasury credit != withdrawal");
        eq(stateBefore.escrowUsdc - stateAfter.escrowUsdc, d, "SP-14: escrow debit != withdrawal");
        eq(uint256(stateAfter.state), uint256(stateBefore.state), "SP-14: state changed on withdraw");
    }

    /// @notice SP-15: a donation can never brick a permissionless withdraw while
    /// there is liability, minMet holds, and the treasury is not blocklisted.
    function property_withdrawLiveness(bool expectSuccess, bool success) internal {
        if (expectSuccess) t(success, "SP-15: a due withdraw reverted");
    }

    /// @notice SP-16: closeAndWithdraw needs minMet+Funding and ends Closed with
    /// no residual liability and no units.
    function property_closeSettlesAndSweeps() internal {
        t(stateBefore.minMet, "SP-16: close without minMet");
        eq(uint256(stateBefore.state), uint256(Offering.State.Funding), "SP-16: close not from Funding");
        eq(uint256(stateAfter.state), uint256(Offering.State.Closed), "SP-16: not Closed after");
        eq(stateAfter.withdrawn, stateAfter.raised, "SP-16: residual liability after close");
        eq(stateAfter.raised, stateBefore.raised, "SP-16: raised moved on close");
        eq(stateAfter.escrowUnits, 0, "SP-16: escrow still holds units after close");
    }

    /// @notice SP-18: sweep/close move the whole escrow unit balance to treasury.
    /// `requireFailed` and `checkAccounting` are true for sweep, false for close.
    function property_unitSweepConserves(bool requireFailed, bool checkAccounting) internal {
        if (requireFailed) {
            eq(uint256(stateBefore.state), uint256(Offering.State.Failed), "SP-18: sweep not from Failed");
        }
        uint256 moved = stateBefore.escrowUnits;
        eq(stateAfter.escrowUnits, 0, "SP-18: escrow units not fully swept");
        eq(stateAfter.treasuryUnits - stateBefore.treasuryUnits, moved, "SP-18: treasury units delta != swept");
        if (checkAccounting) {
            eq(stateAfter.raised, stateBefore.raised, "SP-18: sweep moved raised");
            eq(stateAfter.withdrawn, stateBefore.withdrawn, "SP-18: sweep moved withdrawn");
            eq(uint256(stateAfter.unitsSold), uint256(stateBefore.unitsSold), "SP-18: sweep moved unitsSold");
        }
    }

    /// @notice SP-19: markFailed flips Funding->Failed and touches nothing else.
    function property_markFailedOnlyFlipsState() internal {
        eq(uint256(stateBefore.state), uint256(Offering.State.Funding), "SP-19: markFailed not from Funding");
        eq(uint256(stateAfter.state), uint256(Offering.State.Failed), "SP-19: not Failed after");
        eq(stateAfter.raised, stateBefore.raised, "SP-19: raised changed");
        eq(stateAfter.withdrawn, stateBefore.withdrawn, "SP-19: withdrawn changed");
        eq(uint256(stateAfter.unitsSold), uint256(stateBefore.unitsSold), "SP-19: unitsSold changed");
        eq(stateAfter.publicUnitsSold, stateBefore.publicUnitsSold, "SP-19: publicUnitsSold changed");
        t(stateAfter.minMet == stateBefore.minMet, "SP-19: minMet changed");
        eq(stateAfter.escrowUnits, stateBefore.escrowUnits, "SP-19: escrow units changed");
        eq(stateAfter.sumDeposits, stateBefore.sumDeposits, "SP-19: deposits changed");
        eq(stateAfter.sumUnitsBought, stateBefore.sumUnitsBought, "SP-19: unitsBought changed");
    }

    /// @notice SP-20: markFailed must succeed for anyone once close has passed
    /// with the minimum unmet.
    function property_markFailedLiveness(bool expectSuccess, bool success) internal {
        if (expectSuccess) t(success, "SP-20: a due markFailed reverted");
    }

    /// @notice SP-21: skim leaves the escrow holding exactly the liability and
    /// credits the treasury the surplus, moving neither raised nor withdrawn.
    function property_skimLeavesExactlyLiability() internal {
        eq(stateAfter.escrowUsdc, stateAfter.raised - stateAfter.withdrawn, "SP-21: escrow != liability after skim");
        uint256 removed = stateBefore.escrowUsdc - stateAfter.escrowUsdc;
        eq(stateAfter.treasuryUsdc - stateBefore.treasuryUsdc, removed, "SP-21: treasury credit != surplus removed");
        eq(stateAfter.raised, stateBefore.raised, "SP-21: skim moved raised");
        eq(stateAfter.withdrawn, stateBefore.withdrawn, "SP-21: skim moved withdrawn");
    }

    /// @notice SP-22: rescue moves the whole stray balance to the recipient and
    /// touches neither USDC nor the cap table.
    function property_rescueIsConfinedToStrayTokens(
        address recipient,
        uint256 recipStrayBefore,
        uint256 escrowStrayBefore
    ) internal {
        eq(strayToken.balanceOf(address(offering)), 0, "SP-22: escrow stray not emptied");
        eq(
            strayToken.balanceOf(recipient) - recipStrayBefore,
            escrowStrayBefore,
            "SP-22: recipient stray delta mismatch"
        );
        eq(stateAfter.escrowUsdc, stateBefore.escrowUsdc, "SP-22: rescue moved USDC");
        eq(stateAfter.escrowUnits, stateBefore.escrowUnits, "SP-22: rescue moved cap-table units");
    }

    /// @notice SP-22 negative legs: rescuing USDC or the PactToken reverts.
    function property_rescueForbiddenReverts(bool reverted) internal {
        t(reverted, "SP-22: rescue of a protected token succeeded");
    }

    /// @notice SP-23: config/admin calls leave the state machine and the sale
    /// ledger (raised/unitsSold/publicUnitsSold/withdrawn) untouched.
    function property_nonTransitionCallsLeaveStateAndLedger() internal {
        eq(uint256(stateAfter.state), uint256(stateBefore.state), "SP-23: config call changed state");
        eq(stateAfter.raised, stateBefore.raised, "SP-23: config call changed raised");
        eq(uint256(stateAfter.unitsSold), uint256(stateBefore.unitsSold), "SP-23: config call changed unitsSold");
        eq(stateAfter.publicUnitsSold, stateBefore.publicUnitsSold, "SP-23: config call changed publicUnitsSold");
        eq(stateAfter.withdrawn, stateBefore.withdrawn, "SP-23: config call changed withdrawn");
    }

    /// @notice SP-24: cancelAllocation marks the id consumed and nothing else.
    function property_cancelAllocationOnlyConsumes(bytes32 id) internal {
        t(offering.allocationConsumed(id), "SP-24: allocation not consumed after cancel");
        property_nonTransitionCallsLeaveStateAndLedger();
    }

    /// @notice SP-25a: transferOwnership stakes pendingOwner and leaves owner.
    function property_ownershipTransferPostconditions(address newOwner) internal {
        t(stateAfter.owner == stateBefore.owner, "SP-25: owner changed on transfer");
        t(stateAfter.pendingOwner == newOwner, "SP-25: pendingOwner not staked");
        property_nonTransitionCallsLeaveStateAndLedger();
    }

    /// @notice SP-25b: acceptOwnership moves owner to the prior pendingOwner and
    /// clears it, touching no accounting.
    function property_ownershipAcceptPostconditions() internal {
        t(stateAfter.owner == stateBefore.pendingOwner, "SP-25: owner != prior pendingOwner");
        t(stateAfter.pendingOwner == address(0), "SP-25: pendingOwner not cleared");
        property_nonTransitionCallsLeaveStateAndLedger();
    }

    /// @notice SP-26: a cancelled allocation stays dead through ownership
    /// rotations. (The exploratory voucher-revival leg — a merely mass-revoked
    /// link becoming spendable again on A->B->A — is left to the fuzzer's own
    /// buyPrivate replays rather than asserted here.)
    function property_ownershipRoundTripKeepsCancelledDead() internal {
        for (uint256 i; i < 8; i++) {
            bytes32 id = _fizzAllocationId(uint8(i));
            if (ghosts.allocationCancelled[id]) {
                t(offering.allocationConsumed(id), "SP-26: cancelled allocation revived by rotation");
            }
        }
    }

    /// @notice SP-27: every onlyOwner entry point (and acceptOwnership from a
    /// non-pending address) reverts for an arbitrary non-owner.
    function property_onlyOwnerGatesHold(bool reverted) internal {
        t(reverted, "SP-27: an owner-gated call was reachable by a non-owner");
    }

    /// @notice SP-28: a payment-token blocklist destroys no value — a blocked
    /// buyer's recorded deposit never shrinks while they stay blocked.
    function property_blocklistDestroysNoValue() internal {
        address[] memory h = _unitHolders();
        for (uint256 i; i < h.length; i++) {
            if (usdc.blocked(h[i]) && ghosts.blockedDeposit[h[i]] > 0) {
                gte(
                    offering.deposits(h[i]), ghosts.blockedDeposit[h[i]], "SP-28: blocked buyer's deposit was destroyed"
                );
            }
        }
    }

    /// @notice SP-29: outside Funding, distributeFunds over the complete
    /// nonzero-holder set never reverts.
    function property_distributeFundsNeverReverts(bool success) internal {
        t(success, "SP-29: distributeFunds reverted with the full holder set");
    }

    /// @notice SP-35: distributeFunds always reverts while the offering is
    /// Funding (the anti-capture gate, audit Finding 2).
    function property_distributeFundsGatedWhileFunding(bool success) internal {
        t(!success, "SP-35: distributeFunds succeeded while Funding");
    }

    /// @notice SP-30: an ETH distribution empties the token and lands the balance
    /// in the payout split.
    function property_ethDistributionReachesPayoutSplit() internal {
        eq(address(token).balance, 0, "SP-30: token still holds ETH after distribute");
        eq(
            stateAfter.payoutSplitEth - stateBefore.payoutSplitEth,
            stateBefore.tokenEth,
            "SP-30: ETH did not reach the payout split"
        );
    }

    /// @notice SP-31: a transfer moves exactly `amount` from sender to recipient
    /// and touches no third party (self-transfers are balance-preserving).
    function property_unitTransferMovesExactly(
        address from,
        address to,
        uint256 amount,
        uint256 fromBefore,
        uint256 toBefore
    ) internal {
        if (from == to) {
            eq(token.balanceOf(from, TOKEN_ID), fromBefore, "SP-31: self-transfer changed the balance");
        } else {
            eq(fromBefore - token.balanceOf(from, TOKEN_ID), amount, "SP-31: sender debit != amount");
            eq(token.balanceOf(to, TOKEN_ID) - toBefore, amount, "SP-31: recipient credit != amount");
        }
    }

    /// @notice SP-32: an unauthorized caller cannot move another account's units.
    function property_unauthorizedTransferReverts(bool reverted) internal {
        t(reverted, "SP-32: an unauthorized transfer succeeded");
    }

    /// @notice SP-33: self-transfers and zero-amount transfers change nothing.
    function property_noopTransfersChangeNothing(
        address to,
        uint256 senderBefore,
        uint256 senderAfter,
        uint256 recipientBefore,
        uint256 recipientAfter
    ) internal {
        eq(senderAfter, senderBefore, "SP-33: a no-op transfer moved the sender");
        eq(recipientAfter, recipientBefore, "SP-33: a no-op transfer moved the recipient");
    }

    /// @notice SP-34: transfers to the zero address or above balance revert.
    function property_invalidTransferReverts(bool reverted) internal {
        t(reverted, "SP-34: an invalid transfer succeeded");
    }
}
