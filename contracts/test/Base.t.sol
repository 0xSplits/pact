// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Offering} from "../src/Offering.sol";
import {OfferingFactory} from "../src/OfferingFactory.sol";
import {PactToken} from "../src/PactToken.sol";
import {MockUSDC, MockSplitMain} from "./Mocks.sol";

/// @notice Shared fixture: mock USDC etched at the Base mainnet address, a
/// factory, and one offering (100 USDC minimum, 100 public units, 200-unit
/// escrow) with funded, approved buyers.
contract BaseTest is Test {
    address internal constant USDC_ADDRESS = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    uint256 internal constant OWNER_KEY = 1;
    uint256 internal constant LINK_KEY = 2;

    MockUSDC internal usdc;
    MockSplitMain internal splitMain;
    OfferingFactory internal factory;
    Offering internal offering;
    PactToken internal token;

    address internal treasury;
    address internal holder;
    address internal buyer;
    address internal buyer2;

    function setUp() public virtual {
        treasury = vm.addr(OWNER_KEY);
        vm.label(treasury, "treasury");
        holder = makeAddr("holder");
        buyer = makeAddr("buyer");
        buyer2 = makeAddr("buyer2");

        MockUSDC impl = new MockUSDC();
        vm.etch(USDC_ADDRESS, address(impl).code);
        usdc = MockUSDC(USDC_ADDRESS);
        splitMain = new MockSplitMain();
        factory = new OfferingFactory(address(splitMain));

        (address offeringAddress, address tokenAddress) = _create(100e6, 100);
        offering = Offering(payable(offeringAddress));
        token = PactToken(payable(tokenAddress));

        usdc.mint(buyer, 1_000e6);
        usdc.mint(buyer2, 1_000e6);
        vm.prank(buyer);
        usdc.approve(address(offering), type(uint256).max);
        vm.prank(buyer2);
        usdc.approve(address(offering), type(uint256).max);
    }

    function _create(uint256 raiseMin, uint256 publicUnits) internal returns (address, address) {
        address[] memory holders = new address[](1);
        holders[0] = holder;
        uint32[] memory allocations = new uint32[](1);
        allocations[0] = 800;
        return factory.createOffering(
            "Test Project",
            raiseMin,
            uint64(block.timestamp + 7 days),
            1e6,
            1000,
            publicUnits,
            treasury,
            treasury,
            holders,
            allocations,
            200
        );
    }

    function _voucher(string memory buyerName, uint256 cap) internal view returns (Offering.Voucher memory) {
        return Offering.Voucher({
            allocationId: keccak256(abi.encode(buyerName, cap)),
            buyerName: buyerName,
            amountCapUsdc: cap,
            linkKey: vm.addr(LINK_KEY)
        });
    }

    function _ownerSig(Offering target, Offering.Voucher memory voucher) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, target.voucherDigest(voucher));
        return abi.encodePacked(r, s, v);
    }

    function _claimSig(Offering target, bytes32 allocationId, address claimer) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(LINK_KEY, target.claimDigest(allocationId, claimer));
        return abi.encodePacked(r, s, v);
    }

    function _fail() internal {
        vm.warp(block.timestamp + 8 days);
        offering.markFailed();
    }
}
