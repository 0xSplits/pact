// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

contract PayoutSplitStub {
    receive() external payable {}
}

/// @notice Mimics the SplitMain behavior the protocol relies on: percent
/// vectors must be nonzero and sum to 1e6, else distribution reverts and
/// funds stay in the payout split (see PactToken I-11/I-12).
contract MockSplitMain {
    uint256 public constant PERCENTAGE_SCALE = 1e6;

    function createSplit(address[] calldata accounts, uint32[] calldata percentAllocations, uint32, address)
        external
        returns (address)
    {
        _validAccounts(accounts);
        _validate(percentAllocations);
        return address(new PayoutSplitStub());
    }

    function updateAndDistributeETH(
        address,
        address[] calldata accounts,
        uint32[] calldata percentAllocations,
        uint32,
        address
    ) external {
        require(accounts.length == percentAllocations.length, "SplitMain: length mismatch");
        _validAccounts(accounts);
        _validate(percentAllocations);
    }

    function updateAndDistributeERC20(
        address,
        address,
        address[] calldata accounts,
        uint32[] calldata percentAllocations,
        uint32,
        address
    ) external {
        require(accounts.length == percentAllocations.length, "SplitMain: length mismatch");
        _validAccounts(accounts);
        _validate(percentAllocations);
    }

    // ponytail: mirrors real SplitMain._validSplit — accounts must number at
    // least two and be strictly ascending (sorted, no duplicates). Makes GL-20
    // falsifiable (a cap table collapsing to one holder reverts distribution,
    // as on mainnet) and SP-29's liveness as strong as real SplitMain.
    function _validAccounts(address[] calldata accounts) private pure {
        require(accounts.length > 1, "SplitMain: too few accounts");
        for (uint256 i; i + 1 < accounts.length; i++) {
            require(accounts[i] < accounts[i + 1], "SplitMain: accounts not sorted unique");
        }
    }

    // ponytail: validates only nonzero + sum==1e6 — the checks the protocol's
    // invariants lean on; account ordering is enforced by _validAccounts.
    function _validate(uint32[] calldata percents) private pure {
        uint256 sum;
        for (uint256 i; i < percents.length; i++) {
            require(percents[i] != 0, "SplitMain: zero allocation");
            sum += percents[i];
        }
        require(sum == PERCENTAGE_SCALE, "SplitMain: invalid sum");
    }
}
