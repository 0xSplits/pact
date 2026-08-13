// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Also consumed outside forge: tests/e2e-setup.ts etches these artifacts onto
// anvil, so this file's name is part of the artifact path it reads.
contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!blocked[to] && !blocked[msg.sender], "blocked");
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!blocked[to] && !blocked[from], "blocked");
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockSplitMain {
    uint256 private nonce;

    function createSplit(address[] calldata, uint32[] calldata, uint32, address) external returns (address) {
        return address(uint160(uint256(keccak256(abi.encode(address(this), ++nonce)))));
    }
}

/// @notice ERC-1271 wallet that approves digests explicitly and ignores the
/// signature bytes — from the verifier's side this is exactly what a
/// passkey/WebAuthn smart wallet looks like (an opaque, non-ECDSA blob).
contract MockERC1271Wallet {
    mapping(bytes32 => bool) public approved;

    function approveDigest(bytes32 digest) external {
        approved[digest] = true;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return approved[digest] ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
