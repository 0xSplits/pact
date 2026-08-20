// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";

import {BaseTest} from "./Base.t.sol";
import {IERC1155Receiver, Offering} from "../src/Offering.sol";
import {PactToken} from "../src/PactToken.sol";
import {MockUSDC, MockERC1271Wallet, ReenterOnReceive} from "./Mocks.sol";

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

    function testBuyPublicSlippageOnStaleQuote() public {
        uint256 staleQuote = offering.quote(10);
        vm.prank(buyer2);
        offering.buyPublic(10, type(uint256).max, "");

        vm.prank(buyer);
        vm.expectRevert(Offering.Slippage.selector);
        offering.buyPublic(10, staleQuote, "");
    }

    function testPrivateClaimCannotStarvePublicReservation() public {
        Offering.Voucher memory voucher = _voucher("Alice", 500e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        // 200 escrowed, 100 reserved for the public tranche: 150 dips into it.
        vm.prank(buyer2);
        vm.expectRevert(abi.encodeWithSelector(Offering.PublicReservationExceeded.selector, 100));
        offering.buyPrivate(voucher, ownerSig, claimSig, 150, type(uint256).max);

        // Lowering the cap frees the supply openly, and the claim goes through.
        vm.prank(treasury);
        offering.setPublicUnits(50);
        vm.prank(buyer2);
        offering.buyPrivate(voucher, ownerSig, claimSig, 150, type(uint256).max);

        // The advertised public headroom stays deliverable.
        vm.prank(buyer);
        offering.buyPublic(50, type(uint256).max, "");
        assertEq(offering.remainingUnits(), 0, "escrow exactly emptied");
    }

    function testSetPublicUnitsCannotExceedDeliverableSupply() public {
        vm.prank(treasury);
        offering.setPublicUnits(200);

        vm.prank(treasury);
        vm.expectRevert(Offering.InvalidConfig.selector);
        offering.setPublicUnits(201);
    }

    /*//////////////////////////////////////////////////////////////
                             PRIVATE TRANCHE
    //////////////////////////////////////////////////////////////*/

    function testBuyPrivateWithVoucher() public {
        // Free 150 units for the private tranche (100 stay publicly reserved).
        vm.prank(treasury);
        offering.setPublicUnits(50);

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
        vm.prank(treasury);
        offering.setPublicUnits(50);

        MockERC1271Wallet wallet = new MockERC1271Wallet();
        vm.prank(address(wallet));
        offering.requestOwnershipHandover();
        vm.prank(treasury);
        offering.completeOwnershipHandover(address(wallet));

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
        vm.prank(address(wallet));
        offering.requestOwnershipHandover();
        vm.prank(treasury);
        offering.completeOwnershipHandover(address(wallet));

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

    function testBuyPrivateRejectsCrossChainClaimSig() public {
        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        // A CREATE2 twin on another chain: the owner re-endorses the same
        // allocation there, but the link key's signature stays chain-bound.
        vm.chainId(8453);
        bytes memory ownerSig = _ownerSig(offering, voucher);

        vm.prank(buyer2);
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

    function testBuyPrivateSlippageOnStaleQuote() public {
        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);
        uint256 staleQuote = offering.quote(10);

        vm.prank(buyer);
        offering.buyPublic(10, type(uint256).max, "");

        vm.prank(buyer2);
        vm.expectRevert(Offering.Slippage.selector);
        offering.buyPrivate(voucher, ownerSig, claimSig, 10, staleQuote);
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
        vm.prank(newOwner);
        offering.requestOwnershipHandover();
        vm.prank(treasury);
        offering.completeOwnershipHandover(newOwner);

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

    function testRefundAllRevertsOnBlockedBuyer() public {
        vm.prank(buyer);
        offering.buyPublic(10, type(uint256).max, "");
        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);
        vm.prank(buyer2);
        offering.buyPrivate(voucher, ownerSig, claimSig, 10, type(uint256).max);
        _fail();

        // A failing transfer reverts the whole batch; the owner retries
        // without the blocked buyer.
        usdc.setBlocked(buyer, true);
        address[] memory buyers = new address[](2);
        buyers[0] = buyer;
        buyers[1] = buyer2;
        vm.prank(treasury);
        vm.expectRevert();
        offering.refundAll(buyers);
        assertGt(offering.deposits(buyer), 0, "blocked kept deposit");
        assertGt(offering.deposits(buyer2), 0, "batch fully unwound");

        address[] memory retry = new address[](1);
        retry[0] = buyer2;
        vm.prank(treasury);
        offering.refundAll(retry);
        assertEq(offering.deposits(buyer2), 0, "second refunded");
        assertEq(token.balanceOf(buyer2, 0), 0, "second units reclaimed");

        // The omitted buyer keeps the pull path once unblocked.
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

    function testMarkFailedRevertsWhenMinimumMet() public {
        vm.prank(buyer);
        offering.buyPublic(100, type(uint256).max, "");
        offering.withdraw();

        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(Offering.MinimumAlreadyMet.selector);
        offering.markFailed();
        assertEq(uint256(offering.state()), uint256(Offering.State.Funding), "still funding");
    }

    function testMarkFailedRevertsBeforeCloseDate() public {
        vm.expectRevert(Offering.CloseDateNotPassed.selector);
        offering.markFailed();
        assertEq(uint256(offering.state()), uint256(Offering.State.Funding), "still funding");
    }

    function testMarkFailedRevertsWhenAlreadyFailed() public {
        _fail();
        vm.expectRevert(Offering.NotFunding.selector);
        offering.markFailed();
    }

    function testMarkFailedRevertsAfterClose() public {
        vm.prank(buyer);
        offering.buyPublic(100, type(uint256).max, "");
        vm.prank(treasury);
        offering.closeAndWithdraw();

        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(Offering.NotFunding.selector);
        offering.markFailed();
    }

    function testRefundRevertsDuringFunding() public {
        vm.prank(buyer);
        offering.buyPublic(10, type(uint256).max, "");

        vm.prank(buyer);
        vm.expectRevert(Offering.NotFailed.selector);
        offering.refund();
    }

    function testRefundNothingForDoubleClaimOrStranger() public {
        vm.prank(buyer);
        offering.buyPublic(10, type(uint256).max, "");
        _fail();

        vm.prank(buyer);
        offering.refund();
        vm.prank(buyer);
        vm.expectRevert(Offering.NothingToRefund.selector);
        offering.refund();

        vm.prank(buyer2);
        vm.expectRevert(Offering.NothingToRefund.selector);
        offering.refund();
    }

    function testRefundAllSkipsBuyerWhoMovedUnits() public {
        vm.startPrank(buyer);
        offering.buyPublic(10, type(uint256).max, "");
        token.safeTransferFrom(buyer, holder, 0, 5, "");
        vm.stopPrank();
        vm.prank(buyer2);
        uint256 cost2 = offering.buyPublic(10, type(uint256).max, "");
        _fail();

        address[] memory buyers = new address[](2);
        buyers[0] = buyer;
        buyers[1] = buyer2;
        vm.expectEmit(true, false, false, true, address(offering));
        emit Offering.RefundSkipped(buyer);
        vm.expectEmit(true, false, false, true, address(offering));
        emit Offering.RefundPaid(buyer2, cost2);
        vm.prank(treasury);
        offering.refundAll(buyers);

        assertGt(offering.deposits(buyer), 0, "mover kept deposit");
        assertEq(offering.deposits(buyer2), 0, "second refunded");
    }

    function testRefundAllDuplicateAddressRefundsOnce() public {
        vm.prank(buyer);
        offering.buyPublic(10, type(uint256).max, "");
        _fail();

        address[] memory buyers = new address[](2);
        buyers[0] = buyer;
        buyers[1] = buyer;
        vm.prank(treasury);
        offering.refundAll(buyers);

        assertEq(usdc.balanceOf(buyer), 1_000e6, "refunded exactly once");
        assertEq(offering.deposits(buyer), 0, "deposit cleared");
    }

    function testRefundAllRevertsDuringFunding() public {
        vm.prank(treasury);
        vm.expectRevert(Offering.NotFailed.selector);
        offering.refundAll(new address[](0));
    }

    function testSweepFailedUnitsRepeatable() public {
        vm.prank(buyer);
        offering.buyPublic(10, type(uint256).max, "");
        _fail();

        assertEq(offering.sweepFailedUnits(), 190, "first sweep");
        vm.prank(buyer);
        offering.refund();

        vm.expectEmit(true, false, false, true, address(offering));
        emit Offering.FailedUnitsSwept(treasury, 10);
        assertEq(offering.sweepFailedUnits(), 10, "second sweep");
        assertEq(token.balanceOf(treasury, 0), 200, "cumulative treasury units");

        vm.expectRevert(Offering.NothingToWithdraw.selector);
        offering.sweepFailedUnits();
    }

    function testSweepFailedUnitsRevertsDuringFunding() public {
        vm.expectRevert(Offering.NotFailed.selector);
        offering.sweepFailedUnits();
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

    function testSweepExcessUsdcSweepsOnlyExcess() public {
        vm.prank(buyer);
        uint256 cost = offering.buyPublic(100, type(uint256).max, "");
        usdc.mint(address(offering), 5e6); // e.g. split revenue pushed in by SplitMain.withdraw

        vm.prank(treasury);
        vm.expectEmit(false, false, false, true, address(offering));
        emit Offering.ExcessSwept(5e6);
        uint256 swept = offering.sweepExcessUsdc();
        assertEq(swept, 5e6, "swept excess only");
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
        vm.expectEmit(true, true, false, true, address(offering));
        emit Offering.Rescued(address(stray), treasury, 7e6);
        offering.rescue(address(stray), treasury);
        assertEq(stray.balanceOf(treasury), 7e6, "rescued");
    }

    function testRescueEth() public {
        vm.prank(treasury);
        vm.expectRevert(Offering.NothingToWithdraw.selector);
        offering.rescue(address(0), treasury);

        vm.deal(address(this), 1 ether);
        (bool ok,) = address(offering).call{value: 1 ether}(""); // e.g. SplitMain.withdraw pushing an ETH split share
        assertTrue(ok, "receive accepts ETH");

        vm.prank(treasury);
        vm.expectEmit(true, true, false, true, address(offering));
        emit Offering.Rescued(address(0), treasury, 1 ether);
        offering.rescue(address(0), treasury);
        assertEq(treasury.balance, 1 ether, "rescued");
        assertEq(address(offering).balance, 0, "swept");
    }

    function testTwoStepOwnershipHandover() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(newOwner);
        offering.requestOwnershipHandover();
        assertEq(offering.owner(), treasury, "owner unchanged until completed");

        vm.prank(buyer);
        vm.expectRevert(Ownable.Unauthorized.selector);
        offering.completeOwnershipHandover(newOwner);

        vm.prank(treasury);
        offering.completeOwnershipHandover(newOwner);
        assertEq(offering.owner(), newOwner, "handed over");
    }

    function testExpiredHandoverCannotComplete() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(newOwner);
        offering.requestOwnershipHandover();

        vm.warp(block.timestamp + 49 hours);
        vm.prank(treasury);
        vm.expectRevert(Ownable.NoHandoverRequest.selector);
        offering.completeOwnershipHandover(newOwner);
    }

    function testDirectTransferOwnership() public {
        address newOwner = makeAddr("newOwner");

        vm.prank(buyer);
        vm.expectRevert(Ownable.Unauthorized.selector);
        offering.transferOwnership(newOwner);

        vm.prank(treasury);
        offering.transferOwnership(newOwner);
        assertEq(offering.owner(), newOwner, "transferred");
    }

    function testWithdrawRevertsBeforeMinimum() public {
        vm.prank(buyer);
        offering.buyPublic(10, type(uint256).max, "");

        vm.expectRevert(Offering.MinimumNotMet.selector);
        offering.withdraw();
    }

    function testDoubleWithdrawNothingLeft() public {
        vm.prank(buyer);
        offering.buyPublic(100, type(uint256).max, "");
        offering.withdraw();
        uint256 treasuryBalance = usdc.balanceOf(treasury);

        vm.expectRevert(Offering.NothingToWithdraw.selector);
        offering.withdraw();
        assertEq(usdc.balanceOf(treasury), treasuryBalance, "treasury unchanged");
    }

    function testCloseRevertsBeforeMinimum() public {
        vm.prank(treasury);
        vm.expectRevert(Offering.MinimumNotMet.selector);
        offering.closeAndWithdraw();
    }

    function testDoubleCloseReverts() public {
        vm.prank(buyer);
        offering.buyPublic(100, type(uint256).max, "");
        vm.startPrank(treasury);
        offering.closeAndWithdraw();
        vm.expectRevert(Offering.NotFunding.selector);
        offering.closeAndWithdraw();
        vm.stopPrank();
    }

    /// A failed offering never met the minimum, so the minimum check fires
    /// before the state check.
    function testCloseAfterFailureReverts() public {
        _fail();
        vm.prank(treasury);
        vm.expectRevert(Offering.MinimumNotMet.selector);
        offering.closeAndWithdraw();
    }

    function testSetTreasuryRedirectsWithdraw() public {
        vm.prank(buyer);
        uint256 cost = offering.buyPublic(100, type(uint256).max, "");

        address vault = makeAddr("vault");
        vm.prank(treasury);
        vm.expectEmit(true, false, false, true, address(offering));
        emit Offering.TreasuryUpdated(vault);
        offering.setTreasury(vault);

        offering.withdraw();
        assertEq(usdc.balanceOf(vault), cost, "new treasury paid");
        assertEq(usdc.balanceOf(treasury), 0, "old treasury unpaid");
    }

    function testSetTreasuryRedirectsFailedSweep() public {
        address vault = makeAddr("vault");
        vm.prank(treasury);
        offering.setTreasury(vault);
        _fail();

        offering.sweepFailedUnits();
        assertEq(token.balanceOf(vault, 0), 200, "units to new treasury");
        assertEq(token.balanceOf(treasury, 0), 0, "none to old treasury");
    }

    function testSetTreasuryRejectsZeroAddress() public {
        vm.prank(treasury);
        vm.expectRevert(Offering.InvalidAddress.selector);
        offering.setTreasury(address(0));
    }

    function testRescueRejectsZeroRecipientAndEmptyBalance() public {
        MockUSDC stray = new MockUSDC();
        vm.startPrank(treasury);
        vm.expectRevert(Offering.InvalidAddress.selector);
        offering.rescue(address(stray), address(0));
        vm.expectRevert(Offering.NothingToWithdraw.selector);
        offering.rescue(address(stray), treasury);
        vm.stopPrank();
    }

    function testSweepExcessUsdcRevertsWithoutExcess() public {
        vm.prank(buyer);
        uint256 cost = offering.buyPublic(10, type(uint256).max, "");
        _fail();

        vm.prank(treasury);
        vm.expectRevert(Offering.NothingToWithdraw.selector);
        offering.sweepExcessUsdc();

        usdc.mint(address(offering), 5e6);
        vm.prank(treasury);
        assertEq(offering.sweepExcessUsdc(), 5e6, "swept excess");
        assertEq(usdc.balanceOf(address(offering)), cost, "liability intact");
    }

    function testOnlyOwnerFunctionsRejectNonOwner() public {
        vm.startPrank(buyer);
        vm.expectRevert(Ownable.Unauthorized.selector);
        offering.cancelAllocation(bytes32(0));
        vm.expectRevert(Ownable.Unauthorized.selector);
        offering.setPublicUnits(150);
        vm.expectRevert(Ownable.Unauthorized.selector);
        offering.refundAll(new address[](0));
        vm.expectRevert(Ownable.Unauthorized.selector);
        offering.closeAndWithdraw();
        vm.expectRevert(Ownable.Unauthorized.selector);
        offering.rescue(address(1), address(2));
        vm.expectRevert(Ownable.Unauthorized.selector);
        offering.sweepExcessUsdc();
        vm.expectRevert(Ownable.Unauthorized.selector);
        offering.setTreasury(address(1));
        vm.expectRevert(Ownable.Unauthorized.selector);
        offering.completeOwnershipHandover(address(1));
        vm.stopPrank();
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

    function testReceiverRejectsForeignToken() public {
        address[] memory holders = new address[](1);
        holders[0] = holder;
        uint32[] memory allocations = new uint32[](1);
        allocations[0] = 800;
        PactToken foreign =
            new PactToken(address(splitMain), "Foreign", holders, allocations, makeAddr("otherEscrow"), 200);

        vm.prank(holder);
        vm.expectRevert(Offering.InvalidAddress.selector);
        foreign.safeTransferFrom(holder, address(offering), 0, 10, "");
    }

    function testReceiverRejectsWrongTokenId() public {
        // Both hooks check the caller before the ids, so pose as the pact token.
        vm.prank(address(token));
        vm.expectRevert(Offering.BadTokenId.selector);
        offering.onERC1155Received(buyer, buyer, 1, 5, "");

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 5;
        vm.prank(address(token));
        vm.expectRevert(Offering.BadTokenId.selector);
        offering.onERC1155BatchReceived(buyer, buyer, ids, amounts, "");
    }

    function testReceiverRejectsSpoofedOperator() public {
        // A hostile 1155 supplies the operator argument itself; naming the
        // escrow as operator must not bypass the token check.
        vm.expectRevert(Offering.InvalidAddress.selector);
        offering.onERC1155Received(address(offering), buyer, 0, 5, "");

        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        vm.expectRevert(Offering.InvalidAddress.selector);
        offering.onERC1155BatchReceived(address(offering), buyer, ids, amounts, "");
    }

    function testBatchReceiveTopsUpDuringFunding() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 50;
        vm.prank(holder);
        token.safeBatchTransferFrom(holder, address(offering), ids, amounts, "");
        assertEq(offering.remainingUnits(), 250, "topped up");
    }

    function testBatchReceiveRejectedAfterFailureOrClose() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 50;

        _fail();
        vm.prank(holder);
        vm.expectRevert(Offering.ClosedOrFailed.selector);
        token.safeBatchTransferFrom(holder, address(offering), ids, amounts, "");

        // Fresh offering: buy to minimum, close, then try the same top-up.
        (address offeringAddress, address tokenAddress) = _create(100e6, 100);
        Offering closed = Offering(payable(offeringAddress));
        PactToken closedToken = PactToken(payable(tokenAddress));
        vm.startPrank(buyer);
        usdc.approve(address(closed), type(uint256).max);
        closed.buyPublic(100, type(uint256).max, "");
        vm.stopPrank();
        vm.prank(treasury);
        closed.closeAndWithdraw();

        vm.prank(holder);
        vm.expectRevert(Offering.ClosedOrFailed.selector);
        closedToken.safeBatchTransferFrom(holder, address(closed), ids, amounts, "");
    }

    function testReentrantBuyReverts() public {
        ReenterOnReceive attacker = new ReenterOnReceive();
        usdc.mint(address(attacker), 100e6);
        vm.prank(address(attacker));
        usdc.approve(address(offering), type(uint256).max);

        vm.expectRevert(ReentrancyGuard.Reentrancy.selector);
        attacker.attack(address(offering), 5);

        assertEq(offering.unitsSold(), 0, "sold unchanged");
        assertEq(offering.publicUnitsSold(), 0, "public sold unchanged");
    }

    function testInitializeOnlyFactoryAndOnlyOnce() public {
        vm.prank(buyer);
        vm.expectRevert(Offering.NotFactory.selector);
        offering.initialize(address(1));

        vm.prank(address(factory));
        vm.expectRevert(Ownable.AlreadyInitialized.selector);
        offering.initialize(address(1));
    }

    function testDirectDeployRejectsZeroTreasury() public {
        vm.expectRevert(Offering.InvalidAddress.selector);
        new Offering(100e6, uint64(block.timestamp + 7 days), 1e6, 1000, 100, address(0), address(this));
    }

    function testSupportsInterface() public view {
        assertTrue(offering.supportsInterface(0x01ffc9a7), "erc165");
        assertTrue(offering.supportsInterface(type(IERC1155Receiver).interfaceId), "receiver");
        assertFalse(offering.supportsInterface(0xdeadbeef), "unknown");
    }

    function testCapTableSumsAfterMixedLifecycle() public {
        vm.prank(buyer);
        offering.buyPublic(60, type(uint256).max, "");

        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);
        vm.prank(buyer2);
        offering.buyPrivate(voucher, ownerSig, claimSig, 50, type(uint256).max);

        vm.prank(treasury);
        offering.closeAndWithdraw();

        uint256 sum = uint256(token.scaledPercentBalanceOf(holder)) + token.scaledPercentBalanceOf(buyer)
            + token.scaledPercentBalanceOf(buyer2) + token.scaledPercentBalanceOf(treasury)
            + token.scaledPercentBalanceOf(address(offering));
        assertEq(sum, 1_000_000, "cap table sums to full scale");
    }
}
