// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Base} from "./Base.sol";

/// @notice Used to take snapshots of the state before and after a function call
abstract contract Snapshots is Base {
    // Single-actor-oriented before/after state for delta properties. Every read
    // is a safe view that cannot revert. Per-batch / per-recipient properties
    // (SP-13, SP-17, ...) capture their own locals in the handler instead.
    struct State {
        uint8 state;
        bool minMet;
        uint256 raised;
        uint256 withdrawn;
        uint256 unitsSold;
        uint256 publicUnits;
        uint256 publicUnitsSold;
        uint256 escrowUsdc;
        uint256 escrowUnits;
        uint256 escrowStray;
        address treasury;
        uint256 treasuryUsdc;
        uint256 treasuryUnits;
        address owner;
        address pendingOwner;
        uint256 actorUsdc;
        uint256 actorUnits;
        uint256 actorDeposits;
        uint256 actorUnitsBought;
        uint256 sumDeposits;
        uint256 sumUnitsBought;
        uint256 rescueRecipientStray;
        uint256 tokenEth;
        uint256 payoutSplitEth;
        uint256 timestamp;
        uint256 transferFromUnits;
        uint256 transferToUnits;
    }

    State internal stateBefore;
    State internal stateAfter;

    function _takeSnapshot(State storage state) private {
        state.state = uint8(offering.state());
        state.minMet = offering.minMet();
        state.raised = offering.raised();
        state.withdrawn = offering.withdrawn();
        state.unitsSold = offering.unitsSold();
        state.publicUnits = offering.publicUnits();
        state.publicUnitsSold = offering.publicUnitsSold();
        state.escrowUsdc = usdc.balanceOf(address(offering));
        state.escrowUnits = token.balanceOf(address(offering), TOKEN_ID);
        state.escrowStray = strayToken.balanceOf(address(offering));

        address treasury = offering.treasury();
        state.treasury = treasury;
        state.treasuryUsdc = usdc.balanceOf(treasury);
        state.treasuryUnits = token.balanceOf(treasury, TOKEN_ID);

        state.owner = offering.owner();
        state.pendingOwner = offering.pendingOwner();

        state.actorUsdc = usdc.balanceOf(actor);
        state.actorUnits = token.balanceOf(actor, TOKEN_ID);
        state.actorDeposits = offering.deposits(actor);
        state.actorUnitsBought = offering.unitsBought(actor);

        state.sumDeposits = _sumDeposits();
        state.sumUnitsBought = _sumUnitsBought();

        // The rescue recipient and the transfer `to` are handler locals; the
        // acting actor is the safe generic stand-in the snapshot can always read.
        state.rescueRecipientStray = strayToken.balanceOf(actor);
        state.tokenEth = address(token).balance;
        state.payoutSplitEth = token.payoutSplit().balance;
        state.timestamp = block.timestamp;
        state.transferFromUnits = token.balanceOf(actor, TOKEN_ID);
        state.transferToUnits = token.balanceOf(actor, TOKEN_ID);
    }

    function snapshotBefore() internal {
        _takeSnapshot(stateBefore);
    }

    function snapshotAfter() internal {
        _takeSnapshot(stateAfter);
    }
}
