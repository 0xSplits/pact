// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, Offering} from "./Offering.sol";

interface ILiquidSplitFactory {
    function createLiquidSplitClone(
        address[] calldata accounts,
        uint32[] calldata initAllocations,
        uint32 distributorFee,
        address owner
    ) external returns (address liquidSplit);
}

/// @title OfferingFactory
/// @notice Atomically creates a PACT Offering and its backing 0xSplits Liquid Split.
/// @dev This avoids a brittle three-wallet-prompt flow. If any step fails, the whole
/// transaction reverts and no partial offering/liquid-split pair is left behind.
contract OfferingFactory {
    uint32 public constant ZERO_DISTRIBUTOR_FEE = 0;

    ILiquidSplitFactory public immutable liquidSplitFactory;

    event OfferingCreated(
        address indexed issuer,
        address indexed treasury,
        address indexed offering,
        address liquidSplit,
        address paymentToken,
        uint256 raiseMin,
        uint64 closeDate,
        uint256 priceStart,
        uint256 priceSlope
    );

    error InvalidAddress();
    error InvalidAllocations();

    constructor(ILiquidSplitFactory liquidSplitFactory_) {
        if (address(liquidSplitFactory_) == address(0)) revert InvalidAddress();
        liquidSplitFactory = liquidSplitFactory_;
    }

    /// @notice Creates an Offering and Liquid Split in one transaction.
    /// @param paymentToken USDC token used for purchases.
    /// @param raiseMin Minimum successful raise in payment token base units.
    /// @param closeDate Buyer-protection deadline.
    /// @param priceStart Price of the first Liquid Split unit.
    /// @param priceSlope Price increase per unit sold.
    /// @param treasury Treasury and initial owner/admin for the offering and Liquid Split.
    /// @param holderAccounts Non-offering Liquid Split recipients.
    /// @param holderAllocations Liquid Split unit allocations matching `holderAccounts`.
    /// @param offeringUnits Liquid Split units minted directly to the new Offering.
    function createOffering(
        IERC20 paymentToken,
        uint256 raiseMin,
        uint64 closeDate,
        uint256 priceStart,
        uint256 priceSlope,
        address treasury,
        address[] calldata holderAccounts,
        uint32[] calldata holderAllocations,
        uint32 offeringUnits
    ) external returns (address offering, address liquidSplit) {
        if (treasury == address(0)) revert InvalidAddress();
        if (holderAccounts.length == 0 || holderAccounts.length != holderAllocations.length || offeringUnits == 0) {
            revert InvalidAllocations();
        }

        offering = address(new Offering(paymentToken, raiseMin, closeDate, priceStart, priceSlope, treasury, address(this)));

        address[] memory accounts = new address[](holderAccounts.length + 1);
        uint32[] memory initAllocations = new uint32[](holderAllocations.length + 1);
        uint256 total = offeringUnits;
        for (uint256 i = 0; i < holderAccounts.length; i++) {
            if (holderAccounts[i] == address(0) || holderAccounts[i] == offering) revert InvalidAllocations();
            accounts[i] = holderAccounts[i];
            initAllocations[i] = holderAllocations[i];
            total += holderAllocations[i];
        }
        accounts[holderAccounts.length] = offering;
        initAllocations[holderAllocations.length] = offeringUnits;
        if (total != 1000) revert InvalidAllocations();

        liquidSplit =
            liquidSplitFactory.createLiquidSplitClone(accounts, initAllocations, ZERO_DISTRIBUTOR_FEE, treasury);
        Offering(offering).initialize(liquidSplit);
        Offering(offering).transferOwnership(treasury);

        emit OfferingCreated(
            msg.sender, treasury, offering, liquidSplit, address(paymentToken), raiseMin, closeDate, priceStart, priceSlope
        );
    }
}
