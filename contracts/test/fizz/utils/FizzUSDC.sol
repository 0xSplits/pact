// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

/// @notice USDC mock for the fuzz harness — ABI-compatible with test/Mocks.sol's
/// MockUSDC but with `mint` and `transfer` gated to contract callers.
///
/// Medusa fuzzes every predeployed/deployed contract, including this token at
/// its hardcoded address, so without the gate the fuzzer calls `mint` directly
/// and creates USDC that the harness's conservation ghosts never see — a false
/// violation of the USDC-conservation invariants. Every legitimate mutation
/// comes through a contract: the Offering (transferFrom/transfer) or a handler
/// on the FuzzTester (mint for donation, setBlocked). A direct fuzz transaction
/// has `msg.sender == tx.origin` (an EOA sender); a contract-mediated call does
/// not. `approve` stays open because actors approve as EOAs during setup, and
/// `setBlocked` stays open because a directly-toggled blocklist is realistic and
/// the liveness properties already exclude blocked accounts.
contract FizzUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    // ponytail: an EOA fuzz sender has msg.sender == tx.origin; the harness and
    // the protocol always call through a contract, so this admits every real
    // mutation and rejects only the fuzzer poking the token directly.
    modifier onlyHarness() {
        require(msg.sender != tx.origin, "FizzUSDC: direct call");
        _;
    }

    function mint(address to, uint256 amount) external onlyHarness {
        balanceOf[to] += amount;
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external onlyHarness returns (bool) {
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
