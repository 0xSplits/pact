// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1155Receiver, Offering} from "../src/Offering.sol";
import {OfferingFactory} from "../src/OfferingFactory.sol";
import {PactToken} from "../src/PactToken.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes4) external;
    function etch(address, bytes calldata) external;
    function chainId(uint256) external;
    function addr(uint256) external pure returns (address);
    function sign(uint256, bytes32) external pure returns (uint8, bytes32, bytes32);
    function readFile(string calldata) external view returns (string memory);
    function parseJsonUint(string calldata, string calldata) external pure returns (uint256);
    function parseJsonAddress(string calldata, string calldata) external pure returns (address);
    function parseJsonBytes32(string calldata, string calldata) external pure returns (bytes32);
    function parseJsonString(string calldata, string calldata) external pure returns (string memory);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
}

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

contract OfferingTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant USDC_ADDRESS = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    uint256 internal constant OWNER_KEY = 1;
    uint256 internal constant LINK_KEY = 2;

    MockUSDC internal usdc;
    MockSplitMain internal splitMain;
    OfferingFactory internal factory;
    Offering internal offering;
    PactToken internal token;

    address internal treasury;
    address internal holder = address(0x1234);
    address internal buyer = address(0xB0B);
    address internal buyer2 = address(0xCAFE);

    function setUp() public {
        treasury = vm.addr(OWNER_KEY);
        MockUSDC impl = new MockUSDC();
        vm.etch(USDC_ADDRESS, address(impl).code);
        usdc = MockUSDC(USDC_ADDRESS);
        splitMain = new MockSplitMain();
        factory = new OfferingFactory(address(splitMain));

        (address offeringAddress, address tokenAddress) = _create(100e6, 100);
        offering = Offering(offeringAddress);
        token = PactToken(payable(tokenAddress));

        usdc.mint(buyer, 1_000e6);
        usdc.mint(buyer2, 1_000e6);
        vm.prank(buyer);
        usdc.approve(address(offering), type(uint256).max);
        vm.prank(buyer2);
        usdc.approve(address(offering), type(uint256).max);
    }

    function _create(uint256 raiseMin, uint256 publicUnits) internal returns (address, address) {
        address[] memory holders = new address[](1);
        holders[0] = holder;
        uint32[] memory allocations = new uint32[](1);
        allocations[0] = 800;
        return factory.createOffering(
            "Test Project", raiseMin, uint64(block.timestamp + 7 days), 1e6, 1000, publicUnits, treasury, holders, allocations, 200
        );
    }

    function _voucher(string memory buyerName, uint256 cap) internal pure returns (Offering.Voucher memory) {
        return Offering.Voucher({
            allocationId: keccak256(abi.encode(buyerName, cap)),
            buyerName: buyerName,
            amountCapUsdc: cap,
            linkKey: vm.addr(LINK_KEY)
        });
    }

    function _ownerSig(Offering target, Offering.Voucher memory voucher) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, target.voucherDigest(voucher));
        return abi.encodePacked(r, s, v);
    }

    function _claimSig(Offering target, bytes32 allocationId, address claimer) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(LINK_KEY, target.claimDigest(allocationId, claimer));
        return abi.encodePacked(r, s, v);
    }

    /*//////////////////////////////////////////////////////////////
                              FACTORY + TOKEN
    //////////////////////////////////////////////////////////////*/

    function testFactoryCreatesOfferingAndToken() public view {
        require(offering.pactToken() == address(token), "initialized");
        require(offering.owner() == treasury, "owner");
        require(offering.treasury() == treasury, "treasury");
        require(offering.publicUnits() == 100, "public units");
        require(token.balanceOf(address(offering), 0) == 200, "offering units");
        require(token.balanceOf(holder, 0) == 800, "holder units");
        require(token.offering() == address(offering), "token offering");
        require(token.isApprovedForAll(buyer, address(offering)), "escrow operator");
        require(token.scaledPercentBalanceOf(holder) == 800_000, "scaled percent");
        require(token.payoutSplit() != address(0), "payout split");
        require(keccak256(bytes(token.projectName())) == keccak256("Test Project"), "name");
    }

    function testFactoryRejectsImpossibleMinimum() public {
        // costFor(0, 200) = 200e6 + 1000 * (200*199/2) = 219.9e6
        vm.expectRevert(OfferingFactory.InvalidConfig.selector);
        _create(220e6, 100);
    }

    function testFactoryRejectsPublicUnitsOverOffering() public {
        vm.expectRevert(OfferingFactory.InvalidConfig.selector);
        _create(100e6, 201);
    }

    function testTokenUriIsOnchainJson() public view {
        bytes memory prefix = "data:application/json;base64,";
        bytes memory result = bytes(token.uri(0));
        require(result.length > prefix.length, "uri length");
        for (uint256 i = 0; i < prefix.length; i++) {
            require(result[i] == prefix[i], "uri prefix");
        }
    }

    /*//////////////////////////////////////////////////////////////
                              PUBLIC TRANCHE
    //////////////////////////////////////////////////////////////*/

    function testBuyPublicAlongCurveAndMinMet() public {
        vm.prank(buyer);
        uint256 cost = offering.buyPublic(100, type(uint256).max, "Bob");

        require(cost == 100e6 + 1000 * ((99 * 100) / 2), "cost");
        require(offering.minMet(), "min");
        require(offering.unitsSold() == 100, "sold");
        require(offering.publicUnitsSold() == 100, "public sold");
        require(offering.unitsBought(buyer) == 100, "units bought");
        require(token.balanceOf(buyer, 0) == 100, "buyer units");
    }

    function testBuyPublicCapEnforced() public {
        vm.prank(buyer);
        offering.buyPublic(100, type(uint256).max, "");

        vm.prank(buyer2);
        vm.expectRevert(Offering.PublicAllocationExceeded.selector);
        offering.buyPublic(1, type(uint256).max, "");

        vm.prank(treasury);
        offering.setPublicUnits(150);
        vm.prank(buyer2);
        offering.buyPublic(50, type(uint256).max, "");
        require(offering.publicUnitsSold() == 150, "raised cap used");

        vm.prank(treasury);
        vm.expectRevert(Offering.InvalidConfig.selector);
        offering.setPublicUnits(100);
    }

    /*//////////////////////////////////////////////////////////////
                             PRIVATE TRANCHE
    //////////////////////////////////////////////////////////////*/

    function testBuyPrivateWithVoucher() public {
        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        vm.prank(buyer2);
        uint256 cost = offering.buyPrivate(voucher, ownerSig, claimSig, 150, type(uint256).max);

        require(cost <= 200e6, "cap respected");
        require(token.balanceOf(buyer2, 0) == 150, "buyer units");
        require(offering.allocationConsumed(voucher.allocationId), "consumed");
        require(offering.publicUnitsSold() == 0, "not public");

        // One-shot: a second claim on the same allocation fails.
        vm.prank(buyer2);
        vm.expectRevert(Offering.AllocationAlreadyConsumed.selector);
        offering.buyPrivate(voucher, ownerSig, claimSig, 1, type(uint256).max);
    }

    function testBuyPrivateRejectsWrongClaimer() public {
        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        // A frontrunner copying the claim calldata is not the endorsed sender.
        vm.prank(buyer);
        vm.expectRevert(Offering.InvalidClaimSignature.selector);
        offering.buyPrivate(voucher, ownerSig, claimSig, 10, type(uint256).max);
    }

    function testBuyPrivateRejectsTamperedVoucher() public {
        Offering.Voucher memory voucher = _voucher("Alice", 50e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        voucher.amountCapUsdc = 500e6;
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        vm.prank(buyer2);
        vm.expectRevert(Offering.InvalidVoucherSignature.selector);
        offering.buyPrivate(voucher, ownerSig, claimSig, 10, type(uint256).max);
    }

    function testBuyPrivateEnforcesUsdcCap() public {
        Offering.Voucher memory voucher = _voucher("Alice", 10e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        vm.prank(buyer2);
        vm.expectRevert(Offering.AllocationCapExceeded.selector);
        offering.buyPrivate(voucher, ownerSig, claimSig, 50, type(uint256).max);
    }

    function testCancelAllocationRevokesLink() public {
        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        vm.prank(treasury);
        offering.cancelAllocation(voucher.allocationId);

        vm.prank(buyer2);
        vm.expectRevert(Offering.AllocationAlreadyConsumed.selector);
        offering.buyPrivate(voucher, ownerSig, claimSig, 10, type(uint256).max);
    }

    function testOwnerRotationRevokesOutstandingVouchers() public {
        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);

        address newOwner = address(0x9E11);
        vm.prank(treasury);
        offering.transferOwnership(newOwner);
        vm.prank(newOwner);
        offering.acceptOwnership();

        vm.prank(buyer2);
        vm.expectRevert(Offering.InvalidVoucherSignature.selector);
        offering.buyPrivate(voucher, ownerSig, claimSig, 10, type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                            FAILURE + REFUNDS
    //////////////////////////////////////////////////////////////*/

    function _fail() internal {
        vm.warp(block.timestamp + 8 days);
        offering.markFailed();
    }

    function testRefundReclaimsUnitsAndDecrementsRaised() public {
        vm.prank(buyer);
        uint256 cost = offering.buyPublic(10, type(uint256).max, "");
        uint256 raisedBefore = offering.raised();
        _fail();

        vm.prank(buyer);
        offering.refund();

        require(usdc.balanceOf(buyer) == 1_000e6, "refunded");
        require(token.balanceOf(buyer, 0) == 0, "units reclaimed");
        require(token.balanceOf(address(offering), 0) == 200, "escrow restored");
        require(offering.deposits(buyer) == 0, "deposit cleared");
        require(offering.unitsBought(buyer) == 0, "units cleared");
        require(offering.raised() == raisedBefore - cost, "raised decremented");
    }

    function testRefundForfeitedIfUnitsMoved() public {
        vm.startPrank(buyer);
        offering.buyPublic(10, type(uint256).max, "");
        token.safeTransferFrom(buyer, buyer2, 0, 5, "");
        vm.stopPrank();
        _fail();

        vm.prank(buyer);
        vm.expectRevert(Offering.UnitsNotReturned.selector);
        offering.refund();
    }

    function testRefundAllSkipsBlockedBuyerAndContinues() public {
        vm.prank(buyer);
        offering.buyPublic(10, type(uint256).max, "");
        Offering.Voucher memory voucher = _voucher("Alice", 200e6);
        bytes memory ownerSig = _ownerSig(offering, voucher);
        bytes memory claimSig = _claimSig(offering, voucher.allocationId, buyer2);
        vm.prank(buyer2);
        offering.buyPrivate(voucher, ownerSig, claimSig, 10, type(uint256).max);
        _fail();

        usdc.setBlocked(buyer, true);
        address[] memory buyers = new address[](2);
        buyers[0] = buyer;
        buyers[1] = buyer2;
        vm.prank(treasury);
        offering.refundAll(buyers);

        require(offering.deposits(buyer) > 0, "blocked kept deposit");
        require(token.balanceOf(buyer, 0) == 10, "blocked kept units");
        require(offering.deposits(buyer2) == 0, "second refunded");
        require(token.balanceOf(buyer2, 0) == 0, "second units reclaimed");

        // The skipped buyer keeps the pull path once unblocked.
        usdc.setBlocked(buyer, false);
        vm.prank(buyer);
        offering.refund();
        require(usdc.balanceOf(buyer) == 1_000e6, "pull refund");
    }

    function testSweepFailedUnitsToTreasury() public {
        vm.prank(buyer);
        offering.buyPublic(10, type(uint256).max, "");
        _fail();
        vm.prank(buyer);
        offering.refund();

        uint256 swept = offering.sweepFailedUnits();
        require(swept == 200, "swept all");
        require(token.balanceOf(treasury, 0) == 200, "treasury units");
    }

    /*//////////////////////////////////////////////////////////////
                         WITHDRAW / CLOSE / RESCUE
    //////////////////////////////////////////////////////////////*/

    function testPermissionlessWithdrawPaysTreasuryOnly() public {
        vm.prank(buyer);
        uint256 first = offering.buyPublic(100, type(uint256).max, "");

        vm.prank(address(0xD00D));
        uint256 withdrawn = offering.withdraw();
        require(withdrawn == first, "withdrawn");
        require(usdc.balanceOf(treasury) == first, "treasury");
        require(usdc.balanceOf(address(0xD00D)) == 0, "caller paid");
    }

    function testOwnerCloseReturnsUnsoldUnits() public {
        vm.prank(buyer);
        offering.buyPublic(100, type(uint256).max, "");

        vm.prank(treasury);
        offering.closeAndWithdraw();

        require(uint256(offering.state()) == uint256(Offering.State.Closed), "closed");
        require(token.balanceOf(treasury, 0) == 100, "unsold");
        require(usdc.balanceOf(treasury) > 0, "usdc");
    }

    function testSkimUsdcSweepsOnlyExcess() public {
        vm.prank(buyer);
        uint256 cost = offering.buyPublic(100, type(uint256).max, "");
        usdc.mint(address(offering), 5e6); // e.g. split revenue pushed in by SplitMain.withdraw

        vm.prank(treasury);
        uint256 skimmed = offering.skimUsdc();
        require(skimmed == 5e6, "skimmed excess only");
        require(usdc.balanceOf(address(offering)) == cost, "liability intact");
    }

    function testRescueRejectsUsdcAndPactToken() public {
        vm.startPrank(treasury);
        vm.expectRevert(Offering.InvalidAddress.selector);
        offering.rescue(USDC_ADDRESS, treasury);
        vm.expectRevert(Offering.InvalidAddress.selector);
        offering.rescue(address(token), treasury);
        vm.stopPrank();

        MockUSDC stray = new MockUSDC();
        stray.mint(address(offering), 7e6);
        vm.prank(treasury);
        offering.rescue(address(stray), treasury);
        require(stray.balanceOf(treasury) == 7e6, "rescued");
    }

    function testTwoStepOwnership() public {
        address newOwner = address(0x9E11);
        vm.prank(treasury);
        offering.transferOwnership(newOwner);
        require(offering.owner() == treasury, "owner unchanged until accept");

        vm.prank(buyer);
        vm.expectRevert(Offering.NotOwner.selector);
        offering.acceptOwnership();

        vm.prank(newOwner);
        offering.acceptOwnership();
        require(offering.owner() == newOwner, "accepted");
        require(offering.pendingOwner() == address(0), "pending cleared");
    }

    /*//////////////////////////////////////////////////////////////
                           LIFECYCLE EDGES
    //////////////////////////////////////////////////////////////*/

    function testAfterMinCloseDateDoesNotStopBuyOrTopUp() public {
        vm.prank(buyer);
        offering.buyPublic(100, type(uint256).max, "");

        vm.warp(block.timestamp + 8 days);
        // Top-up: a holder deposits more of their own units into the offering.
        vm.prank(holder);
        token.safeTransferFrom(holder, address(offering), 0, 50, "");

        vm.prank(treasury);
        offering.setPublicUnits(150);
        vm.prank(buyer2);
        offering.buyPublic(10, type(uint256).max, "");
        require(token.balanceOf(buyer2, 0) == 10, "post close buy");
    }

    function testBuyBlockedPastCloseWithoutMin() public {
        vm.warp(block.timestamp + 8 days);
        vm.prank(buyer);
        vm.expectRevert(Offering.PastCloseDate.selector);
        offering.buyPublic(1, type(uint256).max, "");
    }

    function testReceiverRejectsDepositsAfterFailure() public {
        _fail();
        vm.prank(holder);
        vm.expectRevert(Offering.ClosedOrFailed.selector);
        token.safeTransferFrom(holder, address(offering), 0, 50, "");
    }

    /*//////////////////////////////////////////////////////////////
                            GOLDEN VECTOR
    //////////////////////////////////////////////////////////////*/

    // Pins the JS ↔ Solidity voucher boundary: the fixture is generated by
    // scripts/generate-voucher-fixture.js from src/lib/voucher.js, and the
    // real verifier must accept its signatures end to end.
    function testGoldenVoucherVector() public {
        string memory json = vm.readFile("../tests/fixtures/voucher-golden.json");
        vm.chainId(vm.parseJsonUint(json, ".chainId"));

        address deployer = vm.parseJsonAddress(json, ".deployer");
        address owner = vm.parseJsonAddress(json, ".owner");
        address claimBuyer = vm.parseJsonAddress(json, ".buyer");

        vm.prank(deployer); // fresh EOA, nonce 0 — the fixture precomputes the CREATE address
        Offering golden = new Offering(100e6, uint64(block.timestamp + 7 days), 1e6, 1000, 100, owner, owner);
        require(address(golden) == vm.parseJsonAddress(json, ".offering"), "fixture address drift");

        address[] memory goldenHolders = new address[](1);
        goldenHolders[0] = holder;
        uint32[] memory goldenAllocations = new uint32[](1);
        goldenAllocations[0] = 800;
        PactToken goldenToken =
            new PactToken(address(splitMain), "Golden", goldenHolders, goldenAllocations, address(golden), 200);
        vm.prank(deployer);
        golden.initialize(address(goldenToken));

        Offering.Voucher memory voucher = Offering.Voucher({
            allocationId: vm.parseJsonBytes32(json, ".voucher.allocationId"),
            buyerName: vm.parseJsonString(json, ".voucher.buyerName"),
            amountCapUsdc: vm.parseJsonUint(json, ".voucher.amountCapUsdc"),
            linkKey: vm.parseJsonAddress(json, ".linkKey")
        });
        bytes memory ownerSig = vm.parseJsonBytes(json, ".ownerSig");
        bytes memory claimSig = vm.parseJsonBytes(json, ".claimSig");

        // The Solidity digests reproduce the JS signatures bit for bit.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(vm.parseJsonUint(json, ".ownerKey"), golden.voucherDigest(voucher));
        require(keccak256(abi.encodePacked(r, s, v)) == keccak256(ownerSig), "owner sig drift");

        // And the real verifier accepts the fixture end to end.
        usdc.mint(claimBuyer, 1_000e6);
        vm.startPrank(claimBuyer);
        usdc.approve(address(golden), type(uint256).max);
        uint256 cost = golden.buyPrivate(voucher, ownerSig, claimSig, 100, type(uint256).max);
        vm.stopPrank();
        require(cost > 0 && goldenToken.balanceOf(claimBuyer, 0) == 100, "golden claim");
    }
}
