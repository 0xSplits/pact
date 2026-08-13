// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {OfferingFactory} from "../src/OfferingFactory.sol";

contract OfferingFactoryTest is BaseTest {
    function testFactoryCreatesOfferingAndToken() public view {
        assertEq(offering.pactToken(), address(token), "initialized");
        assertEq(offering.owner(), treasury, "owner");
        assertEq(offering.treasury(), treasury, "treasury");
        assertEq(offering.publicUnits(), 100, "public units");
        assertEq(token.balanceOf(address(offering), 0), 200, "offering units");
        assertEq(token.balanceOf(holder, 0), 800, "holder units");
        assertEq(token.offering(), address(offering), "token offering");
        assertTrue(token.isApprovedForAll(buyer, address(offering)), "escrow operator");
        assertEq(token.scaledPercentBalanceOf(holder), 800_000, "scaled percent");
        assertTrue(token.payoutSplit() != address(0), "payout split");
        assertEq(token.projectName(), "Test Project", "name");
    }

    function testFactoryRejectsImpossibleMinimum() public {
        // costFor(0, 200) = 200e6 + 1000 * (200*199/2) = 219.9e6
        vm.expectRevert(OfferingFactory.InvalidConfig.selector);
        _create(220e6, 100);
    }

    function testFactoryRejectsPublicUnitsOverOffering() public {
        vm.expectRevert(OfferingFactory.InvalidConfig.selector);
        _create(100e6, 201);
    }
}
