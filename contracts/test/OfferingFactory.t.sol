// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {Offering} from "../src/Offering.sol";
import {OfferingFactory} from "../src/OfferingFactory.sol";
import {PactToken} from "../src/PactToken.sol";

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

    function testFactorySeparatesOwnerFromTreasury() public {
        address owner = makeAddr("distinctOwner");
        address[] memory holders = new address[](1);
        holders[0] = holder;
        uint32[] memory allocations = new uint32[](1);
        allocations[0] = 800;

        (address created,) = factory.createOffering(
            "Test Project",
            100e6,
            uint64(block.timestamp + 7 days),
            1e6,
            1000,
            100,
            treasury,
            owner,
            holders,
            allocations,
            200
        );
        assertEq(Offering(payable(created)).owner(), owner, "owner");
        assertEq(Offering(payable(created)).treasury(), treasury, "treasury");
    }

    function testFactoryAllowsEmptyHolders() public {
        (address created, address createdToken) = factory.createOffering(
            "Test Project",
            100e6,
            uint64(block.timestamp + 7 days),
            1e6,
            1000,
            100,
            treasury,
            treasury,
            new address[](0),
            new uint32[](0),
            1000
        );
        assertEq(PactToken(payable(createdToken)).balanceOf(created, 0), 1000, "full supply escrowed");
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

    function testFactoryPropagatesOfferingConstructorValidation() public {
        address[] memory holders = new address[](1);
        holders[0] = holder;
        uint32[] memory allocations = new uint32[](1);
        allocations[0] = 800;

        // closeDate not in the future
        vm.expectRevert(Offering.InvalidConfig.selector);
        factory.createOffering(
            "Test Project",
            100e6,
            uint64(block.timestamp),
            1e6,
            1000,
            100,
            treasury,
            treasury,
            holders,
            allocations,
            200
        );

        // zero priceStart
        vm.expectRevert(Offering.InvalidConfig.selector);
        factory.createOffering(
            "Test Project",
            100e6,
            uint64(block.timestamp + 7 days),
            0,
            1000,
            100,
            treasury,
            treasury,
            holders,
            allocations,
            200
        );
    }

    function testFactoryRejectsZeroAllocation() public {
        address[] memory holders = new address[](2);
        holders[0] = holder;
        holders[1] = buyer;
        uint32[] memory allocations = new uint32[](2);
        allocations[0] = 800;
        allocations[1] = 0;

        vm.expectRevert(OfferingFactory.InvalidAllocations.selector);
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

    function testPactTokenRejectsSelfMint() public {
        // The PactToken address is predictable (factory nonce), so a creator
        // could pass it as a holder; setUp deployed two contracts, so the next
        // pair is nonces 3 (offering) and 4 (token).
        address predictedToken = vm.computeCreateAddress(address(factory), 4);
        address[] memory holders = new address[](1);
        holders[0] = predictedToken;
        uint32[] memory allocations = new uint32[](1);
        allocations[0] = 800;

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

    function testOfferingCreatedEventPayload() public {
        // setUp already made the factory deploy two contracts, so its nonce is 3.
        address predictedOffering = vm.computeCreateAddress(address(factory), 3);
        address predictedToken = vm.computeCreateAddress(address(factory), 4);

        vm.expectEmit(true, true, true, true, address(factory));
        emit OfferingFactory.OfferingCreated(
            address(this),
            treasury,
            predictedOffering,
            predictedToken,
            "Test Project",
            100e6,
            uint64(block.timestamp + 7 days),
            1e6,
            1000,
            100
        );
        (address created, address createdToken) = _create(100e6, 100);
        assertEq(created, predictedOffering, "offering address");
        assertEq(createdToken, predictedToken, "token address");
    }
}
