// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {OfferingFactory} from "../src/OfferingFactory.sol";

/// @notice Deploys the OfferingFactory to Base via `npm run deploy:factory`.
/// @dev CREATE2 through forge's canonical deterministic deployer, so the
/// address is reproducible from (salt, init code). After deploying, pin the
/// address and deploy block in src/generated/offering-contracts.ts from the
/// broadcast output.
contract Deploy is Script {
    /// @dev Canonical 0xSplits SplitMain v1 on Base (same address on mainnet, Polygon, etc.).
    address internal constant SPLIT_MAIN = 0x2ed6c4B5dA6378c7897AC67Ba9e43102Feb694EE;

    bytes32 internal constant SALT = bytes32("PACT OfferingFactory v2");

    function run() external returns (OfferingFactory factory) {
        vm.startBroadcast();
        factory = new OfferingFactory{salt: SALT}(SPLIT_MAIN);
        vm.stopBroadcast();
    }
}
