// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Actor} from "./Actor.sol";
import {Clamp} from "./utils/Clamp.sol";
import {DecimalPrinter} from "./utils/DecimalPrinter.sol";
import {Deployer} from "./utils/Deployer.sol";
import {vm} from "./utils/Hevm.sol";
import {Logger} from "./utils/Logger.sol";
import {Math} from "./utils/Math.sol";
import {PropertiesAsserts} from "./utils/PropertiesAsserts.sol";
import {EnumerableSet} from "./utils/EnumerableSet.sol";
import {MockERC20} from "./utils/MockERC20.sol";
import {MockSplitMain} from "./utils/MockSplitMain.sol";
import {FizzUSDC} from "./utils/FizzUSDC.sol";

import {Offering} from "../../src/Offering.sol";
import {OfferingFactory} from "../../src/OfferingFactory.sol";
import {PactToken} from "../../src/PactToken.sol";

// The template IHevm has no etch; Foundry and Medusa both support it at the
// same cheatcode address. Echidna does not — echidna.yaml predeploys FizzUSDC
// at USDC_ADDRESS instead, so the etch branch is never reached there.
interface IVmEtch {
    function etch(address target, bytes calldata code) external;
}

/// @notice Base contract with state variables and setup functions
abstract contract Base is PropertiesAsserts, Clamp, Deployer, Math {
    using DecimalPrinter for uint256;

    string[] internal ACTOR_LABELS = ["Alice", "Bob", "Charlie"];
    uint256 internal constant BLOCK_INTERVAL = 12 seconds;
    uint256 internal constant INITIAL_ETH_BALANCE = 1_000 ether;

    // ―――――――――――――――― Protocol setup constants ――――――――――――――――――
    // Mirrors the project's own BaseTest fixture (test/Base.t.sol): mock USDC
    // etched at the hardcoded Base mainnet address, one offering with a
    // reachable minimum, a 100-unit public tranche out of a 200-unit escrow,
    // and 800 founder units held by an actor so handlers can move them.

    address internal constant USDC_ADDRESS = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 internal constant OWNER_KEY = 1; // owner == treasury, signs vouchers via vm.sign
    uint256 internal constant LINK_KEY = 2; // link key endorsing private-claim buyers
    uint256 internal constant OWNER_KEY_B = 3; // second owner seat for ownership-rotation handlers
    uint256 internal ownerKey = OWNER_KEY; // key of the live owner; handlers update on rotation
    uint256 internal constant TOKEN_ID = 0;

    uint256 internal constant RAISE_MIN = 100e6;
    uint256 internal constant PRICE_START = 1e6;
    uint256 internal constant PRICE_SLOPE = 1000;
    uint256 internal constant PUBLIC_UNITS = 100;
    uint32 internal constant OFFERING_UNITS = 200;
    uint32 internal constant FOUNDER_UNITS = 800;
    uint256 internal constant CLOSE_AFTER = 7 days;
    uint256 internal constant INITIAL_USDC_BALANCE = 10_000e6;

    // ―――――――――――――――――――――――――― Ghosts ――――――――――――――――――――――――――

    // Cumulative / latch state the contracts don't expose directly. Names and
    // ordering are the contract 7B's handlers write against — see the plan's
    // Ghost Variables table. Latch/monotonic ghosts (18–38) are asserted and
    // re-seeded by _syncMonotonicGhosts().
    struct Ghosts {
        uint256 usdcMinted; // 1  (seed: 4 * INITIAL_USDC_BALANCE)
        uint256 usdcDonated; // 2
        uint256 usdcSkimmed; // 3
        uint256 withdrawPaid; // 4
        uint256 grossRaised; // 5
        mapping(address => uint256) usdcPaid; // 6
        mapping(address => uint256) usdcRefunded; // 7
        uint256 usdcRefundedTotal; // 8
        uint256 privateUnitsSold; // 9
        uint256 unitsDonated; // 10
        mapping(address => uint256) unitsReclaimed; // 11
        uint256 unitsReclaimedTotal; // 12
        uint256 unitsSwept; // 13
        mapping(address => uint256) unitsBoughtCum; // 14
        uint256 privateBuyCount; // 15
        mapping(bytes32 => uint256) allocationClaims; // 16
        mapping(bytes32 => bool) allocationCancelled; // 17
        uint8 lastState; // 18 (seed 0)
        bool everFailed; // 19
        bool everClosed; // 20
        address lastPactToken; // 21 (seed address(token))
        address lastOwner; // 22 (seed admin)
        address lastPendingOwner; // 23 (seed 0)
        uint256 lastUnitsSold; // 24
        uint256 lastWithdrawn; // 25
        uint256 lastPublicUnitsSold; // 26
        uint256 lastRaised; // 27
        bool minMetEver; // 28
        mapping(address => uint256) lastDeposits; // 29
        mapping(address => uint256) lastUnitsBought; // 30
        bool[8] allocSeen; // 31
        uint256 lastConsumedCount; // 32
        bool terminalRecorded; // 33
        uint256 terminalUnitsSold; // 34
        uint256 terminalPublicUnitsSold; // 35
        uint256 terminalRaised; // 36
        mapping(address => mapping(address => bool)) approvedGhost; // 37
        bool soldPastEscrow; // 38
        mapping(address => uint256) lastBuyPosition; // 39
        mapping(address => uint256) blockedDeposit; // 40
    }

    Ghosts internal ghosts;

    // ―――――――――――――――――――――――――― Actors ――――――――――――――――――――――――――

    address[] internal actors;
    address internal actor;
    address internal admin;

    modifier asActor() virtual {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    modifier asAdmin() virtual {
        vm.startPrank(admin);
        _;
        vm.stopPrank();
    }

    // ―――――――――――――――――――――――― Contracts ―――――――――――――――――――――――――

    FizzUSDC internal usdc;
    MockSplitMain internal splitMain;
    OfferingFactory internal factory;
    Offering internal offering;
    PactToken internal token;
    MockERC20 internal strayToken;

    // ―――――――――――――――――――――――――― Setup ―――――――――――――――――――――――――――

    function setup() internal {
        setupActors();

        if (USDC_ADDRESS.code.length == 0) {
            FizzUSDC impl = new FizzUSDC();
            IVmEtch(address(vm)).etch(USDC_ADDRESS, address(impl).code);
        }
        usdc = FizzUSDC(USDC_ADDRESS);
        vm.label(USDC_ADDRESS, "USDC");

        splitMain = new MockSplitMain();
        factory = new OfferingFactory(address(splitMain));

        admin = vm.addr(OWNER_KEY);
        vm.label(admin, "OwnerTreasury");

        address[] memory holders = new address[](1);
        holders[0] = actors[2];
        uint32[] memory allocations = new uint32[](1);
        allocations[0] = FOUNDER_UNITS;
        (address offeringAddress, address tokenAddress) = factory.createOffering(
            "Fizz",
            RAISE_MIN,
            uint64(block.timestamp + CLOSE_AFTER),
            PRICE_START,
            PRICE_SLOPE,
            PUBLIC_UNITS,
            admin,
            holders,
            allocations,
            OFFERING_UNITS
        );
        offering = Offering(offeringAddress);
        token = PactToken(payable(tokenAddress));
        vm.label(offeringAddress, "Offering");
        vm.label(tokenAddress, "PactToken");

        // Pre-funded rescue() target: a stray ERC20 sitting on the escrow.
        strayToken = new MockERC20(address(offering), 1_000, "Stray", "STRAY", 18);

        for (uint256 i; i < actors.length; i++) {
            usdc.mint(actors[i], INITIAL_USDC_BALANCE);
            vm.prank(actors[i]);
            usdc.approve(address(offering), type(uint256).max);
        }
        // The owner can legitimately self-fund the minimum (audit H-4).
        usdc.mint(admin, INITIAL_USDC_BALANCE);
        vm.prank(admin);
        usdc.approve(address(offering), type(uint256).max);

        // Seed the latch ghosts to the initial observation so the first
        // _syncMonotonicGhosts()/property_* comparison has a valid baseline.
        // 4 mints of INITIAL_USDC_BALANCE above (3 actors + admin).
        ghosts.usdcMinted = 4 * INITIAL_USDC_BALANCE;
        ghosts.lastPactToken = address(token);
        ghosts.lastOwner = admin;
        // lastState (0 == Funding), lastPendingOwner (0) default to zero.
    }

    function setupActors() internal {
        for (uint256 i; i < ACTOR_LABELS.length; i++) {
            address _actor = address(new Actor{value: INITIAL_ETH_BALANCE}());
            actors.push(_actor);
            vm.label(_actor, ACTOR_LABELS[i]);
        }
        actor = actors[0];
    }

    // ――――――――――――――――――――――――― Helpers ――――――――――――――――――――――――――

    // Maps an arbitrary address to an actor address
    function toActor(address addy) internal view returns (address) {
        return actors[uint256(uint160(addy)) % actors.length];
    }

    // Maps an arbitrary address to an actor address that is different from the current actor
    function toActorNotCurrent(address addy) internal view returns (address) {
        address _actor = actors[uint256(uint160(addy)) % actors.length];
        if (_actor == actor) {
            _actor = actors[(uint256(uint160(addy)) + 1) % actors.length];
        }
        return _actor;
    }

    // Sums the native token balances of all actors
    function sumActorsBalances() internal view returns (uint256 sumOfBalances) {
        for (uint256 i; i < actors.length; i++) {
            sumOfBalances += actors[i].balance;
        }
    }

    // Sums the ERC-20 token balances of all actors for a given token
    function sumActorsERC20Balances(address _token) internal view returns (uint256 sumOfBalances) {
        for (uint256 i; i < actors.length; i++) {
            bytes memory data = abi.encodeWithSignature("balanceOf(address)", actors[i]);
            (bool success, bytes memory result) = _token.staticcall(data);
            require(success, "sumActorsERC20Balances: failed to get balance");
            sumOfBalances += abi.decode(result, (uint256));
        }
    }

    function skipBlocks(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + blocks * BLOCK_INTERVAL);
    }

    function skipTime(uint256 time) internal {
        uint256 blocks = (time + BLOCK_INTERVAL - 1) / BLOCK_INTERVAL;
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + time);
    }

    // ―――――――――――――――― Ghost / property helpers ―――――――――――――――――

    // ponytail: mirrors OfferingHandler._allocationId (7B territory); the
    // formula is duplicated only because Base can't call a child helper, and
    // the 8 ids must match exactly for GL-32/GL-42 to line up with real claims.
    function _fizzAllocationId(uint8 idSeed) internal pure returns (bytes32) {
        return keccak256(abi.encode("fizz-allocation", idSeed % 8));
    }

    // Deduped set of every address that can hold units or a deposit in this
    // harness. O(actors) — the raw list is a fixed 7 entries. Not `view`:
    // vm.addr is a non-view cheatcode in the template's vm interface.
    function _unitHolders() internal returns (address[] memory holders) {
        address[7] memory raw = [
            actors[0],
            actors[1],
            actors[2],
            vm.addr(OWNER_KEY),
            vm.addr(OWNER_KEY_B),
            offering.treasury(),
            address(offering)
        ];
        address[] memory tmp = new address[](7);
        uint256 count;
        for (uint256 i; i < 7; i++) {
            bool dup;
            for (uint256 j; j < count; j++) {
                if (tmp[j] == raw[i]) {
                    dup = true;
                    break;
                }
            }
            if (!dup) tmp[count++] = raw[i];
        }
        holders = new address[](count);
        for (uint256 i; i < count; i++) {
            holders[i] = tmp[i];
        }
    }

    function _sumDeposits() internal returns (uint256 sum) {
        address[] memory h = _unitHolders();
        for (uint256 i; i < h.length; i++) {
            sum += offering.deposits(h[i]);
        }
    }

    function _sumUnitsBought() internal returns (uint256 sum) {
        address[] memory h = _unitHolders();
        for (uint256 i; i < h.length; i++) {
            sum += offering.unitsBought(h[i]);
        }
    }

    function _sumUnits() internal returns (uint256 sum) {
        address[] memory h = _unitHolders();
        for (uint256 i; i < h.length; i++) {
            sum += token.balanceOf(h[i], TOKEN_ID);
        }
    }

    // ―――――――――――――― Monotonic / latch checkers (GL-28..35) ――――――――――――
    // Each reads the current state against the last-observed ghosts WITHOUT
    // re-seeding, so both the public property_* wrappers (between handlers) and
    // _syncMonotonicGhosts() (end of every Offering handler) can share them.
    // Only _syncMonotonicGhosts() re-seeds; a re-seeding property would mask
    // violations.

    function _glSaleCountersNonDecreasing() internal {
        gte(offering.unitsSold(), ghosts.lastUnitsSold, "GL-28: unitsSold decreased");
        gte(offering.withdrawn(), ghosts.lastWithdrawn, "GL-28: withdrawn decreased");
        gte(offering.publicUnitsSold(), ghosts.lastPublicUnitsSold, "GL-28: publicUnitsSold decreased");
    }

    function _glMinMetLatch() internal {
        if (ghosts.minMetEver) t(offering.minMet(), "GL-29: minMet unlatched");
    }

    function _glRaisedFallsOnlyWhileFailed() internal {
        if (offering.raised() < ghosts.lastRaised) {
            t(offering.state() == Offering.State.Failed, "GL-30: raised fell outside Failed");
        }
    }

    function _glActorLedgersMonotone() internal {
        bool failed = offering.state() == Offering.State.Failed;
        address[] memory h = _unitHolders();
        for (uint256 i; i < h.length; i++) {
            uint256 dep = offering.deposits(h[i]);
            uint256 ub = offering.unitsBought(h[i]);
            if (dep < ghosts.lastDeposits[h[i]]) {
                t(failed, "GL-31: deposits fell outside Failed");
                eq(dep, 0, "GL-31: deposits fell but not to zero");
            }
            if (ub < ghosts.lastUnitsBought[h[i]]) {
                t(failed, "GL-31: unitsBought fell outside Failed");
                eq(ub, 0, "GL-31: unitsBought fell but not to zero");
            }
        }
    }

    function _glAllocationConsumedMonotone() internal {
        uint256 nowCount;
        for (uint256 i; i < 8; i++) {
            bytes32 id = _fizzAllocationId(uint8(i));
            if (offering.allocationConsumed(id)) nowCount++;
            if (ghosts.allocSeen[i]) t(offering.allocationConsumed(id), "GL-32: allocationConsumed reverted to false");
        }
        gte(nowCount, ghosts.lastConsumedCount, "GL-32: consumed count decreased");
    }

    function _glAddressSlotsTransitionLegally() internal {
        t(offering.pactToken() == ghosts.lastPactToken, "GL-33: pactToken latch broke");
        address own = offering.owner();
        t(own != address(0), "GL-33: owner is zero");
        if (own != ghosts.lastOwner) {
            t(own == ghosts.lastPendingOwner, "GL-33: owner not prior pendingOwner");
            t(offering.pendingOwner() == address(0), "GL-33: pendingOwner not cleared on handoff");
        }
    }

    function _glTerminalFreeze() internal {
        if (ghosts.terminalRecorded) {
            eq(offering.unitsSold(), ghosts.terminalUnitsSold, "GL-34: unitsSold changed after terminal");
            eq(
                offering.publicUnitsSold(),
                ghosts.terminalPublicUnitsSold,
                "GL-34: publicUnitsSold changed after terminal"
            );
            lte(offering.raised(), ghosts.terminalRaised, "GL-34: raised increased after terminal");
        }
    }

    function _glStateTransitionsLegal() internal {
        uint8 cur = uint8(offering.state());
        uint8 last = ghosts.lastState;
        // 0 Funding, 1 Failed, 2 Closed. Legal: stay put, or Funding -> {Failed, Closed}.
        t(cur == last || (last == 0 && (cur == 1 || cur == 2)), "GL-35: illegal state transition");
        if (ghosts.everFailed) t(cur != 2, "GL-35: Failed then Closed");
        if (ghosts.everClosed) t(cur != 1, "GL-35: Closed then Failed");
    }

    function _checkMonotonic() internal {
        _glSaleCountersNonDecreasing();
        _glMinMetLatch();
        _glRaisedFallsOnlyWhileFailed();
        _glActorLedgersMonotone();
        _glAllocationConsumedMonotone();
        _glAddressSlotsTransitionLegally();
        _glTerminalFreeze();
        _glStateTransitionsLegal();
    }

    /// @notice Airtight monotonic/latch coverage: asserts every "last observed"
    /// global property (GL-25 marker, GL-28..GL-35) then re-seeds the last-*
    /// ghosts to the current values. 7B calls this at the end of every Offering
    /// handler so violations can't hide between sampled property evaluations.
    function _syncMonotonicGhosts() internal {
        _checkMonotonic();

        Offering.State st = offering.state();
        if (st != Offering.State.Funding && !ghosts.terminalRecorded) {
            ghosts.terminalRecorded = true;
            ghosts.terminalUnitsSold = offering.unitsSold();
            ghosts.terminalPublicUnitsSold = offering.publicUnitsSold();
            ghosts.terminalRaised = offering.raised();
        }
        if (st == Offering.State.Failed) ghosts.everFailed = true;
        if (st == Offering.State.Closed) ghosts.everClosed = true;

        ghosts.lastState = uint8(st);
        ghosts.lastPactToken = offering.pactToken();
        ghosts.lastOwner = offering.owner();
        ghosts.lastPendingOwner = offering.pendingOwner();
        ghosts.lastUnitsSold = offering.unitsSold();
        ghosts.lastWithdrawn = offering.withdrawn();
        ghosts.lastPublicUnitsSold = offering.publicUnitsSold();
        ghosts.lastRaised = offering.raised();
        if (offering.minMet()) ghosts.minMetEver = true;
        if (offering.unitsSold() > OFFERING_UNITS) ghosts.soldPastEscrow = true;

        address[] memory h = _unitHolders();
        for (uint256 i; i < h.length; i++) {
            ghosts.lastDeposits[h[i]] = offering.deposits(h[i]);
            ghosts.lastUnitsBought[h[i]] = offering.unitsBought(h[i]);
        }

        uint256 cc;
        for (uint256 i; i < 8; i++) {
            if (offering.allocationConsumed(_fizzAllocationId(uint8(i)))) ghosts.allocSeen[i] = true;
            if (ghosts.allocSeen[i]) cc++;
        }
        ghosts.lastConsumedCount = cc;
    }
}
