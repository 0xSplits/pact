// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {ERC1155} from "./vendor/ERC1155.sol";
import {LiquidSplit} from "./vendor/LiquidSplit.sol";

/// @title PactToken
/// @notice The PACT cap table: a custom liquid split ERC-1155 whose 1000 units
/// of token id 0 are real claims on split proceeds via 0xSplits SplitMain.
/// Metadata is fully onchain so wallets and marketplaces render the project
/// without any server.
/// @dev Total supply must stay exactly 1000 — LiquidSplit distributions revert
/// if percents don't sum to 1e6, so there is no burn path anywhere.
contract PactToken is ERC1155, LiquidSplit {
    uint256 public constant TOKEN_ID = 0;
    uint256 public constant TOTAL_SUPPLY = 1000;
    uint32 public constant SUPPLY_TO_PERCENTAGE = 1000; // PERCENTAGE_SCALE / TOTAL_SUPPLY

    string public projectName;
    address public immutable offering;

    error InvalidAllocations();

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
            total += holderAllocations[i];
            _mint(holderAccounts[i], TOKEN_ID, holderAllocations[i], "");
        }
        if (total != TOTAL_SUPPLY) revert InvalidAllocations();
    }

    /// @notice The offering escrow is a permanent operator, so a failed raise
    /// can reclaim purchased units on refund without a per-buyer approval.
    function isApprovedForAll(address owner, address operator) public view override returns (bool) {
        return operator == offering || super.isApprovedForAll(owner, operator);
    }

    /// @notice Unit balance as a 0xSplits percentage (1 unit = 0.1% = 1000 on
    /// the 1e6 scale).
    function scaledPercentBalanceOf(address account) public view override returns (uint32) {
        unchecked {
            return uint32(balanceOf[account][TOKEN_ID] * SUPPLY_TO_PERCENTAGE);
        }
    }

    /// @notice Fully onchain metadata: a base64 JSON data URI whose image is an
    /// inline SVG of the project name, so wallets render without any server.
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
