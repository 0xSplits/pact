// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Actor} from "../Actor.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with PactToken
abstract contract PactTokenHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    function pactToken_transfer_clamped(address toSeed, uint256 amount) public {
        uint256 balance = token.balanceOf(actor, TOKEN_ID);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        pactToken_safeTransferFrom(actor, toActorNotCurrent(toSeed), TOKEN_ID, amount, "");
    }

    /// Third-party unit top-up into the escrow mid-raise (attack surface X-2):
    /// donated units silently widen the sellable/close/sweep supply.
    function pactToken_donateToEscrow_clamped(uint256 amount) public {
        uint256 balance = token.balanceOf(actor, TOKEN_ID);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        pactToken_safeTransferFrom(actor, address(offering), TOKEN_ID, amount, "");
    }

    /// Full-amount stress: moves the actor's whole unit balance away, which
    /// forfeits their refund (G-17) while their deposit stays in `raised`.
    function pactToken_transferAll(address toSeed) public {
        uint256 balance = token.balanceOf(actor, TOKEN_ID);
        if (balance == 0) return;
        pactToken_safeTransferFrom(actor, toActorNotCurrent(toSeed), TOKEN_ID, balance, "");
    }

    /// Revenue lands on the PactToken (it has receive()) for distributeFunds.
    function pactToken_donateETH_clamped(uint256 amount) public {
        if (actor.balance == 0) return;
        amount = clampBetween(amount, 1, actor.balance);
        Actor(payable(actor)).forceSendETH(address(token), amount);
    }

    function pactToken_secondary(uint8 selector, uint256 arg0, address arg1) public {
        selector = uint8(selector % 3);
        if (selector == 0) _pactToken_safeBatchTransferFrom(arg1, arg0);
        else if (selector == 1) _pactToken_setApprovalForAll(arg1, arg0 % 2 == 0);
        else _pactToken_distributeFunds(arg0 % 2 == 0);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function pactToken_safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes memory data)
        public
        asActor
    {
        uint256 fromBefore = token.balanceOf(from, id);
        uint256 toBefore = token.balanceOf(to, id);
        token.safeTransferFrom(from, to, id, amount, data);
        if (to == address(offering) && id == TOKEN_ID) ghosts.unitsDonated += amount;
        property_unitTransferMovesExactly(from, to, amount, fromBefore, toBefore);
    }

    function _pactToken_safeBatchTransferFrom(address toSeed, uint256 amount) internal {
        uint256 balance = token.balanceOf(actor, TOKEN_ID);
        if (balance == 0) return;
        address to = toActorNotCurrent(toSeed);
        uint256 amt = clampBetween(amount, 1, balance);
        uint256 fromBefore = token.balanceOf(actor, TOKEN_ID);
        uint256 toBefore = token.balanceOf(to, TOKEN_ID);
        uint256[] memory ids = new uint256[](1);
        ids[0] = TOKEN_ID;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amt;
        vm.prank(actor);
        token.safeBatchTransferFrom(actor, to, ids, amounts, "");
        property_unitTransferMovesExactly(actor, to, amt, fromBefore, toBefore);
    }

    function _pactToken_setApprovalForAll(address operatorSeed, bool approved) internal {
        address operator = toActorNotCurrent(operatorSeed);
        vm.prank(actor);
        token.setApprovalForAll(operator, approved);
        ghosts.approvedGhost[actor][operator] = approved;
    }

    /// Distributes with the full set of addresses that can hold units in this
    /// harness, sorted ascending (MockSplitMain requires strictly-ascending
    /// unique accounts, as real SplitMain does). SP-29: the call must not revert
    /// once there are at least two holders.
    function _pactToken_distributeFunds(bool eth) internal {
        address[] memory candidates = new address[](7);
        candidates[0] = actors[0];
        candidates[1] = actors[1];
        candidates[2] = actors[2];
        candidates[3] = vm.addr(OWNER_KEY);
        candidates[4] = vm.addr(OWNER_KEY_B);
        candidates[5] = offering.treasury();
        candidates[6] = address(offering);

        address[] memory holders = new address[](candidates.length);
        uint256 count;
        for (uint256 i; i < candidates.length; i++) {
            bool duplicate;
            for (uint256 j; j < count; j++) {
                if (holders[j] == candidates[i]) {
                    duplicate = true;
                    break;
                }
            }
            if (duplicate || token.balanceOf(candidates[i], TOKEN_ID) == 0) continue;
            holders[count++] = candidates[i];
        }
        // Fewer than two holders is GL-20's territory (distribution reverts, as
        // on mainnet) — not a liveness failure. Skip.
        if (count < 2) return;

        address[] memory accounts = new address[](count);
        for (uint256 i; i < count; i++) {
            accounts[i] = holders[i];
        }
        // Insertion sort into strictly-ascending order (deduped above).
        for (uint256 i = 1; i < count; i++) {
            address key = accounts[i];
            uint256 j = i;
            while (j > 0 && accounts[j - 1] > key) {
                accounts[j] = accounts[j - 1];
                j--;
            }
            accounts[j] = key;
        }

        snapshotBefore();
        bool funding = offering.state() == Offering.State.Funding;
        bool success;
        try token.distributeFunds(eth ? address(0) : USDC_ADDRESS, accounts, actor) {
            success = true;
            snapshotAfter();
            if (eth) property_ethDistributionReachesPayoutSplit();
        } catch {}
        if (funding) property_distributeFundsGatedWhileFunding(success);
        else property_distributeFundsNeverReverts(success);
    }

    // ―――――――――――――――――――――― New handlers ――――――――――――――――――――――――

    /// SP-32: a caller that is neither owner, approved operator, nor the Offering
    /// cannot move another account's units — single and batch.
    function pactToken_transferUnauthorized(address fromSeed, address toSeed, uint256 amount) public {
        address from = toActor(fromSeed);
        address caller = toActorNotCurrent(fromSeed);
        if (caller == from || token.isApprovedForAll(from, caller)) return;
        uint256 bal = token.balanceOf(from, TOKEN_ID);
        if (bal == 0) return;
        amount = clampBetween(amount, 1, bal);
        address to = toActorNotCurrent(toSeed);

        bool reverted;
        vm.prank(caller);
        try token.safeTransferFrom(from, to, TOKEN_ID, amount, "") {}
        catch {
            reverted = true;
        }
        property_unauthorizedTransferReverts(reverted);

        uint256[] memory ids = new uint256[](1);
        ids[0] = TOKEN_ID;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        bool revertedBatch;
        vm.prank(caller);
        try token.safeBatchTransferFrom(from, to, ids, amounts, "") {}
        catch {
            revertedBatch = true;
        }
        property_unauthorizedTransferReverts(revertedBatch);
    }

    /// SP-33: a self-transfer of any amount and a zero-amount transfer to another
    /// holder both succeed and change nothing.
    function pactToken_transferNoop(address toSeed, uint256 amount) public {
        uint256 bal = token.balanceOf(actor, TOKEN_ID);
        uint256 selfAmt = bal == 0 ? 0 : clampBetween(amount, 0, bal);

        uint256 senderBefore = bal;
        vm.prank(actor);
        token.safeTransferFrom(actor, actor, TOKEN_ID, selfAmt, "");
        property_noopTransfersChangeNothing(
            actor, senderBefore, token.balanceOf(actor, TOKEN_ID), senderBefore, token.balanceOf(actor, TOKEN_ID)
        );

        address to = toActorNotCurrent(toSeed);
        uint256 senderBefore2 = token.balanceOf(actor, TOKEN_ID);
        uint256 recipientBefore = token.balanceOf(to, TOKEN_ID);
        vm.prank(actor);
        token.safeTransferFrom(actor, to, TOKEN_ID, 0, "");
        property_noopTransfersChangeNothing(
            to, senderBefore2, token.balanceOf(actor, TOKEN_ID), recipientBefore, token.balanceOf(to, TOKEN_ID)
        );
    }

    /// SP-34: a transfer to the zero address, or of more than the balance, reverts.
    function pactToken_transferInvalid(uint8 which, uint256 amount) public {
        uint256 bal = token.balanceOf(actor, TOKEN_ID);
        bool reverted;
        if (which % 2 == 0) {
            uint256 amt = bal == 0 ? 1 : clampBetween(amount, 1, bal);
            vm.prank(actor);
            try token.safeTransferFrom(actor, address(0), TOKEN_ID, amt, "") {}
            catch {
                reverted = true;
            }
        } else {
            address to = toActorNotCurrent(address(uint160(amount)));
            vm.prank(actor);
            try token.safeTransferFrom(actor, to, TOKEN_ID, bal + 1, "") {}
            catch {
                reverted = true;
            }
        }
        property_invalidTransferReverts(reverted);
    }

    /// GL-43 adversarial: revoking the Offering as operator must not actually
    /// remove it — the permanent-operator claim is tested, not assumed. The
    /// assertion is 7A's global property_operatorApprovalSemantics.
    function pactToken_revokeOfferingOperator() public {
        vm.prank(actor);
        token.setApprovalForAll(address(offering), false);
    }
}
