// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1155Receiver, IERC20, Offering} from "../contracts/Offering.sol";
import {OfferingFactory, ILiquidSplitFactory} from "../contracts/OfferingFactory.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes4) external;
}

contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockLiquidSplit {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;

    function mint(address to, uint256 id, uint256 amount) external {
        balanceOf[to][id] += amount;
        if (to.code.length > 0) {
            require(
                IERC1155Receiver(to).onERC1155Received(msg.sender, address(0), id, amount, "")
                    == IERC1155Receiver.onERC1155Received.selector,
                "receiver"
            );
        }
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external {
        require(from == msg.sender || from == address(this), "auth");
        require(balanceOf[from][id] >= amount, "balance");
        balanceOf[from][id] -= amount;
        balanceOf[to][id] += amount;
        if (to.code.length > 0) {
            require(
                IERC1155Receiver(to).onERC1155Received(msg.sender, from, id, amount, data)
                    == IERC1155Receiver.onERC1155Received.selector,
                "receiver"
            );
        }
    }
}

contract MockLiquidSplitFactory is ILiquidSplitFactory {
    event CreateLS1155Clone(address indexed ls);

    function createLiquidSplitClone(
        address[] calldata accounts,
        uint32[] calldata initAllocations,
        uint32,
        address
    ) external returns (address liquidSplit) {
        MockLiquidSplit split = new MockLiquidSplit();
        for (uint256 i = 0; i < accounts.length; i++) {
            split.mint(accounts[i], 0, initAllocations[i]);
        }
        liquidSplit = address(split);
        emit CreateLS1155Clone(liquidSplit);
    }
}

contract OfferingTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockUSDC internal usdc;
    MockLiquidSplit internal split;
    Offering internal offering;
    address internal treasury = address(0xA11CE);
    address internal buyer = address(0xB0B);
    address internal buyer2 = address(0xCAFE);

    function setUp() public {
        usdc = new MockUSDC();
        offering = new Offering(IERC20(address(usdc)), 100e6, uint64(block.timestamp + 7 days), 1e6, 1000, treasury, treasury);
        split = new MockLiquidSplit();
        split.mint(address(offering), 0, 200);
        vm.prank(treasury);
        offering.initialize(address(split));
        usdc.mint(buyer, 1_000e6);
        usdc.mint(buyer2, 1_000e6);
    }

    function testBuyAlongCurveAndMinMet() public {
        vm.startPrank(buyer);
        usdc.approve(address(offering), type(uint256).max);
        uint256 cost = offering.buy(100, type(uint256).max);
        vm.stopPrank();

        require(cost == 100e6 + 1000 * ((99 * 100) / 2), "cost");
        require(offering.minMet(), "min");
        require(offering.unitsSold() == 100, "sold");
        require(split.balanceOf(buyer, 0) == 100, "buyer units");
    }

    function testPermissionlessWithdrawPaysTreasuryOnly() public {
        vm.startPrank(buyer);
        usdc.approve(address(offering), type(uint256).max);
        uint256 first = offering.buy(100, type(uint256).max);
        vm.stopPrank();

        vm.prank(address(0xD00D));
        uint256 withdrawn = offering.withdraw();
        require(withdrawn == first, "withdrawn");
        require(usdc.balanceOf(treasury) == first, "treasury");
        require(usdc.balanceOf(address(0xD00D)) == 0, "caller paid");

        vm.startPrank(buyer2);
        usdc.approve(address(offering), type(uint256).max);
        uint256 second = offering.buy(10, type(uint256).max);
        vm.stopPrank();

        vm.prank(address(0xD00D));
        uint256 withdrawn2 = offering.withdraw();
        require(withdrawn2 == second, "second only");
        require(usdc.balanceOf(treasury) == first + second, "treasury total");
    }

    function testRefundsMoneyOnlyAfterFailure() public {
        vm.startPrank(buyer);
        usdc.approve(address(offering), type(uint256).max);
        uint256 cost = offering.buy(10, type(uint256).max);
        vm.stopPrank();

        vm.warp(block.timestamp + 8 days);
        offering.markFailed();

        vm.prank(buyer);
        offering.refund();

        require(usdc.balanceOf(buyer) == 1_000e6, "refunded");
        require(split.balanceOf(buyer, 0) == 10, "keeps units");
        require(offering.deposits(buyer) == 0, "deposit cleared");
        require(cost > 0, "cost used");
    }

    function testAfterMinCloseDateDoesNotStopBuyOrTopUp() public {
        vm.startPrank(buyer);
        usdc.approve(address(offering), type(uint256).max);
        offering.buy(100, type(uint256).max);
        vm.stopPrank();

        vm.warp(block.timestamp + 8 days);
        split.mint(address(offering), 0, 50);

        vm.startPrank(buyer2);
        usdc.approve(address(offering), type(uint256).max);
        offering.buy(10, type(uint256).max);
        vm.stopPrank();

        require(split.balanceOf(buyer2, 0) == 10, "post close buy");
    }

    function testOwnerCloseReturnsUnsoldUnits() public {
        vm.startPrank(buyer);
        usdc.approve(address(offering), type(uint256).max);
        offering.buy(100, type(uint256).max);
        vm.stopPrank();

        vm.prank(treasury);
        offering.closeAndWithdraw();

        require(uint256(offering.state()) == uint256(Offering.State.Closed), "closed");
        require(split.balanceOf(treasury, 0) == 100, "unsold");
        require(usdc.balanceOf(treasury) > 0, "usdc");
    }

    function testRejectsBadReceiverTokenId() public {
        MockLiquidSplit other = new MockLiquidSplit();
        vm.expectRevert(Offering.BadTokenId.selector);
        other.mint(address(offering), 1, 1);
    }

    function testFactoryCreatesAndInitializes() public {
        MockLiquidSplitFactory splitFactory = new MockLiquidSplitFactory();
        OfferingFactory factory = new OfferingFactory(ILiquidSplitFactory(address(splitFactory)));
        address[] memory holders = new address[](1);
        holders[0] = address(0x1234);
        uint32[] memory allocations = new uint32[](1);
        allocations[0] = 800;

        (address offeringAddress, address splitAddress) = factory.createOffering(
            IERC20(address(usdc)),
            100e6,
            uint64(block.timestamp + 7 days),
            1e6,
            1000,
            treasury,
            holders,
            allocations,
            200
        );

        Offering created = Offering(offeringAddress);
        MockLiquidSplit createdSplit = MockLiquidSplit(splitAddress);
        require(created.liquidSplit() == splitAddress, "initialized");
        require(created.owner() == treasury, "owner");
        require(createdSplit.balanceOf(offeringAddress, 0) == 200, "offering units");
        require(createdSplit.balanceOf(holders[0], 0) == 800, "holder units");
    }
}
