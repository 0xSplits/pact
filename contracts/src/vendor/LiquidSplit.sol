// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ISplitMain} from "./ISplitMain.sol";

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

/// @title LiquidSplit
/// @notice An abstract liquid split base. Vendored from 0xSplits
/// splits-liquid-template (src/LiquidSplit.sol), commit c64201f, keeping
/// upstream's solady SafeTransferLib transfers (an earlier snapshot replaced
/// them with plain checked calls, which bricked void-return ERC-20s — audit
/// Finding 4). One deviation from upstream: `distributeFunds` is `public`
/// instead of `external` so an implementer can gate it and `super`-call.
/// @dev The implementer mints the 1155 supply and overrides
/// `scaledPercentBalanceOf`; if the percents passed to `distributeFunds` don't
/// sum to 1e6 the split fails to update and funds are stuck in `payoutSplit`.
abstract contract LiquidSplit {
    using SafeTransferLib for address;

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
        public
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
            payoutSplit.safeTransferETH(address(this).balance);
            splitMain.updateAndDistributeETH({
                split: payoutSplit,
                accounts: accounts,
                percentAllocations: percentAllocations,
                distributorFee: distributorFee(),
                distributorAddress: distributorAddress
            });
        } else {
            token.safeTransfer(payoutSplit, IERC20Balance(token).balanceOf(address(this)));
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
