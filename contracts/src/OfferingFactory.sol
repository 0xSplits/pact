// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Offering} from "./Offering.sol";
import {PactToken} from "./PactToken.sol";

/**
 * @title OfferingFactory
 * @author Splits
 * @notice Atomically creates a PACT Offering and its PactToken cap table.
 * @dev A pure deployer with no registry — listings come from chunked
 * `OfferingCreated` event scans, so the event carries everything a listing
 * renders (including the project name). If any step fails, the whole
 * transaction reverts and no partial offering/token pair is left behind.
 */
contract OfferingFactory {
    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       CUSTOM ERRORS                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev The address is zero.
    error InvalidAddress();

    /// @dev The holder allocation set is invalid.
    error InvalidAllocations();

    /// @dev The raise configuration is invalid.
    error InvalidConfig();

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                           EVENTS                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Emitted when an offering and its cap table are created.
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

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         IMMUTABLES                         */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @notice Canonical 0xSplits SplitMain v1 every PactToken pays through.
    address public immutable splitMain;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                        CONSTRUCTOR                         */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @param splitMain_ Address of SplitMain.
    constructor(address splitMain_) {
        if (splitMain_ == address(0)) revert InvalidAddress();
        splitMain = splitMain_;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                     EXTERNAL FUNCTIONS                     */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /**
     * @notice Creates an Offering and PactToken in one transaction.
     * @param projectName Display name, stored on the token and emitted for listings.
     * @param raiseMin Minimum successful raise in USDC base units.
     * @param closeDate Buyer-protection deadline.
     * @param priceStart Price of the first unit.
     * @param priceSlope Price increase per unit sold.
     * @param publicUnits Cap on public-tranche sales; the rest of the offering
     * is claimable only via owner-signed allocation vouchers.
     * @param treasury Receives withdrawals and unsold units.
     * @param owner Signs vouchers and administers the offering; may equal `treasury`.
     * @param holderAccounts Non-offering token recipients; may be empty when
     * the full supply is offered.
     * @param holderAllocations Unit allocations matching `holderAccounts`.
     * @param offeringUnits Units minted directly to the new Offering.
     * @return offering The new Offering escrow; the id every app route and tool takes.
     * @return pactToken The new PactToken cap table bound to `offering`.
     */
    function createOffering(
        string calldata projectName,
        uint256 raiseMin,
        uint64 closeDate,
        uint256 priceStart,
        uint256 priceSlope,
        uint256 publicUnits,
        address treasury,
        address owner,
        address[] calldata holderAccounts,
        uint32[] calldata holderAllocations,
        uint32 offeringUnits
    ) external returns (address offering, address pactToken) {
        if (treasury == address(0) || owner == address(0)) revert InvalidAddress();

        if (holderAccounts.length != holderAllocations.length || offeringUnits == 0) {
            revert InvalidAllocations();
        }

        if (publicUnits > offeringUnits) revert InvalidConfig();

        offering = address(new Offering(raiseMin, closeDate, priceStart, priceSlope, publicUnits, treasury, owner));

        // An impossible raise is undeployable: the minimum must be reachable by
        // selling out the integer curve.
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
