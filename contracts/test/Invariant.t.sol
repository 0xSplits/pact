// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {BaseTest} from "./Base.t.sol";
import {Offering} from "../src/Offering.sol";
import {PactToken} from "../src/PactToken.sol";
import {MockUSDC} from "./Mocks.sol";

/// @notice Randomly sequences buys, withdrawals, warps, failure, and refunds
/// against one offering, tracking ghost totals for the invariants below.
/// Guards keep legal calls from reverting (fail_on_revert = true); `refund` is
/// deliberately attempted in every state via try/catch so the Failed-only rule
/// is exercised rather than assumed.
contract OfferingHandler is CommonBase, StdCheats, StdUtils {
    uint256 private constant OWNER_KEY = 1;
    uint256 private constant LINK_KEY = 2;

    Offering private offering;
    MockUSDC private usdc;
    PactToken private token;

    address[3] private actors;
    uint256 private allocationNonce;

    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    uint256 public ghostRefunded;
    uint256 public ghostUnitsRefunded;
    bool public refundOutsideFailed;

    constructor(Offering offering_, MockUSDC usdc_, PactToken token_) {
        offering = offering_;
        usdc = usdc_;
        token = token_;
        for (uint256 i = 0; i < actors.length; i++) {
            actors[i] = makeAddr(string(abi.encodePacked("actor", i)));
            vm.prank(actors[i]);
            usdc.approve(address(offering), type(uint256).max);
        }
    }

    function buyPublic(uint256 actorSeed, uint256 unitsSeed) external {
        uint256 room = offering.publicUnits() - offering.publicUnitsSold();
        uint256 supply = offering.remainingUnits();
        uint256 max = room < supply ? room : supply;
        if (max == 0 || !_buyable()) return;
        _buy(actorSeed, bound(unitsSeed, 1, max), false);
    }

    function buyPrivate(uint256 actorSeed, uint256 unitsSeed) external {
        uint256 supply = offering.remainingUnits();
        uint256 reserved = offering.publicUnits() - offering.publicUnitsSold();
        uint256 max = supply > reserved ? supply - reserved : 0;
        if (max == 0 || !_buyable()) return;
        _buy(actorSeed, bound(unitsSeed, 1, max), true);
    }

    function withdraw() external {
        if (!offering.minMet() || offering.raised() == offering.withdrawn()) return;
        ghostWithdrawn += offering.withdraw();
    }

    function warp(uint256 deltaSeed) external {
        vm.warp(block.timestamp + bound(deltaSeed, 1 hours, 4 days));
    }

    function markFailed() external {
        if (offering.state() != Offering.State.Funding || block.timestamp <= offering.closeDate() || offering.minMet()) return;
        offering.markFailed();
    }

    function refund(uint256 actorSeed) external {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        uint256 amount = offering.deposits(actor);
        uint256 units = offering.unitsBought(actor);
        if (amount == 0) return;
        vm.prank(actor);
        try offering.refund() {
            if (offering.state() != Offering.State.Failed) refundOutsideFailed = true;
            ghostRefunded += amount;
            ghostUnitsRefunded += units;
        } catch {}
    }

    function _buyable() private view returns (bool) {
        if (offering.state() != Offering.State.Funding) return false;
        return block.timestamp <= offering.closeDate() || offering.minMet();
    }

    function _buy(uint256 actorSeed, uint256 units, bool isPrivate) private {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        uint256 cost = offering.quote(units);
        usdc.mint(actor, cost);
        if (isPrivate) {
            Offering.Voucher memory voucher = Offering.Voucher({
                allocationId: keccak256(abi.encode("invariant", ++allocationNonce)),
                buyerName: "",
                amountCapUsdc: cost,
                linkKey: vm.addr(LINK_KEY)
            });
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, offering.voucherDigest(voucher));
            bytes memory ownerSig = abi.encodePacked(r, s, v);
            (v, r, s) = vm.sign(LINK_KEY, offering.claimDigest(voucher.allocationId, actor));
            vm.prank(actor);
            offering.buyPrivate(voucher, ownerSig, abi.encodePacked(r, s, v), units, cost);
        } else {
            vm.prank(actor);
            offering.buyPublic(units, cost, "");
        }
        ghostDeposited += cost;
    }
}

contract OfferingInvariantTest is BaseTest {
    OfferingHandler internal handler;
    uint256 internal initialUnits;

    function setUp() public override {
        super.setUp();
        handler = new OfferingHandler(offering, usdc, token);
        initialUnits = offering.remainingUnits();
        targetContract(address(handler));
    }

    function invariant_usdcBalanceMatchesLedger() public view {
        assertEq(
            usdc.balanceOf(address(offering)),
            handler.ghostDeposited() - handler.ghostWithdrawn() - handler.ghostRefunded()
        );
    }

    function invariant_unitsConserved() public view {
        // Refunds pull units back to escrow without decrementing unitsSold,
        // hence the ghost adjustment.
        assertEq(offering.remainingUnits() + offering.unitsSold() - handler.ghostUnitsRefunded(), initialUnits);
    }

    function invariant_refundsOnlyWhenFailed() public view {
        assertFalse(handler.refundOutsideFailed());
    }

    function invariant_refundsNeverExceedDeposits() public view {
        assertLe(handler.ghostRefunded(), handler.ghostDeposited());
    }
}
