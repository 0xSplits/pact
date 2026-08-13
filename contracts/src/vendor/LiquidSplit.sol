// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISplitMain} from "./ISplitMain.sol";

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title LiquidSplit
/// @notice An abstract liquid split base. Vendored from 0xSplits
/// splits-liquid-template (src/LiquidSplit.sol), commit c64201f, with the
/// solady SafeTransferLib calls replaced by plain checked calls.
/// @dev The implementer mints the 1155 supply and overrides
/// `scaledPercentBalanceOf`; if the percents passed to `distributeFunds` don't
/// sum to 1e6 the split fails to update and funds are stuck in `payoutSplit`.
abstract contract LiquidSplit {
    error TransferFailed();

    /// @notice funds have been received
    event ReceiveETH(uint256 amount);

    event CreateLiquidSplit(address indexed payoutSplit);

    uint256 public constant PERCENTAGE_SCALE = 1e6;

    ISplitMain public immutable splitMain;
    uint32 public immutable _distributorFee;
    address public immutable payoutSplit;

    constructor(address _splitMain, uint32 __distributorFee) {
        splitMain = ISplitMain(_splitMain);
        _distributorFee = __distributorFee;

        // create dummy mutable split with this contract as controller;
        // recipients & distributorFee will be updated on first distribution
        address[] memory recipients = new address[](2);
        recipients[0] = address(0);
        recipients[1] = address(1);
        uint32[] memory initPercentAllocations = new uint32[](2);
        initPercentAllocations[0] = uint32(500000);
        initPercentAllocations[1] = uint32(500000);
        payoutSplit = payable(
            ISplitMain(_splitMain).createSplit({
                accounts: recipients,
                percentAllocations: initPercentAllocations,
                distributorFee: __distributorFee,
                controller: address(this)
            })
        );

        emit CreateLiquidSplit(payoutSplit);
    }

    /// @notice receive ETH
    receive() external payable virtual {
        emit ReceiveETH(msg.value);
    }

    /// @notice distributes ETH & ERC20s to NFT holders
    /// @param token ETH (0x0) or ERC20 token to distribute
    /// @param accounts Ordered, unique list of NFT holders
    /// @param distributorAddress Address to receive distributorFee
    function distributeFunds(address token, address[] calldata accounts, address distributorAddress)
        external
        virtual
    {
        uint256 numRecipients = accounts.length;
        uint32[] memory percentAllocations = new uint32[](numRecipients);
        for (uint256 i; i < numRecipients;) {
            percentAllocations[i] = scaledPercentBalanceOf(accounts[i]);
            unchecked {
                ++i;
            }
        }

        // atomically deposit funds into split, update recipients to reflect
        // current NFT holders, and distribute
        if (token == address(0)) {
            payoutSplit.call{value: address(this).balance}("");
            splitMain.updateAndDistributeETH({
                split: payoutSplit,
                accounts: accounts,
                percentAllocations: percentAllocations,
                distributorFee: distributorFee(),
                distributorAddress: distributorAddress
            });
        } else {
            uint256 balance = IERC20Balance(token).balanceOf(address(this));
            if (balance > 0 && !IERC20Balance(token).transfer(payoutSplit, balance)) revert TransferFailed();
            splitMain.updateAndDistributeERC20({
                split: payoutSplit,
                token: token,
                accounts: accounts,
                percentAllocations: percentAllocations,
                distributorFee: distributorFee(),
                distributorAddress: distributorAddress
            });
        }
    }

    function scaledPercentBalanceOf(address account) public view virtual returns (uint32) {}

    function distributorFee() public view virtual returns (uint32) {
        return _distributorFee;
    }
}
