// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Offering} from "./Offering.sol";
import {PactToken} from "./PactToken.sol";

/// @title OfferingFactory
/// @notice Atomically creates a PACT Offering and its PactToken cap table.
/// @dev A pure deployer with no registry — listings come from chunked
/// `OfferingCreated` event scans, so the event carries everything a listing
/// renders (including the project name). If any step fails, the whole
/// transaction reverts and no partial offering/token pair is left behind.
contract OfferingFactory {
    address public immutable splitMain;

    event OfferingCreated(
        address indexed issuer,
        address indexed treasury,
        address indexed offering,
        address pactToken,
        string projectName,
        uint256 raiseMin,
        uint64 closeDate,
        uint256 priceStart,
        uint256 priceSlope,
        uint256 publicUnits
    );

    error InvalidAddress();
    error InvalidAllocations();
    error InvalidConfig();

    constructor(address splitMain_) {
        if (splitMain_ == address(0)) revert InvalidAddress();
        splitMain = splitMain_;
    }

    /// @notice Creates an Offering and PactToken in one transaction.
    /// @param projectName Display name, stored on the token and emitted for listings.
    /// @param raiseMin Minimum successful raise in USDC base units.
    /// @param closeDate Buyer-protection deadline.
    /// @param priceStart Price of the first unit.
    /// @param priceSlope Price increase per unit sold.
    /// @param publicUnits Cap on public-tranche sales; the rest of the offering
    /// is claimable only via owner-signed allocation vouchers.
    /// @param treasury Treasury and initial owner/admin for the offering.
    /// @param holderAccounts Non-offering token recipients.
    /// @param holderAllocations Unit allocations matching `holderAccounts`.
    /// @param offeringUnits Units minted directly to the new Offering.
    function createOffering(
        string calldata projectName,
        uint256 raiseMin,
        uint64 closeDate,
        uint256 priceStart,
        uint256 priceSlope,
        uint256 publicUnits,
        address treasury,
        address[] calldata holderAccounts,
        uint32[] calldata holderAllocations,
        uint32 offeringUnits
    ) external returns (address offering, address pactToken) {
        if (treasury == address(0)) revert InvalidAddress();
        if (holderAccounts.length == 0 || holderAccounts.length != holderAllocations.length || offeringUnits == 0) {
            revert InvalidAllocations();
        }
        if (publicUnits > offeringUnits) revert InvalidConfig();

        offering = address(new Offering(raiseMin, closeDate, priceStart, priceSlope, publicUnits, treasury, treasury));
        // An impossible raise is undeployable: the minimum must be reachable by
        // selling out the integer curve (audit M-5).
        if (raiseMin > Offering(payable(offering)).costFor(0, offeringUnits)) revert InvalidConfig();

        for (uint256 i = 0; i < holderAccounts.length; i++) {
            if (holderAccounts[i] == address(0) || holderAccounts[i] == offering) revert InvalidAllocations();
            // A zero allocation mints nothing but still emits TransferSingle,
            // polluting the event-scan-derived holder lists the app relies on.
            if (holderAllocations[i] == 0) revert InvalidAllocations();
        }
        // PactToken validates the 1000-unit total and mints offeringUnits to the escrow.
        pactToken =
            address(new PactToken(splitMain, projectName, holderAccounts, holderAllocations, offering, offeringUnits));
        Offering(payable(offering)).initialize(pactToken);

        emit OfferingCreated(
            msg.sender,
            treasury,
            offering,
            pactToken,
            projectName,
            raiseMin,
            closeDate,
            priceStart,
            priceSlope,
            publicUnits
        );
    }
}
