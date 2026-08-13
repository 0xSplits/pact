// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";

contract PactTokenTest is BaseTest {
    function testTokenUriIsOnchainJson() public view {
        bytes memory prefix = "data:application/json;base64,";
        bytes memory result = bytes(token.uri(0));
        assertGt(result.length, prefix.length, "uri length");
        for (uint256 i = 0; i < prefix.length; i++) {
            assertEq(uint8(result[i]), uint8(prefix[i]), "uri prefix");
        }
    }
}
