// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Offering} from "./Offering.sol";
import {ERC1155} from "./vendor/ERC1155.sol";
import {LiquidSplit} from "./vendor/LiquidSplit.sol";

/**
 * @title PactToken
 * @author Splits
 * @notice The PACT cap table: a custom liquid split ERC-1155 whose 1000 units
 * of token id 0 are real claims on split proceeds via 0xSplits SplitMain.
 * @dev Total supply must stay exactly 1000 — LiquidSplit distributions revert
 * if percents don't sum to 1e6, so there is no burn path anywhere.
 */
contract PactToken is ERC1155, LiquidSplit {
    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       CUSTOM ERRORS                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev The holder allocations are invalid or don't sum to the fixed total.
    error InvalidAllocations();

    /// @dev Distribution is blocked while the offering is still Funding.
    error DistributionWhileFunding();

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         CONSTANTS                          */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev The single cap-table token id.
    uint256 public constant TOKEN_ID = 0;

    /// @dev Fixed unit supply; 1 unit = 0.1% of the cap table.
    uint256 public constant TOTAL_SUPPLY = 1000;

    /// @dev PERCENTAGE_SCALE / TOTAL_SUPPLY.
    uint32 public constant SUPPLY_TO_PERCENTAGE = 1000;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         IMMUTABLES                         */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev The escrow selling this token; a permanent operator.
    address public immutable offering;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                          STORAGE                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Display name rendered in the onchain metadata.
    string public projectName;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                        CONSTRUCTOR                         */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    constructor(
        address splitMain_,
        string memory projectName_,
        address[] memory holderAccounts,
        uint32[] memory holderAllocations,
        address offering_,
        uint256 offeringUnits
    ) LiquidSplit(splitMain_, 0) {
        if (holderAccounts.length != holderAllocations.length) revert InvalidAllocations();
        projectName = projectName_;
        offering = offering_;

        uint256 total = offeringUnits;
        _mint(offering_, TOKEN_ID, offeringUnits, "");
        for (uint256 i = 0; i < holderAccounts.length; i++) {
            // The factory's holder loop runs before this token exists, so the
            // self-mint check has to live here: units held by the token itself
            // would recirculate their own split share forever.
            if (holderAccounts[i] == address(this)) revert InvalidAllocations();
            total += holderAllocations[i];
            _mint(holderAccounts[i], TOKEN_ID, holderAllocations[i], "");
        }
        if (total != TOTAL_SUPPLY) revert InvalidAllocations();
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                      PUBLIC FUNCTIONS                      */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /**
     * @notice The offering escrow is a permanent operator, so a failed raise
     * can reclaim purchased units on refund without a per-buyer approval.
     */
    function isApprovedForAll(address owner, address operator) public view override returns (bool) {
        /// should offering being the operator only apply in the failed state (not sure if we can even detect that here)
        return operator == offering || super.isApprovedForAll(owner, operator);
    }

    /**
     * @notice Distribution is gated while the offering is still Funding: the
     * bonding curve prices units off `unitsSold` alone, so a mid-raise
     * distribution would let a buyer purchase revenue-blind units and
     * atomically capture banked revenue. Once the raise is Closed or Failed
     * the curve is dead and distribution is permissionless as usual. Residual
     * accepted: in Failed, revenue accrued before the failure stays
     * distributable by not-yet-refunded holders.
     */
    /**
    * would an event here be useful? just wondering if we'd ever want a way to watch for
    * these distributes (vs all other liquid split distributes). cause the funds end up in
    * splitmain, right? maybe we'd want to withdraw on behalf of recipients or something?
    * maybe not a priority for this mvp
    **/
    function distributeFunds(address token, address[] calldata accounts, address distributorAddress) public override {
        /// is it expected you can distributeFunds on a failed offering?
        if (Offering(payable(offering)).state() == Offering.State.Funding) revert DistributionWhileFunding();
        /// I think liquid split distributions are blocked if everything is owned by 1 account. probably fine...
        super.distributeFunds(token, accounts, distributorAddress);
    }

    /**
     * @notice Unit balance as a 0xSplits percentage (1 unit = 0.1% = 1000 on
     * the 1e6 scale).
     */
    function scaledPercentBalanceOf(address account) public view override returns (uint32) {
        unchecked {
            return uint32(balanceOf[account][TOKEN_ID] * SUPPLY_TO_PERCENTAGE);
        }
    }

    /**
     * @notice Fully onchain metadata: a base64 JSON data URI whose image is an
     * inline SVG of the project name.
     */
    function uri(uint256) public view override returns (string memory) {
        string memory svg = string.concat(
            "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600'>",
            "<rect width='100%' height='100%' fill='#101012'/>",
            "<text x='50%' y='47%' fill='#f4f1ea' font-family='Georgia,serif' font-size='36' text-anchor='middle'>",
            LibString.escapeHTML(projectName),
            "</text>",
            "<text x='50%' y='56%' fill='#8a877f' font-family='Georgia,serif' font-size='18' text-anchor='middle'>PACT community tokens</text>",
            "</svg>"
        );
        string memory json = string.concat(
            '{"name":"',
            LibString.escapeJSON(projectName),
            '","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
