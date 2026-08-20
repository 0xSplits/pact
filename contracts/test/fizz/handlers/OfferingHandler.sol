// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";
import {ReenterOnReceive} from "../../Mocks.sol";

/// @notice Handles the interaction with Offering
abstract contract OfferingHandler is Properties {
    // Lazily-deployed attacker whose receive hook re-enters buyPublic (SP-07).
    ReenterOnReceive internal reenterAttacker;

    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    function offering_buyPublic_clamped(uint256 unitsWanted) public {
        uint256 supply = offering.remainingUnits();
        uint256 publicLeft = offering.publicUnits() - offering.publicUnitsSold();
        uint256 max = supply < publicLeft ? supply : publicLeft;
        if (max == 0) return;
        unitsWanted = clampBetween(unitsWanted, 1, max);
        offering_buyPublic(unitsWanted, offering.quote(unitsWanted), "");
    }

    /// Full-amount stress: buys the entire currently available public tranche.
    function offering_buyPublic_full() public {
        uint256 supply = offering.remainingUnits();
        uint256 publicLeft = offering.publicUnits() - offering.publicUnitsSold();
        uint256 max = supply < publicLeft ? supply : publicLeft;
        if (max == 0) return;
        offering_buyPublic(max, offering.quote(max), "");
    }

    function offering_buyPrivate_clamped(uint8 idSeed, uint256 unitsWanted) public {
        uint256 supply = offering.remainingUnits();
        uint256 reserved = offering.publicUnits() - offering.publicUnitsSold();
        uint256 unreserved = supply > reserved ? supply - reserved : 0;
        if (unreserved == 0) return;
        unitsWanted = clampBetween(unitsWanted, 1, unreserved);
        uint256 cost = offering.quote(unitsWanted);
        offering_buyPrivate(idSeed, unitsWanted, cost, cost);
    }

    /// Simulates SplitMain's permissionless withdraw pushing split revenue
    /// USDC into the escrow — the surplus sweepExcessUsdc exists to recover.
    function offering_donateUsdc_clamped(uint256 amount) public {
        amount = clampBetween(amount, 1, 1_000_000e6);
        snapshotBefore();
        usdc.mint(address(offering), amount);
        snapshotAfter();
        ghosts.usdcMinted += amount;
        ghosts.usdcDonated += amount;
        property_nonTransitionCallsLeaveStateAndLedger();
        _syncMonotonicGhosts();
    }

    function offering_secondary(uint8 selector, uint256 arg0, address arg1) public {
        selector = uint8(selector % 9);
        if (selector == 0) _offering_closeAndWithdraw();
        else if (selector == 1) _offering_refundAll();
        else if (selector == 2) _offering_cancelAllocation(uint8(arg0));
        else if (selector == 3) _offering_setPublicUnits(arg0);
        else if (selector == 4) _offering_setTreasury(arg1);
        else if (selector == 5) _offering_sweepExcessUsdc();
        else if (selector == 6) _offering_rescue(arg1);
        else if (selector == 7) _offering_requestHandover();
        else _offering_completeHandover();
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function offering_buyPublic(uint256 unitsWanted, uint256 maxCost, string memory buyerName) public asActor {
        snapshotBefore();
        uint256 cost = offering.buyPublic(unitsWanted, maxCost, buyerName);
        snapshotAfter();

        ghosts.usdcPaid[actor] += cost;
        ghosts.unitsBoughtCum[actor] += unitsWanted;
        ghosts.grossRaised += cost;
        ghosts.lastBuyPosition[actor] = stateBefore.unitsSold;

        property_buySettlesOnCurveAndConserves(unitsWanted, cost, maxCost);
        property_buyGatingHeld();
        property_buyTouchesOnlyCaller();
        _syncMonotonicGhosts();
    }

    /// Signature construction is setup, not fuzz input: raw fuzzed sig bytes
    /// never recover to the owner, so this layer signs a real voucher (live
    /// owner key + link key over the acting buyer) and leaves units, maxCost,
    /// and the allocation cap unrestricted.
    function offering_buyPrivate(uint8 idSeed, uint256 unitsWanted, uint256 maxCost, uint256 cap) public asActor {
        (Offering.Voucher memory voucher, bytes memory ownerSig, bytes memory claimSig) = _buildVoucher(idSeed, cap);

        snapshotBefore();
        uint256 cost = offering.buyPrivate(voucher, ownerSig, claimSig, unitsWanted, maxCost);
        snapshotAfter();

        ghosts.usdcPaid[actor] += cost;
        ghosts.unitsBoughtCum[actor] += unitsWanted;
        ghosts.grossRaised += cost;
        ghosts.privateUnitsSold += unitsWanted;
        ghosts.privateBuyCount += 1;
        ghosts.allocationClaims[voucher.allocationId] += 1;
        ghosts.lastBuyPosition[actor] = stateBefore.unitsSold;

        property_buySettlesOnCurveAndConserves(unitsWanted, cost, maxCost);
        property_buyGatingHeld();
        property_buyTouchesOnlyCaller();
        property_privateClaimSettlesOnce(voucher.allocationId, voucher.amountCapUsdc);
        _syncMonotonicGhosts();
    }

    function offering_refund() public {
        bool expectSuccess = offering.state() == Offering.State.Failed && offering.deposits(actor) > 0
            && token.balanceOf(actor, TOKEN_ID) >= offering.unitsBought(actor) && !usdc.blocked(actor);

        snapshotBefore();
        vm.prank(actor);
        try offering.refund() {
            snapshotAfter();
            uint256 paid = stateAfter.actorUsdc - stateBefore.actorUsdc;
            uint256 reclaimed = stateAfter.escrowUnits - stateBefore.escrowUnits;
            ghosts.usdcRefunded[actor] += paid;
            ghosts.usdcRefundedTotal += paid;
            ghosts.unitsReclaimed[actor] += reclaimed;
            ghosts.unitsReclaimedTotal += reclaimed;
            property_refundIsExactInverse();
            property_curveNeverRewindsOnRefund();
            property_refundLiveness(expectSuccess, true);
        } catch {
            property_refundLiveness(expectSuccess, false);
        }
        _syncMonotonicGhosts();
    }

    function offering_withdraw() public {
        bool expectSuccess =
            offering.minMet() && offering.raised() > offering.withdrawn() && !usdc.blocked(offering.treasury());

        snapshotBefore();
        vm.prank(actor);
        try offering.withdraw() returns (uint256 amount) {
            snapshotAfter();
            ghosts.withdrawPaid += amount;
            property_withdrawPaysTreasuryExactly();
            property_withdrawLiveness(expectSuccess, true);
        } catch {
            property_withdrawLiveness(expectSuccess, false);
        }
        _syncMonotonicGhosts();
    }

    function offering_markFailed() public {
        bool expectSuccess =
            offering.state() == Offering.State.Funding && block.timestamp > offering.closeDate() && !offering.minMet();

        snapshotBefore();
        vm.prank(actor);
        try offering.markFailed() {
            snapshotAfter();
            property_markFailedOnlyFlipsState();
            property_markFailedLiveness(expectSuccess, true);
        } catch {
            property_markFailedLiveness(expectSuccess, false);
        }
        _syncMonotonicGhosts();
    }

    function offering_sweepFailedUnits() public {
        snapshotBefore();
        vm.prank(actor);
        try offering.sweepFailedUnits() returns (uint256 units) {
            snapshotAfter();
            ghosts.unitsSwept += units;
            property_unitSweepConserves(true, true);
        } catch {}
        _syncMonotonicGhosts();
    }

    function _offering_closeAndWithdraw() internal {
        uint256 withdrawnBefore = offering.withdrawn();
        uint256 escrowUnitsBefore = token.balanceOf(address(offering), TOKEN_ID);

        snapshotBefore();
        vm.prank(admin);
        try offering.closeAndWithdraw() {
            snapshotAfter();
            ghosts.withdrawPaid += offering.withdrawn() - withdrawnBefore;
            ghosts.unitsSwept += escrowUnitsBefore;
            property_closeSettlesAndSweeps();
            property_unitSweepConserves(false, false);
        } catch {}
        _syncMonotonicGhosts();
    }

    function _offering_refundAll() internal {
        address[] memory buyers = new address[](actors.length);
        uint256[] memory depBefore = new uint256[](actors.length);
        uint256[] memory ubBefore = new uint256[](actors.length);
        uint256[] memory usdcBefore = new uint256[](actors.length);
        for (uint256 i; i < actors.length; i++) {
            buyers[i] = actors[i];
            depBefore[i] = offering.deposits(actors[i]);
            ubBefore[i] = offering.unitsBought(actors[i]);
            usdcBefore[i] = usdc.balanceOf(actors[i]);
        }

        snapshotBefore();
        vm.prank(admin);
        try offering.refundAll(buyers) {
            snapshotAfter();
            for (uint256 i; i < buyers.length; i++) {
                if (offering.deposits(buyers[i]) == 0 && depBefore[i] > 0) {
                    uint256 paid = usdc.balanceOf(buyers[i]) - usdcBefore[i];
                    ghosts.usdcRefunded[buyers[i]] += paid;
                    ghosts.usdcRefundedTotal += paid;
                    ghosts.unitsReclaimed[buyers[i]] += ubBefore[i];
                    ghosts.unitsReclaimedTotal += ubBefore[i];
                }
            }
            property_refundAllIsAtomicPerBuyer(buyers, depBefore, ubBefore, usdcBefore);
            property_curveNeverRewindsOnRefund();
        } catch {}
        _syncMonotonicGhosts();
    }

    function _offering_cancelAllocation(uint8 idSeed) internal {
        bytes32 id = _allocationId(idSeed);
        snapshotBefore();
        vm.prank(admin);
        try offering.cancelAllocation(id) {
            snapshotAfter();
            ghosts.allocationCancelled[id] = true;
            property_cancelAllocationOnlyConsumes(id);
        } catch {}
        _syncMonotonicGhosts();
    }

    // Deliberately probes past the deliverable supply (up to 1200) — the
    // setter's upper bound (`remainingUnits() + publicUnitsSold`) should
    // reject those, which the try/catch tolerates.
    function _offering_setPublicUnits(uint256 publicUnits_) internal {
        snapshotBefore();
        vm.prank(admin);
        try offering.setPublicUnits(clampBetween(publicUnits_, offering.publicUnitsSold(), 1200)) {
            snapshotAfter();
            property_nonTransitionCallsLeaveStateAndLedger();
        } catch {}
        _syncMonotonicGhosts();
    }

    function _offering_setTreasury(address seed) internal {
        snapshotBefore();
        vm.prank(admin);
        try offering.setTreasury(toActor(seed)) {
            snapshotAfter();
            property_nonTransitionCallsLeaveStateAndLedger();
        } catch {}
        _syncMonotonicGhosts();
    }

    function _offering_sweepExcessUsdc() internal {
        snapshotBefore();
        vm.prank(admin);
        try offering.sweepExcessUsdc() returns (uint256 amount) {
            snapshotAfter();
            ghosts.usdcSkimmed += amount;
            property_skimLeavesExactlyLiability();
            property_nonTransitionCallsLeaveStateAndLedger();
        } catch {}
        _syncMonotonicGhosts();
    }

    function _offering_rescue(address seed) internal {
        address recipient = toActor(seed);
        uint256 recipStrayBefore = strayToken.balanceOf(recipient);
        uint256 escrowStrayBefore = strayToken.balanceOf(address(offering));

        snapshotBefore();
        vm.prank(admin);
        try offering.rescue(address(strayToken), recipient) {
            snapshotAfter();
            property_rescueIsConfinedToStrayTokens(recipient, recipStrayBefore, escrowStrayBefore);
            property_nonTransitionCallsLeaveStateAndLedger();
        } catch {}
        _syncMonotonicGhosts();
    }

    // Ownership rotates between two known keys so voucher signing (live owner)
    // and asAdmin never lose track of the owner seat.
    function _offering_requestHandover() internal {
        uint256 targetKey = ownerKey == OWNER_KEY ? OWNER_KEY_B : OWNER_KEY;
        address newOwner = vm.addr(targetKey);
        snapshotBefore();
        vm.prank(newOwner);
        try offering.requestOwnershipHandover() {
            snapshotAfter();
            property_ownershipTransferPostconditions(newOwner);
        } catch {}
        _syncMonotonicGhosts();
    }

    function _offering_completeHandover() internal {
        address pending = _handoverPending();
        if (pending == address(0)) return;
        snapshotBefore();
        vm.prank(admin);
        try offering.completeOwnershipHandover(pending) {
            snapshotAfter();
            ownerKey = pending == vm.addr(OWNER_KEY) ? OWNER_KEY : OWNER_KEY_B;
            admin = pending;
            property_ownershipAcceptPostconditions();
            property_ownershipRoundTripKeepsCancelledDead();
        } catch {}
        _syncMonotonicGhosts();
    }

    // ―――――――――――――――――――――― New handlers ――――――――――――――――――――――――

    /// SP-11: the only round trip the state machine admits — buy under minMet,
    /// warp past closeDate, markFailed, refund — must be value-neutral. Skips
    /// when the buy would trip minMet (then markFailed is impossible) or the
    /// offering is already terminal.
    function offering_roundTrip_buyFailRefund() public {
        if (offering.state() != Offering.State.Funding || offering.minMet()) return;
        uint256 supply = offering.remainingUnits();
        uint256 publicLeft = offering.publicUnits() - offering.publicUnitsSold();
        uint256 max = supply < publicLeft ? supply : publicLeft;
        if (max == 0) return;
        uint256 cost = offering.quote(1);
        if (offering.raised() + cost >= offering.raiseMin()) return; // would latch minMet
        if (usdc.balanceOf(actor) < cost || usdc.blocked(actor)) return;
        // refund (G-17) needs the actor to still hold their whole purchased
        // position; skip if a prior transfer moved units away, else refund reverts.
        if (token.balanceOf(actor, TOKEN_ID) < offering.unitsBought(actor)) return;

        uint256 usdcStart = usdc.balanceOf(actor);
        uint256 unitsStart = token.balanceOf(actor, TOKEN_ID);
        uint256 depStart = offering.deposits(actor);
        uint256 unitsBoughtBefore = offering.unitsBought(actor);

        vm.prank(actor);
        uint256 paid = offering.buyPublic(1, cost, "");
        ghosts.usdcPaid[actor] += paid;
        ghosts.unitsBoughtCum[actor] += 1;
        ghosts.grossRaised += paid;

        skipTime(CLOSE_AFTER + 1);
        vm.prank(actor);
        offering.markFailed();

        snapshotBefore();
        vm.prank(actor);
        offering.refund();
        snapshotAfter();
        uint256 refundPaid = stateAfter.actorUsdc - stateBefore.actorUsdc;
        ghosts.usdcRefunded[actor] += refundPaid;
        ghosts.usdcRefundedTotal += refundPaid;
        ghosts.unitsReclaimed[actor] += stateAfter.escrowUnits - stateBefore.escrowUnits;
        ghosts.unitsReclaimedTotal += stateAfter.escrowUnits - stateBefore.escrowUnits;

        property_buyFailRefundIsValueNeutral(
            usdcStart, depStart, unitsStart, unitsBoughtBefore, usdc.balanceOf(actor), token.balanceOf(actor, TOKEN_ID)
        );
        _syncMonotonicGhosts();
    }

    /// SP-12: after failure, transfer units away and reacquire the same count
    /// from another holder — refund must still pay in full (balance, not
    /// provenance, is the test).
    function offering_refund_afterReacquire(address seed) public {
        if (offering.state() != Offering.State.Failed) return;
        uint256 units = offering.unitsBought(actor);
        if (units == 0 || offering.deposits(actor) == 0 || usdc.blocked(actor)) return;
        uint256 bal = token.balanceOf(actor, TOKEN_ID);
        if (bal < units) return;

        address other = toActorNotCurrent(seed);
        // Park the whole balance with `other`, then pull exactly `units` back.
        vm.prank(actor);
        token.safeTransferFrom(actor, other, TOKEN_ID, bal, "");
        vm.prank(other);
        token.safeTransferFrom(other, actor, TOKEN_ID, units, "");

        snapshotBefore();
        vm.prank(actor);
        bool success;
        try offering.refund() {
            success = true;
            snapshotAfter();
            uint256 paid = stateAfter.actorUsdc - stateBefore.actorUsdc;
            ghosts.usdcRefunded[actor] += paid;
            ghosts.usdcRefundedTotal += paid;
            ghosts.unitsReclaimed[actor] += stateAfter.escrowUnits - stateBefore.escrowUnits;
            ghosts.unitsReclaimedTotal += stateAfter.escrowUnits - stateBefore.escrowUnits;
        } catch {}
        property_refundEligibilityIsBalanceBased(success);
        _syncMonotonicGhosts();
    }

    /// SP-05: a voucher signed by the NON-live owner seat cannot be claimed.
    function offering_buyPrivate_staleOwner(uint8 idSeed, uint256 unitsWanted) public {
        if (offering.state() != Offering.State.Funding) return;
        uint256 supply = offering.remainingUnits();
        if (supply == 0) return;
        unitsWanted = clampBetween(unitsWanted, 1, supply);
        uint256 staleKey = ownerKey == OWNER_KEY ? OWNER_KEY_B : OWNER_KEY;
        (Offering.Voucher memory voucher, bytes memory ownerSig, bytes memory claimSig) =
            _buildVoucherWithKey(idSeed, type(uint256).max, staleKey, actor);

        bool reverted;
        vm.prank(actor);
        try offering.buyPrivate(voucher, ownerSig, claimSig, unitsWanted, offering.quote(unitsWanted)) {}
        catch {
            reverted = true;
        }
        property_staleOwnerVoucherRejected(reverted);
    }

    /// SP-06: a claim signature bound to buyer B is unusable by the acting buyer.
    function offering_buyPrivate_frontrun(uint8 idSeed, uint256 unitsWanted, address other) public {
        if (offering.state() != Offering.State.Funding) return;
        uint256 supply = offering.remainingUnits();
        if (supply == 0) return;
        unitsWanted = clampBetween(unitsWanted, 1, supply);
        address victim = toActorNotCurrent(other);
        // Live owner sig, claim sig bound to `victim`, but the call comes from `actor`.
        (Offering.Voucher memory voucher, bytes memory ownerSig,) =
            _buildVoucherWithKey(idSeed, type(uint256).max, ownerKey, victim);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(LINK_KEY, offering.claimDigest(voucher.allocationId, victim));
        bytes memory claimSig = abi.encodePacked(r, s, v);

        bool reverted;
        vm.prank(actor);
        try offering.buyPrivate(voucher, ownerSig, claimSig, unitsWanted, offering.quote(unitsWanted)) {}
        catch {
            reverted = true;
        }
        property_claimSignatureIsBuyerBound(reverted);
    }

    /// SP-27: every onlyOwner entry point (and the disabled transferOwnership)
    /// reverts when a random non-owner calls it.
    function offering_adminAsRandomActor(uint8 selector, uint256 arg0, address arg1) public {
        address caller = toActor(arg1);
        if (caller == offering.owner()) return;
        selector = uint8(selector % 8);
        bool reverted;
        if (selector == 0) {
            vm.prank(caller);
            try offering.setPublicUnits(arg0) {}
            catch {
                reverted = true;
            }
        } else if (selector == 1) {
            vm.prank(caller);
            try offering.setTreasury(toActor(arg1)) {}
            catch {
                reverted = true;
            }
        } else if (selector == 2) {
            vm.prank(caller);
            try offering.sweepExcessUsdc() {}
            catch {
                reverted = true;
            }
        } else if (selector == 3) {
            vm.prank(caller);
            try offering.rescue(address(strayToken), toActor(arg1)) {}
            catch {
                reverted = true;
            }
        } else if (selector == 4) {
            vm.prank(caller);
            try offering.cancelAllocation(_allocationId(uint8(arg0))) {}
            catch {
                reverted = true;
            }
        } else if (selector == 5) {
            vm.prank(caller);
            try offering.transferOwnership(vm.addr(OWNER_KEY)) {}
            catch {
                reverted = true;
            }
        } else if (selector == 6) {
            address[] memory buyers = new address[](1);
            buyers[0] = caller;
            vm.prank(caller);
            try offering.refundAll(buyers) {}
            catch {
                reverted = true;
            }
        } else {
            vm.prank(caller);
            try offering.completeOwnershipHandover(vm.addr(OWNER_KEY)) {}
            catch {
                reverted = true;
            }
        }
        property_onlyOwnerGatesHold(reverted);
    }

    /// SP-07: a buyer contract cannot re-enter buyPublic from its 1155 receive
    /// hook. Funds the attacker, runs the attack (which must revert on the
    /// ReentrancyGuard), then sweeps its USDC back into the accounted set so
    /// GL-06 conservation still holds.
    function offering_buy_reenter(uint256 unitsWanted) public {
        if (offering.state() != Offering.State.Funding) return;
        uint256 supply = offering.remainingUnits();
        uint256 publicLeft = offering.publicUnits() - offering.publicUnitsSold();
        uint256 max = supply < publicLeft ? supply : publicLeft;
        if (max < 2) return;
        unitsWanted = clampBetween(unitsWanted, 1, max - 1);
        if (block.timestamp > offering.closeDate() && !offering.minMet()) return;

        if (address(reenterAttacker) == address(0)) reenterAttacker = new ReenterOnReceive();
        uint256 funded = 1_000_000e6;
        usdc.mint(address(reenterAttacker), funded);
        ghosts.usdcMinted += funded;
        vm.prank(address(reenterAttacker));
        usdc.approve(address(offering), type(uint256).max);

        bool reverted;
        try reenterAttacker.attack(address(offering), unitsWanted) {}
        catch {
            reverted = true;
        }
        property_receiverCallbackCannotReenter(reverted);

        // Return any residual to the owner seat — an accounted holder that is
        // never blocklisted (whole amount when the attack reverted, as it must).
        uint256 residual = usdc.balanceOf(address(reenterAttacker));
        if (residual > 0) {
            vm.prank(address(reenterAttacker));
            usdc.transfer(admin, residual);
        }
        _syncMonotonicGhosts();
    }

    /// SP-28: toggling a payment-token blocklist must not destroy any buyer's
    /// recorded deposit.
    function usdc_setBlocked(uint256 actorSeed, bool value) public {
        address h = actors[actorSeed % actors.length];
        usdc.setBlocked(h, value);
        ghosts.blockedDeposit[h] = value ? offering.deposits(h) : 0;
        property_blocklistDestroysNoValue();
    }

    /// SP-22 negative legs: rescuing USDC or the PactToken reverts (G-20).
    function offering_rescueForbidden(uint8 which, address seed) public {
        address to = toActor(seed);
        address tok = which % 2 == 0 ? USDC_ADDRESS : address(token);
        bool reverted;
        vm.prank(admin);
        try offering.rescue(tok, to) {}
        catch {
            reverted = true;
        }
        property_rescueForbiddenReverts(reverted);
    }

    // ――――――――――――――――――――――――― Helpers ――――――――――――――――――――――――――

    // 8 reusable allocation ids so claims, replays, and cancels collide.
    function _allocationId(uint8 idSeed) internal pure returns (bytes32) {
        return keccak256(abi.encode("fizz-allocation", idSeed % 8));
    }

    function _buildVoucher(uint8 idSeed, uint256 cap)
        internal
        returns (Offering.Voucher memory voucher, bytes memory ownerSig, bytes memory claimSig)
    {
        return _buildVoucherWithKey(idSeed, cap, ownerKey, actor);
    }

    // Signs the owner leg with `signKey` (the live owner for normal buys, a
    // stale seat for SP-05) and the claim leg over `claimer` (the acting buyer
    // normally, a different buyer for SP-06's frontrun).
    function _buildVoucherWithKey(uint8 idSeed, uint256 cap, uint256 signKey, address claimer)
        internal
        returns (Offering.Voucher memory voucher, bytes memory ownerSig, bytes memory claimSig)
    {
        voucher = Offering.Voucher({
            allocationId: _allocationId(idSeed), buyerName: "fizz", amountCapUsdc: cap, linkKey: vm.addr(LINK_KEY)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signKey, offering.voucherDigest(voucher));
        ownerSig = abi.encodePacked(r, s, v);
        (v, r, s) = vm.sign(LINK_KEY, offering.claimDigest(voucher.allocationId, claimer));
        claimSig = abi.encodePacked(r, s, v);
    }
}
