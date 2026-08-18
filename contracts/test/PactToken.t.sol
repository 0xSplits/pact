// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {PactToken} from "../src/PactToken.sol";

contract PactTokenTest is BaseTest {
    function testTotalSupplyGuardRejectsBadSums() public {
        address[] memory holders = new address[](1);
        holders[0] = holder;
        uint32[] memory allocations = new uint32[](1);

        // 700 + 200 = 900
        allocations[0] = 700;
        vm.expectRevert(PactToken.InvalidAllocations.selector);
        factory.createOffering(
            "Test Project", 100e6, uint64(block.timestamp + 7 days), 1e6, 1000, 100, treasury, holders, allocations, 200
        );

        // 900 + 200 = 1100
        allocations[0] = 900;
        vm.expectRevert(PactToken.InvalidAllocations.selector);
        factory.createOffering(
            "Test Project", 100e6, uint64(block.timestamp + 7 days), 1e6, 1000, 100, treasury, holders, allocations, 200
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
