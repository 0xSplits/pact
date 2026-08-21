// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "solady/utils/ECDSA.sol";
import {EIP712} from "solady/utils/EIP712.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

interface IERC1155 {
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
}

interface IERC1155Receiver {
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data)
        external
        returns (bytes4);
    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external returns (bytes4);
}

/**
 * @title Offering
 * @author Splits
 * @notice Sells a PactToken carve-out along a linear USDC bonding curve, in
 * two tranches sharing one curve: a permissionless public tranche capped at
 * `publicUnits`, and a private tranche.
 * @dev Once the minimum raise is met, buyers lose refund rights and the
 * treasury can withdraw proceeds. The owner decides when to close a
 * successful offer and reclaim unsold units. On failure, refunds reclaim the
 * buyer's units (the escrow is a permanent PactToken operator) and escrow-held
 * units sweep to treasury, so a failed raise never gives away equity.
 */
contract Offering is IERC1155Receiver, EIP712, ReentrancyGuard {
    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       CUSTOM ERRORS                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev The caller is not the owner.
    error NotOwner();

    /// @dev The caller is not the deploying factory.
    error NotFactory();

    /// @dev The address is zero or not allowed here.
    error InvalidAddress();

    /// @dev The configuration value is invalid.
    error InvalidConfig();

    /// @dev The PactToken is already bound.
    error AlreadyInitialized();

    /// @dev The PactToken is not yet bound.
    error NotInitialized();

    /// @dev The offering is not in the Funding state.
    error NotFunding();

    /// @dev The offering is closed or failed.
    error ClosedOrFailed();

    /// @dev The action is on the wrong side of the close date.
    error PastCloseDate();

    /// @dev The minimum raise is already met.
    error MinimumAlreadyMet();

    /// @dev The minimum raise is not met.
    error MinimumNotMet();

    /// @dev The offering has not failed.
    error NotFailed();

    /// @dev The caller has no deposit to refund.
    error NothingToRefund();

    /// @dev There is nothing to withdraw.
    error NothingToWithdraw();

    /// @dev The escrow holds fewer units than requested.
    error InsufficientSupply();

    /// @dev The purchase would exceed the public tranche cap.
    error PublicAllocationExceeded();

    /// @dev The claim would eat into supply reserved for the public tranche.
    error PublicReservationExceeded();

    /// @dev The allocation is already claimed or cancelled.
    error AllocationAlreadyConsumed();

    /// @dev The claim cost exceeds the voucher's USDC cap.
    error AllocationCapExceeded();

    /// @dev The owner signature on the voucher is invalid.
    error InvalidVoucherSignature();

    /// @dev The link-key signature on the claim is invalid.
    error InvalidClaimSignature();

    /// @dev The buyer no longer holds their full purchased unit balance.
    error UnitsNotReturned();

    /// @dev The cost exceeds the caller's `maxCost`.
    error Slippage();

    /// @dev The token id is not the cap-table id.
    error BadTokenId();

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                           EVENTS                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Emitted when the PactToken is bound to this escrow.
    event Initialized(address indexed pactToken);

    /// @dev Emitted on every purchase; `allocationId` is zero for public buys.
    event Bought(address indexed buyer, bytes32 indexed allocationId, uint256 units, uint256 cost, string buyerName);

    /// @dev Emitted when an unclaimed allocation link is revoked.
    event AllocationCancelled(bytes32 indexed allocationId);

    /// @dev Emitted when the public tranche cap moves.
    event PublicUnitsUpdated(uint256 publicUnits);

    /// @dev Emitted when a buyer's deposit is refunded.
    event RefundPaid(address indexed buyer, uint256 amount);

    /// @dev Emitted when a batch refund skips a buyer missing their units.
    event RefundSkipped(address indexed buyer);

    /// @dev Emitted when the offering is marked failed.
    event Failed();

    /// @dev Emitted when escrow-held units sweep to treasury after failure.
    event FailedUnitsSwept(address indexed treasury, uint256 units);

    /// @dev Emitted when proceeds are sent to treasury.
    event Withdrawn(address indexed treasury, uint256 amount);

    /// @dev Emitted when USDC in excess of buyer liability is skimmed to treasury.
    event Skimmed(uint256 amount);

    /// @dev Emitted when a stray token or ETH balance is rescued.
    event Rescued(address indexed token, address indexed to, uint256 amount);

    /// @dev Emitted on the owner's final close.
    event Closed(address indexed treasury, uint256 usdcAmount, uint256 unsoldUnits);

    /// @dev Emitted when the treasury address changes.
    event TreasuryUpdated(address indexed treasury);

    /// @dev Emitted when a two-step ownership transfer starts.
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    /// @dev Emitted when ownership transfers.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                     STRUCTS AND ENUMS                      */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Lifecycle of the offering.
    enum State {
        Funding,
        Failed,
        Closed
    }

    /// @dev An owner-signed private allocation, claimable by whoever the
    /// `linkKey` endorses.
    struct Voucher {
        bytes32 allocationId;
        string buyerName;
        uint256 amountCapUsdc;
        address linkKey;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         CONSTANTS                          */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev The PactToken cap-table token id.
    uint256 public constant TOKEN_ID = 0;

    /**
     * @dev Base mainnet USDC.
     */
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @dev EIP-712 typehash the owner signs to endorse an allocation link key.
    bytes32 private constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 allocationId,string buyerName,uint256 amountCapUsdc,address linkKey)");

    /// @dev EIP-712 typehash the link key signs to endorse the claiming buyer.
    bytes32 private constant CLAIM_TYPEHASH = keccak256("Claim(bytes32 allocationId,address buyer)");

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         IMMUTABLES                         */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Minimum successful raise in USDC base units.
    uint256 public immutable raiseMin;

    /// @dev Buyer-protection deadline for the raise.
    uint64 public immutable closeDate;

    /// @dev Price of the first unit.
    uint256 public immutable priceStart;

    /// @dev Price increase per unit sold.
    uint256 public immutable priceSlope;

    /// @dev The deploying OfferingFactory.
    address public immutable factory;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                          STORAGE                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev The cap table this escrow sells; bound once by the factory.
    address public pactToken;

    /// @dev Receives withdrawals and unsold units.
    address public treasury;

    /// @dev Signs vouchers and administers the offering.
    address public owner;

    /// @dev Next owner in a two-step transfer.
    address public pendingOwner;

    /**
     * @dev `raised` decrements on refund, so the buyer liability is always
     * `raised - withdrawn`.
     */
    uint256 public raised;

    /// @dev Proceeds already sent to treasury.
    uint256 public withdrawn;

    /// @dev Units sold across both tranches; the curve position.
    uint256 public unitsSold;

    /**
     * @dev Cap on public-tranche sales; owner-adjustable but never below
     * what the public tranche already sold.
     */
    uint256 public publicUnits;

    /// @dev Units sold through the public tranche.
    uint256 public publicUnitsSold;

    /// @dev Latches true once `raised` first reaches `raiseMin`.
    bool public minMet;

    /// @dev Current lifecycle state.
    State public state;

    /// @dev USDC deposited per buyer, refundable on failure.
    mapping(address => uint256) public deposits;

    /// @dev Units purchased per buyer, reclaimed on refund.
    mapping(address => uint256) public unitsBought;

    /// @dev Claimed or cancelled allocation ids.
    mapping(bytes32 => bool) public allocationConsumed;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         MODIFIERS                          */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                        CONSTRUCTOR                         */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    constructor(
        uint256 raiseMin_,
        uint64 closeDate_,
        uint256 priceStart_,
        uint256 priceSlope_,
        uint256 publicUnits_,
        address treasury_,
        address owner_
    ) {
        if (treasury_ == address(0) || owner_ == address(0)) revert InvalidAddress();
        if (closeDate_ <= block.timestamp || priceStart_ == 0) revert InvalidConfig();

        raiseMin = raiseMin_;
        closeDate = closeDate_;
        priceStart = priceStart_;
        priceSlope = priceSlope_;
        publicUnits = publicUnits_;
        treasury = treasury_;
        owner = owner_;
        factory = msg.sender;
        emit OwnershipTransferred(address(0), owner_);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                     EXTERNAL FUNCTIONS                     */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /**
     * @notice Accepts ETH so SplitMain's permissionless withdraw can deliver
     * an ETH split share credited while the escrow held units — without this
     * the push reverts and the share is stranded in SplitMain forever.
     * Recover with `rescue(address(0), to)`.
     */
    receive() external payable {}

    /**
     * @notice Binds this escrow to the PactToken created for this offering.
     * @dev Callable once by the deploying factory.
     */
    function initialize(address pactToken_) external {
        if (msg.sender != factory) revert NotFactory();
        if (pactToken != address(0)) revert AlreadyInitialized();
        if (pactToken_ == address(0)) revert InvalidAddress();
        pactToken = pactToken_;
        emit Initialized(pactToken_);
    }

    /// @notice Cost in USDC base units to buy `units` from the current curve position.
    function quote(uint256 units) external view returns (uint256) {
        return costFor(unitsSold, units);
    }

    /**
     * @notice Buys from the public tranche. Permissionless up to `publicUnits`.
     * @param buyerName Emitted, never stored; empty when unused. Names land in
     * public permanent logs.
     */
    function buyPublic(uint256 unitsWanted, uint256 maxCost, string calldata buyerName)
        external
        nonReentrant
        returns (uint256 cost)
    {
        if (publicUnitsSold + unitsWanted > publicUnits) revert PublicAllocationExceeded();
        publicUnitsSold += unitsWanted;
        cost = _buy(unitsWanted, maxCost, bytes32(0), buyerName);
    }

    /**
     * @notice Claims a private allocation. The owner signed the voucher
     * endorsing `linkKey`; the link key signed `msg.sender`, so calldata never
     * carries an unbound capability.
     * @dev Verifies against the live `owner()`, so rotating ownership
     * mass-revokes outstanding allocation links (the right default under key
     * compromise; re-issuing links is free).
     */
    function buyPrivate(
        Voucher calldata voucher,
        bytes calldata ownerSig,
        bytes calldata claimSig,
        uint256 unitsWanted,
        uint256 maxCost
    ) external nonReentrant returns (uint256 cost) {
        if (allocationConsumed[voucher.allocationId]) revert AllocationAlreadyConsumed();
        if (!SignatureCheckerLib.isValidSignatureNowCalldata(owner, voucherDigest(voucher), ownerSig)) {
            revert InvalidVoucherSignature();
        }
        if (ECDSA.recoverCalldata(claimDigest(voucher.allocationId, msg.sender), claimSig) != voucher.linkKey) {
            revert InvalidClaimSignature();
        }

        uint256 reserved = publicUnits - publicUnitsSold;
        uint256 supply = remainingUnits();
        if (unitsWanted > (supply > reserved ? supply - reserved : 0)) revert PublicReservationExceeded();

        allocationConsumed[voucher.allocationId] = true;
        cost = _buy(unitsWanted, maxCost, voucher.allocationId, voucher.buyerName);
        if (cost > voucher.amountCapUsdc) revert AllocationCapExceeded();
    }

    /// @notice Revokes an unclaimed allocation link.
    function cancelAllocation(bytes32 allocationId) external onlyOwner {
        allocationConsumed[allocationId] = true;
        emit AllocationCancelled(allocationId);
    }

    /**
     * @notice Moves supply between the tranches. Raising it shifts private
     * supply public; it can never undercut units the public tranche already sold,
     * nor advertise more units than the escrow can still deliver.
     */
    function setPublicUnits(uint256 publicUnits_) external onlyOwner {
        if (publicUnits_ < publicUnitsSold) revert InvalidConfig();
        if (publicUnits_ > remainingUnits() + publicUnitsSold) revert InvalidConfig();
        publicUnits = publicUnits_;
        emit PublicUnitsUpdated(publicUnits_);
    }

    /**
     * @notice Marks the offering failed once the close date passes without meeting the minimum.
     * @dev Permissionless because it only records a deterministic buyer-protection outcome.
     */
    function markFailed() external {
        if (state != State.Funding) revert NotFunding();
        if (block.timestamp <= closeDate) revert PastCloseDate();
        if (minMet) revert MinimumAlreadyMet();
        state = State.Failed;
        emit Failed();
    }

    /**
     * @notice Refunds the caller's USDC after failure, reclaiming their
     * purchased units in the same call.
     * @dev Pays only if the full purchased amount is recovered — a buyer who
     * transferred units away mid-raise forfeits the refund.
     */
    function refund() external nonReentrant {
        if (state != State.Failed) revert NotFailed();
        uint256 amount = deposits[msg.sender];
        if (amount == 0) revert NothingToRefund();
        uint256 units = unitsBought[msg.sender];
        if (IERC1155(pactToken).balanceOf(msg.sender, TOKEN_ID) < units) revert UnitsNotReturned();
        deposits[msg.sender] = 0;
        unitsBought[msg.sender] = 0;
        raised -= amount;
        if (units > 0) IERC1155(pactToken).safeTransferFrom(msg.sender, address(this), TOKEN_ID, units, "");
        SafeTransferLib.safeTransfer(USDC, msg.sender, amount);
        emit RefundPaid(msg.sender, amount);
    }

    /**
     * @notice Pushes refunds to a batch of buyers after failure. A buyer
     * missing their units is skipped so the rest of the batch proceeds; a
     * failing USDC transfer (e.g. blocklist) reverts the whole batch — the
     * owner retries without that buyer, who keeps the pull `refund()` path
     * either way.
     */
    function refundAll(address[] calldata buyers) external onlyOwner nonReentrant {
        if (state != State.Failed) revert NotFailed();
        for (uint256 i = 0; i < buyers.length; i++) {
            address buyer = buyers[i];
            uint256 amount = deposits[buyer];
            if (amount == 0) continue;
            uint256 units = unitsBought[buyer];
            if (IERC1155(pactToken).balanceOf(buyer, TOKEN_ID) < units) {
                emit RefundSkipped(buyer);
                continue;
            }
            deposits[buyer] = 0;
            unitsBought[buyer] = 0;
            raised -= amount;
            SafeTransferLib.safeTransfer(USDC, buyer, amount);
            if (units > 0) IERC1155(pactToken).safeTransferFrom(buyer, address(this), TOKEN_ID, units, "");
            emit RefundPaid(buyer, amount);
        }
    }

    /**
     * @notice Sweeps escrow-held units (unsold + reclaimed) to treasury after
     * failure: the cap table reverts to the founders.
     */
    function sweepFailedUnits() external nonReentrant returns (uint256 units) {
        if (state != State.Failed) revert NotFailed();
        units = remainingUnits();
        if (units == 0) revert NothingToWithdraw();
        IERC1155(pactToken).safeTransferFrom(address(this), treasury, TOKEN_ID, units, "");
        emit FailedUnitsSwept(treasury, units);
    }

    /// @notice Owner-controlled final close. Withdraws USDC and returns unsold units to treasury.
    function closeAndWithdraw() external onlyOwner nonReentrant {
        if (!minMet) revert MinimumNotMet();
        if (state != State.Funding) revert NotFunding();

        state = State.Closed;
        uint256 amount = raised - withdrawn;
        if (amount > 0) {
            withdrawn += amount;
            SafeTransferLib.safeTransfer(USDC, treasury, amount);
            emit Withdrawn(treasury, amount);
        }

        uint256 unsoldUnits = remainingUnits();
        if (unsoldUnits > 0) {
            IERC1155(pactToken).safeTransferFrom(address(this), treasury, TOKEN_ID, unsoldUnits, "");
        }
        emit Closed(treasury, amount, unsoldUnits);
    }

    /**
     * @notice Recovers tokens that are not the payment token or the cap table,
     * and ETH via `token == address(0)`. ETH is never buyer liability — all
     * deposits are USDC — so the full balance is safe to sweep.
     */
    function rescue(address token, address to) external onlyOwner nonReentrant {
        if (token == USDC || token == pactToken || to == address(0)) revert InvalidAddress();
        if (token == address(0)) {
            uint256 ethBalance = address(this).balance;
            if (ethBalance == 0) revert NothingToWithdraw();
            SafeTransferLib.safeTransferETH(to, ethBalance);
            emit Rescued(address(0), to, ethBalance);
            return;
        }
        uint256 balance = SafeTransferLib.balanceOf(token, address(this));
        if (balance == 0) revert NothingToWithdraw();
        SafeTransferLib.safeTransfer(token, to, balance);
        emit Rescued(token, to, balance);
    }

    /**
     * @notice Sweeps USDC in excess of the buyer liability to treasury —
     * e.g. split revenue earned on escrowed units and pushed here by
     * SplitMain's permissionless withdraw.
     */
    function skimUsdc() external onlyOwner nonReentrant returns (uint256 amount) {
        uint256 liability = raised - withdrawn;
        uint256 balance = SafeTransferLib.balanceOf(USDC, address(this));
        if (balance <= liability) revert NothingToWithdraw();
        amount = balance - liability;
        SafeTransferLib.safeTransfer(USDC, treasury, amount);
        emit Skimmed(amount);
    }

    /// @notice Updates the treasury address that receives withdrawals and unsold units.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert InvalidAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /**
     * @notice Starts a two-step ownership transfer. Note the new owner's
     * acceptance revokes every outstanding allocation link, since vouchers
     * verify against the live owner.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Completes the transfer; only the pending owner may call.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    /**
     * @notice Accepts cap-table units only while the raise is live: refund
     * reclaims (self-operated) always land; anything else must be a top-up of
     * this offering's own token id during Funding.
     */
    function onERC1155Received(address operator, address, uint256 id, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        // Token check first: `operator` is attacker-controlled calldata from
        // whatever contract calls the hook, so a hostile ERC-1155 passing
        // `operator == address(this)` must not skip it.
        if (pactToken != address(0) && msg.sender != pactToken) revert InvalidAddress();
        // Refund reclaims pull units back while Failed; the escrow itself is the operator.
        if (operator != address(this)) {
            if (state != State.Funding) revert ClosedOrFailed();
            if (id != TOKEN_ID) revert BadTokenId();
            if (block.timestamp > closeDate && !minMet) revert PastCloseDate();
        }
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address operator,
        address,
        uint256[] calldata ids,
        uint256[] calldata,
        bytes calldata
    ) external view returns (bytes4) {
        if (pactToken != address(0) && msg.sender != pactToken) revert InvalidAddress();
        if (operator != address(this)) {
            if (state != State.Funding) revert ClosedOrFailed();
            if (block.timestamp > closeDate && !minMet) revert PastCloseDate();
            for (uint256 i = 0; i < ids.length; i++) {
                if (ids[i] != TOKEN_ID) revert BadTokenId();
            }
        }
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == 0x01ffc9a7;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                      PUBLIC FUNCTIONS                      */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @notice Current unsold units held by this contract.
    function remainingUnits() public view returns (uint256) {
        if (pactToken == address(0)) return 0;
        return IERC1155(pactToken).balanceOf(address(this), TOKEN_ID);
    }

    /// @notice Cost in USDC base units for `units` starting from sold count `sold`.
    function costFor(uint256 sold, uint256 units) public view returns (uint256) {
        if (units == 0) return 0;
        return units * priceStart + priceSlope * (sold * units + (units * (units - 1)) / 2);
    }

    /// @notice EIP-712 digest the owner signs to endorse an allocation link key.
    function voucherDigest(Voucher calldata voucher) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                VOUCHER_TYPEHASH,
                voucher.allocationId,
                keccak256(bytes(voucher.buyerName)),
                voucher.amountCapUsdc,
                voucher.linkKey
            )
        );
        return _hashTypedData(structHash);
    }

    /**
     * @notice EIP-712 digest the link key signs to endorse the claiming buyer.
     * @dev Typed like `voucherDigest` so the domain binds chain id and
     * verifying contract — a CREATE2 twin on another chain can't replay a
     * claim signature even if the owner re-issues the same allocation there.
     */
    function claimDigest(bytes32 allocationId, address buyer) public view returns (bytes32) {
        return _hashTypedData(keccak256(abi.encode(CLAIM_TYPEHASH, allocationId, buyer)));
    }

    /**
     * @notice Sends newly claimable USDC proceeds to treasury after the minimum is met.
     * @dev Permissionless, but funds always go to treasury.
     */
    function withdraw() public nonReentrant returns (uint256 amount) {
        if (!minMet) revert MinimumNotMet();
        amount = raised - withdrawn;
        if (amount == 0) revert NothingToWithdraw();
        withdrawn += amount;
        SafeTransferLib.safeTransfer(USDC, treasury, amount);
        emit Withdrawn(treasury, amount);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                     INTERNAL FUNCTIONS                     */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("PACT", "1");
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                     PRIVATE FUNCTIONS                      */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function _buy(uint256 unitsWanted, uint256 maxCost, bytes32 allocationId, string memory buyerName)
        private
        returns (uint256 cost)
    {
        if (state != State.Funding) revert NotFunding();
        if (pactToken == address(0)) revert NotInitialized();
        if (unitsWanted == 0) revert InvalidConfig();
        if (block.timestamp > closeDate && !minMet) revert PastCloseDate();

        uint256 supply = remainingUnits();
        if (unitsWanted > supply) revert InsufficientSupply();

        cost = costFor(unitsSold, unitsWanted);
        if (cost > maxCost) revert Slippage();

        deposits[msg.sender] += cost;
        unitsBought[msg.sender] += unitsWanted;
        raised += cost;
        unitsSold += unitsWanted;
        if (!minMet && raised >= raiseMin) minMet = true;

        SafeTransferLib.safeTransferFrom(USDC, msg.sender, address(this), cost);
        IERC1155(pactToken).safeTransferFrom(address(this), msg.sender, TOKEN_ID, unitsWanted, "");
        emit Bought(msg.sender, allocationId, unitsWanted, cost, buyerName);
    }
}
