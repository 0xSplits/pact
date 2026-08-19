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

    function updateAndDistributeETH(address, address[] calldata, uint32[] calldata, uint32, address) external {}

    function updateAndDistributeERC20(address, address, address[] calldata, uint32[] calldata, uint32, address)
        external {}
}

/// @notice USDT-family ERC-20 whose transfer returns nothing — reverts any
/// caller that ABI-decodes a bool from it (audit Finding 4's trigger).
contract MockVoidToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
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

interface IOfferingBuy {
    function buyPublic(uint256 unitsWanted, uint256 maxCost, string calldata buyerName) external returns (uint256);
}

/// @notice Buyer whose ERC-1155 receive hook re-enters the offering's buy,
/// probing the nonReentrant guard from inside the unit-delivery callback.
contract ReenterOnReceive {
    address private target;

    function attack(address offering, uint256 units) external {
        target = offering;
        IOfferingBuy(offering).buyPublic(units, type(uint256).max, "");
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        IOfferingBuy(target).buyPublic(1, type(uint256).max, "");
        return this.onERC1155Received.selector;
    }
}
