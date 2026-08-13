// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {Offering} from "../src/Offering.sol";
import {MockUSDC, MockERC1271Wallet} from "./Mocks.sol";

contract OfferingTest is BaseTest {
    /*//////////////////////////////////////////////////////////////
                              PUBLIC TRANCHE
    //////////////////////////////////////////////////////////////*/

    function testBuyPublicAlongCurveAndMinMet() public {
        vm.expectEmit(true, true, false, true, address(offering));
        emit Offering.Bought(buyer, bytes32(0), 100, 100e6 + 1000 * ((99 * 100) / 2), "Bob");
        vm.prank(buyer);
        uint256 cost = offering.buyPublic(100, type(uint256).max, "Bob");

        assertEq(cost, 100e6 + 1000 * ((99 * 100) / 2), "cost");
        assertTrue(offering.minMet(), "min");
        assertEq(offering.unitsSold(), 100, "sold");
        assertEq(offering.publicUnitsSold(), 100, "public sold");
        assertEq(offering.unitsBought(buyer), 100, "units bought");
        assertEq(token.balanceOf(buyer, 0), 100, "buyer units");
    }

    function testBuyPublicCapEnforced() public {
        vm.prank(buyer);
        offering.buyPublic(100, type(uint256).max, "");

        vm.prank(buyer2);
        vm.expectRevert(Offering.PublicAllocationExceeded.selector);
        offering.buyPublic(1, type(uint256).max, "");

        vm.prank(treasury);
        offering.setPublicUnits(150);
        vm.prank(buyer2);
        offering.buyPublic(50, type(uint256).max, "");
        assertEq(offering.publicUnitsSold(), 150, "raised cap used");

        vm.prank(treasury);
        vm.expectRevert(Offering.InvalidConfig.selector);
        offering.setPublicUnits(100);
    }

    /// Any single public buy pays exactly the closed-form curve price.
    function testFuzzBuyPublicCostMatchesCurve(uint256 units) public {
        units = bound(units, 1, 100);
        uint256 expected = units * 1e6 + 1000 * ((units * (units - 1)) / 2);
        assertEq(offering.quote(units), expected, "quote");

        vm.prank(buyer);
        uint256 cost = offering.buyPublic(units, type(uint256).max, "");
        assertEq(cost, expected, "cost");
        assertEq(token.balanceOf(buyer, 0), units, "buyer units");
        assertEq(usdc.balanceOf(address(offering)), cost, "escrowed usdc");
    }

    /// Splitting a purchase in two never changes the total price: the curve
    /// has no seam between buys (or between the two tranches sharing it).
    function testFuzzBuyPathIsSplitInvariant(uint256 first, uint256 second) public {
        first = bound(first, 1, 99);
        second = bound(second, 1, 100 - first);

        vm.prank(buyer);
        uint256 costA = offering.buyPublic(first, type(uint256).max, "");
        vm.prank(buyer2);
        uint256 costB = offering.buyPublic(second, type(uint256).max, "");

        assertEq(costA + costB, offering.costFor(0, first + second), "no curve seam");
        assertEq(offering.unitsSold(), first + second, "sold");
    }

    /*//////////////////////////////////////////////////////////////
                             PRIVATE TRANCHE
    //////////////////////////////////////////////////////////////*/

    function testBuyPrivateWithVoucher() public {
        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        vm.prank(buyer2);
        uint256 cost = offering.buyPrivate(voucher, ownerSig, claimSig, 150, type(uint256).max);

        assertLe(cost, 200e6, "cap respected");
        assertEq(token.balanceOf(buyer2, 0), 150, "buyer units");
        assertTrue(offering.allocationConsumed(voucher.allocationId), "consumed");
        assertEq(offering.publicUnitsSold(), 0, "not public");

        // One-shot: a second claim on the same allocation fails.
        vm.prank(buyer2);
        vm.expectRevert(Offering.AllocationAlreadyConsumed.selector);
        offering.buyPrivate(voucher, ownerSig, claimSig, 1, type(uint256).max);
    }

    function testBuyPrivateWithSmartWalletOwner() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet();
        vm.prank(treasury);
        offering.transferOwnership(address(wallet));
        vm.prank(address(wallet));
        offering.acceptOwnership();

        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        wallet.approveDigest(offering.voucherDigest(voucher));
        // Opaque 736-byte blob, the shape a WebAuthn wallet returns from
        // eth_signTypedData_v4 — only the wallet's ERC-1271 answer matters.
        bytes memory ownerSig = new bytes(736);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        vm.prank(buyer2);
        uint256 cost = offering.buyPrivate(voucher, ownerSig, claimSig, 150, type(uint256).max);
        assertLe(cost, 200e6, "cap respected");
        assertEq(token.balanceOf(buyer2, 0), 150, "buyer units");
    }

    function testBuyPrivateSmartWalletRejectsUnapprovedDigest() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet();
        vm.prank(treasury);
        offering.transferOwnership(address(wallet));
        vm.prank(address(wallet));
        offering.acceptOwnership();

        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        vm.prank(buyer2);
        vm.expectRevert(Offering.InvalidVoucherSignature.selector);
        offering.buyPrivate(voucher, new bytes(736), claimSig, 10, type(uint256).max);
    }

    function testBuyPrivateRejectsWrongClaimer() public {
        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        // A frontrunner copying the claim calldata is not the endorsed sender.
        vm.prank(buyer);
        vm.expectRevert(Offering.InvalidClaimSignature.selector);
        offering.buyPrivate(voucher, ownerSig, claimSig, 10, type(uint256).max);
    }

    function testBuyPrivateRejectsTamperedVoucher() public {
        Offering.Voucher memory voucher = _voucher("Alice", 50e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        voucher.amountCapUsdc = 500e6;
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        vm.prank(buyer2);
        vm.expectRevert(Offering.InvalidVoucherSignature.selector);
        offering.buyPrivate(voucher, ownerSig, claimSig, 10, type(uint256).max);
    }

    function testBuyPrivateEnforcesUsdcCap() public {
        Offering.Voucher memory voucher = _voucher("Alice", 10e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        vm.prank(buyer2);
        vm.expectRevert(Offering.AllocationCapExceeded.selector);
        offering.buyPrivate(voucher, ownerSig, claimSig, 50, type(uint256).max);
    }

    function testCancelAllocationRevokesLink() public {
        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        vm.prank(treasury);
        offering.cancelAllocation(voucher.allocationId);

        vm.prank(buyer2);
        vm.expectRevert(Offering.AllocationAlreadyConsumed.selector);
        offering.buyPrivate(voucher, ownerSig, claimSig, 10, type(uint256).max);
    }

    function testOwnerRotationRevokesOutstandingVouchers() public {
        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        address newOwner = makeAddr("newOwner");
        vm.prank(treasury);
        offering.transferOwnership(newOwner);
        vm.prank(newOwner);
        offering.acceptOwnership();

        vm.prank(buyer2);
        vm.expectRevert(Offering.InvalidVoucherSignature.selector);
        offering.buyPrivate(voucher, ownerSig, claimSig, 10, type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                            FAILURE + REFUNDS
    //////////////////////////////////////////////////////////////*/

    function testRefundReclaimsUnitsAndDecrementsRaised() public {
        vm.prank(buyer);
        uint256 cost = offering.buyPublic(10, type(uint256).max, "");
        uint256 raisedBefore = offering.raised();
        _fail();

        vm.prank(buyer);
        offering.refund();

        assertEq(usdc.balanceOf(buyer), 1_000e6, "refunded");
        assertEq(token.balanceOf(buyer, 0), 0, "units reclaimed");
        assertEq(token.balanceOf(address(offering), 0), 200, "escrow restored");
        assertEq(offering.deposits(buyer), 0, "deposit cleared");
        assertEq(offering.unitsBought(buyer), 0, "units cleared");
        assertEq(offering.raised(), raisedBefore - cost, "raised decremented");
    }

    function testRefundForfeitedIfUnitsMoved() public {
        vm.startPrank(buyer);
        offering.buyPublic(10, type(uint256).max, "");
        token.safeTransferFrom(buyer, buyer2, 0, 5, "");
        vm.stopPrank();
        _fail();

        vm.prank(buyer);
        vm.expectRevert(Offering.UnitsNotReturned.selector);
        offering.refund();
    }

    function testRefundAllSkipsBlockedBuyerAndContinues() public {
        vm.prank(buyer);
        offering.buyPublic(10, type(uint256).max, "");
        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);
        vm.prank(buyer2);
        offering.buyPrivate(voucher, ownerSig, claimSig, 10, type(uint256).max);
        _fail();

        usdc.setBlocked(buyer, true);
        address[] memory buyers = new address[](2);
        buyers[0] = buyer;
        buyers[1] = buyer2;
        vm.prank(treasury);
        offering.refundAll(buyers);

        assertGt(offering.deposits(buyer), 0, "blocked kept deposit");
        assertEq(token.balanceOf(buyer, 0), 10, "blocked kept units");
        assertEq(offering.deposits(buyer2), 0, "second refunded");
        assertEq(token.balanceOf(buyer2, 0), 0, "second units reclaimed");

        // The skipped buyer keeps the pull path once unblocked.
        usdc.setBlocked(buyer, false);
        vm.prank(buyer);
        offering.refund();
        assertEq(usdc.balanceOf(buyer), 1_000e6, "pull refund");
    }

    function testSweepFailedUnitsToTreasury() public {
        vm.prank(buyer);
        offering.buyPublic(10, type(uint256).max, "");
        _fail();
        vm.prank(buyer);
        offering.refund();

        uint256 swept = offering.sweepFailedUnits();
        assertEq(swept, 200, "swept all");
        assertEq(token.balanceOf(treasury, 0), 200, "treasury units");
    }

    /*//////////////////////////////////////////////////////////////
                         WITHDRAW / CLOSE / RESCUE
    //////////////////////////////////////////////////////////////*/

    function testPermissionlessWithdrawPaysTreasuryOnly() public {
        vm.prank(buyer);
        uint256 first = offering.buyPublic(100, type(uint256).max, "");

        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        uint256 withdrawn = offering.withdraw();
        assertEq(withdrawn, first, "withdrawn");
        assertEq(usdc.balanceOf(treasury), first, "treasury");
        assertEq(usdc.balanceOf(keeper), 0, "caller paid");
    }

    function testOwnerCloseReturnsUnsoldUnits() public {
        vm.prank(buyer);
        offering.buyPublic(100, type(uint256).max, "");

        vm.prank(treasury);
        offering.closeAndWithdraw();

        assertEq(uint256(offering.state()), uint256(Offering.State.Closed), "closed");
        assertEq(token.balanceOf(treasury, 0), 100, "unsold");
        assertGt(usdc.balanceOf(treasury), 0, "usdc");
    }

    function testSkimUsdcSweepsOnlyExcess() public {
        vm.prank(buyer);
        uint256 cost = offering.buyPublic(100, type(uint256).max, "");
        usdc.mint(address(offering), 5e6); // e.g. split revenue pushed in by SplitMain.withdraw

        vm.prank(treasury);
        uint256 skimmed = offering.skimUsdc();
        assertEq(skimmed, 5e6, "skimmed excess only");
        assertEq(usdc.balanceOf(address(offering)), cost, "liability intact");
    }

    function testRescueRejectsUsdcAndPactToken() public {
        vm.startPrank(treasury);
        vm.expectRevert(Offering.InvalidAddress.selector);
        offering.rescue(USDC_ADDRESS, treasury);
        vm.expectRevert(Offering.InvalidAddress.selector);
        offering.rescue(address(token), treasury);
        vm.stopPrank();

        MockUSDC stray = new MockUSDC();
        stray.mint(address(offering), 7e6);
        vm.prank(treasury);
        offering.rescue(address(stray), treasury);
        assertEq(stray.balanceOf(treasury), 7e6, "rescued");
    }

    function testTwoStepOwnership() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(treasury);
        offering.transferOwnership(newOwner);
        assertEq(offering.owner(), treasury, "owner unchanged until accept");

        vm.prank(buyer);
        vm.expectRevert(Offering.NotOwner.selector);
        offering.acceptOwnership();

        vm.prank(newOwner);
        offering.acceptOwnership();
        assertEq(offering.owner(), newOwner, "accepted");
        assertEq(offering.pendingOwner(), address(0), "pending cleared");
    }

    /*//////////////////////////////////////////////////////////////
                           LIFECYCLE EDGES
    //////////////////////////////////////////////////////////////*/

    function testAfterMinCloseDateDoesNotStopBuyOrTopUp() public {
        vm.prank(buyer);
        offering.buyPublic(100, type(uint256).max, "");

        vm.warp(block.timestamp + 8 days);
        // Top-up: a holder deposits more of their own units into the offering.
        vm.prank(holder);
        token.safeTransferFrom(holder, address(offering), 0, 50, "");

        vm.prank(treasury);
        offering.setPublicUnits(150);
        vm.prank(buyer2);
        offering.buyPublic(10, type(uint256).max, "");
        assertEq(token.balanceOf(buyer2, 0), 10, "post close buy");
    }

    function testBuyBlockedPastCloseWithoutMin() public {
        vm.warp(block.timestamp + 8 days);
        vm.prank(buyer);
        vm.expectRevert(Offering.PastCloseDate.selector);
        offering.buyPublic(1, type(uint256).max, "");
    }

    function testReceiverRejectsDepositsAfterFailure() public {
        _fail();
        vm.prank(holder);
        vm.expectRevert(Offering.ClosedOrFailed.selector);
        token.safeTransferFrom(holder, address(offering), 0, 50, "");
    }
}
