// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

// Vendored from 0xSplits splits-liquid-template (src/interfaces/ISplitMain.sol),
// commit c64201f. License header kept intact — the interface is copied from the
// GPL-3.0 splits-contracts repo.
interface ISplitMain {
    function createSplit(
        address[] calldata accounts,
        uint32[] calldata percentAllocations,
        uint32 distributorFee,
        address controller
    ) external returns (address);

    function updateAndDistributeETH(
        address split,
        address[] calldata accounts,
        uint32[] calldata percentAllocations,
        uint32 distributorFee,
        address distributorAddress
    ) external;

    function updateAndDistributeERC20(
        address split,
        address token,
        address[] calldata accounts,
        uint32[] calldata percentAllocations,
        uint32 distributorFee,
        address distributorAddress
    ) external;

    function withdraw(address account, uint256 withdrawETH, address[] calldata tokens) external;
}
