// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {PactToken} from "../src/PactToken.sol";
import {MockVoidToken} from "./Mocks.sol";

contract PactTokenTest is BaseTest {
    function _holders() internal view returns (address[] memory accounts) {
        accounts = new address[](2);
        accounts[0] = holder;
        accounts[1] = buyer;
    }

    function testDistributeFundsRevertsWhileFunding() public {
        usdc.mint(address(token), 50e6);
        vm.expectRevert(PactToken.DistributionWhileFunding.selector);
        token.distributeFunds(USDC_ADDRESS, _holders(), address(this));
    }

    function testDistributeFundsSucceedsOnceClosed() public {
        vm.prank(buyer);
        offering.buyPublic(100, type(uint256).max, "");
        vm.prank(treasury);
        offering.closeAndWithdraw();

        usdc.mint(address(token), 50e6);
        vm.expectEmit(true, true, false, true, address(token));
        emit PactToken.FundsDistributed(USDC_ADDRESS, address(this));
        token.distributeFunds(USDC_ADDRESS, _holders(), address(this));
        assertEq(usdc.balanceOf(token.payoutSplit()), 50e6, "revenue reaches payout split");
    }

    function testDistributeFundsSucceedsWhenFailed() public {
        _fail();
        vm.deal(address(token), 1 ether);
        token.distributeFunds(address(0), _holders(), address(this));
        assertEq(token.payoutSplit().balance, 1 ether, "eth reaches payout split");
    }

    function testDistributeFundsHandlesVoidReturnToken() public {
        MockVoidToken usdt = new MockVoidToken();
        usdt.mint(address(token), 77e6);
        _fail();
        token.distributeFunds(address(usdt), _holders(), address(this));
        assertEq(usdt.balanceOf(token.payoutSplit()), 77e6, "void-return token reaches payout split");
    }

    function testTotalSupplyGuardRejectsBadSums() public {
        address[] memory holders = new address[](1);
        holders[0] = holder;
        uint32[] memory allocations = new uint32[](1);

        // 700 + 200 = 900
        allocations[0] = 700;
        vm.expectRevert(PactToken.InvalidAllocations.selector);
        factory.createOffering(
            "Test Project",
            100e6,
            uint64(block.timestamp + 7 days),
            1e6,
            1000,
            100,
            treasury,
            treasury,
            holders,
            allocations,
            200
        );

        // 900 + 200 = 1100
        allocations[0] = 900;
        vm.expectRevert(PactToken.InvalidAllocations.selector);
        factory.createOffering(
            "Test Project",
            100e6,
            uint64(block.timestamp + 7 days),
            1e6,
            1000,
            100,
            treasury,
            treasury,
            holders,
            allocations,
            200
        );
    }

    function testTokenUriIsOnchainJson() public view {
        bytes memory prefix = "data:application/json;base64,";
        bytes memory result = bytes(token.uri(0));
        assertGt(result.length, prefix.length, "uri length");
        for (uint256 i = 0; i < prefix.length; i++) {
            assertEq(uint8(result[i]), uint8(prefix[i]), "uri prefix");
        }
    }
}
