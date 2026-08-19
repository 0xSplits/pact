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

/// @title Offering
/// @notice Sells a PactToken carve-out along a linear USDC bonding curve, in
/// two tranches sharing one curve: a permissionless public tranche capped at
/// `publicUnits`, and a private tranche gated by owner-signed two-key vouchers
/// (the owner endorses a per-allocation link key; the link key endorses the
/// claiming buyer, so a claim in the mempool can't be frontrun).
/// @dev Once the minimum raise is met, buyers lose refund rights and the
/// treasury can withdraw proceeds. The owner decides when to close a
/// successful offer and reclaim unsold units. On failure, refunds reclaim the
/// buyer's units (the escrow is a permanent PactToken operator) and escrow-held
/// units sweep to treasury, so a failed raise never gives away equity.
///
/// The minimum is a coordination signal, not a trustless guarantee: the owner
/// can meet it with their own funds and withdraw (audit H-4, accepted — any
/// owner-keyed rule is sybil-trivial to defeat; PACT's trust model is
/// reputational). `setTreasury` is likewise unrestricted mid-raise (M-6): the
/// owner is the party being funded either way, and re-pointing to a multisig
/// is the legitimate use.
contract Offering is IERC1155Receiver, EIP712, ReentrancyGuard {
    enum State {
        Funding,
        Failed,
        Closed
    }

    uint256 public constant TOKEN_ID = 0;
    /// @notice Base mainnet USDC, hardcoded so a wrong or fee-on-transfer
    /// payment token can't be configured (audit H-3/M-2).
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    uint256 public immutable raiseMin;
    uint64 public immutable closeDate;
    uint256 public immutable priceStart;
    uint256 public immutable priceSlope;
    address public immutable factory;

    address public pactToken;
    address public treasury;
    address public owner;
    address public pendingOwner;

    /// @notice `raised` decrements on refund, so the buyer liability is always
    /// `raised - withdrawn` (audit M-1).
    uint256 public raised;
    uint256 public withdrawn;
    uint256 public unitsSold;
    /// @notice Cap on public-tranche sales; owner-adjustable but never below
    /// what the public tranche already sold.
    uint256 public publicUnits;
    uint256 public publicUnitsSold;
    bool public minMet;
    State public state;

    mapping(address => uint256) public deposits;
    mapping(address => uint256) public unitsBought;
    mapping(bytes32 => bool) public allocationConsumed;

    struct Voucher {
        bytes32 allocationId;
        string buyerName;
        uint256 amountCapUsdc;
        address linkKey;
    }

    bytes32 private constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 allocationId,string buyerName,uint256 amountCapUsdc,address linkKey)");

    event Initialized(address indexed pactToken);
    event Bought(address indexed buyer, bytes32 indexed allocationId, uint256 units, uint256 cost, string buyerName);
    event AllocationCancelled(bytes32 indexed allocationId);
    event PublicUnitsUpdated(uint256 publicUnits);
    event RefundPaid(address indexed buyer, uint256 amount);
    event RefundSkipped(address indexed buyer);
    event Failed();
    event FailedUnitsSwept(address indexed treasury, uint256 units);
    event Withdrawn(address indexed treasury, uint256 amount);
    event Closed(address indexed treasury, uint256 usdcAmount, uint256 unsoldUnits);
    event TreasuryUpdated(address indexed treasury);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotFactory();
    error InvalidAddress();
    error InvalidConfig();
    error AlreadyInitialized();
    error NotInitialized();
    error NotFunding();
    error ClosedOrFailed();
    error PastCloseDate();
    error MinimumAlreadyMet();
    error MinimumNotMet();
    error NotFailed();
    error NothingToRefund();
    error NothingToWithdraw();
    error InsufficientSupply();
    error PublicAllocationExceeded();
    error AllocationAlreadyConsumed();
    error AllocationCapExceeded();
    error InvalidVoucherSignature();
    error InvalidClaimSignature();
    error UnitsNotReturned();
    error Slippage();
    error BadTokenId();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

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

    /// @notice Binds this escrow to the PactToken created for this offering.
    /// @dev Callable once by the deploying factory.
    function initialize(address pactToken_) external {
        if (msg.sender != factory) revert NotFactory();
        if (pactToken != address(0)) revert AlreadyInitialized();
        if (pactToken_ == address(0)) revert InvalidAddress();
        pactToken = pactToken_;
        emit Initialized(pactToken_);
    }

    /// @notice Current unsold units held by this contract.
    function remainingUnits() public view returns (uint256) {
        if (pactToken == address(0)) return 0;
        return IERC1155(pactToken).balanceOf(address(this), TOKEN_ID);
    }

    /// @notice Cost in USDC base units to buy `units` from the current curve position.
    function quote(uint256 units) external view returns (uint256) {
        return costFor(unitsSold, units);
    }

    /// @notice Cost in USDC base units for `units` starting from sold count `sold`.
    function costFor(uint256 sold, uint256 units) public view returns (uint256) {
        if (units == 0) return 0;
        return units * priceStart + priceSlope * (sold * units + (units * (units - 1)) / 2);
    }

    /// @notice Buys from the public tranche. Permissionless up to `publicUnits`.
    /// @param buyerName Emitted, never stored; empty when unused. Names land in
    /// public permanent logs — pseudonyms are the privacy mitigation.
    function buyPublic(uint256 unitsWanted, uint256 maxCost, string calldata buyerName)
        external
        nonReentrant
        returns (uint256 cost)
    {
        if (publicUnitsSold + unitsWanted > publicUnits) revert PublicAllocationExceeded();
        publicUnitsSold += unitsWanted;
        cost = _buy(unitsWanted, maxCost, bytes32(0), buyerName);
    }

    /// @notice Claims a private allocation. The owner signed the voucher
    /// endorsing `linkKey`; the link key signed `msg.sender`, so calldata never
    /// carries an unbound capability.
    /// @dev Verifies against the live `owner()`, so rotating ownership
    /// mass-revokes outstanding allocation links (the right default under key
    /// compromise; re-issuing links is free). The owner check accepts EOA and
    /// ERC-1271 signatures, so passkey/smart-wallet issuers work; the link key
    /// is always a raw browser-generated key, so the claim check is pure ECDSA.
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
        // One-shot: the first claim consumes the allocation even if under-spent.
        allocationConsumed[voucher.allocationId] = true;
        cost = _buy(unitsWanted, maxCost, voucher.allocationId, voucher.buyerName);
        if (cost > voucher.amountCapUsdc) revert AllocationCapExceeded();
    }

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

    /// @notice Revokes an unclaimed allocation link.
    function cancelAllocation(bytes32 allocationId) external onlyOwner {
        allocationConsumed[allocationId] = true;
        emit AllocationCancelled(allocationId);
    }

    /// @notice Moves supply between the tranches. Raising it shifts private
    /// supply public (how oversubscription is handled); it can never undercut
    /// units the public tranche already sold.
    function setPublicUnits(uint256 publicUnits_) external onlyOwner {
        if (publicUnits_ < publicUnitsSold) revert InvalidConfig();
        publicUnits = publicUnits_;
        emit PublicUnitsUpdated(publicUnits_);
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

    /// @notice Digest the link key signs to endorse the claiming buyer.
    function claimDigest(bytes32 allocationId, address buyer) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), allocationId, buyer));
    }

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("PACT", "1");
    }

    /// @notice Marks the offering failed once the close date passes without meeting the minimum.
    /// @dev Permissionless because it only records a deterministic buyer-protection outcome.
    function markFailed() external {
        if (state != State.Funding) revert NotFunding();
        if (block.timestamp <= closeDate) revert PastCloseDate();
        if (minMet) revert MinimumAlreadyMet();
        state = State.Failed;
        emit Failed();
    }

    /// @notice Refunds the caller's USDC after failure, reclaiming their
    /// purchased units in the same call (audit H-1/H-2).
    /// @dev Pays only if the full purchased amount is recovered — a buyer who
    /// transferred units away mid-raise forfeits the refund.
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

    /// @notice Pushes refunds to a batch of buyers after failure. Each buyer is
    /// an atomic step; a failing transfer (e.g. USDC blocklist, audit M-3) or
    /// missing units skips that buyer and continues — skipped buyers keep the
    /// pull `refund()` path.
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
            if (!_tryTransfer(USDC, buyer, amount)) {
                emit RefundSkipped(buyer);
                continue;
            }
            deposits[buyer] = 0;
            unitsBought[buyer] = 0;
            raised -= amount;
            if (units > 0) IERC1155(pactToken).safeTransferFrom(buyer, address(this), TOKEN_ID, units, "");
            emit RefundPaid(buyer, amount);
        }
    }

    /// @notice Sweeps escrow-held units (unsold + reclaimed) to treasury after
    /// failure: the cap table reverts to the founders (audit H-1).
    /// @dev Permissionless and repeatable — refunds keep pulling units back.
    function sweepFailedUnits() external nonReentrant returns (uint256 units) {
        if (state != State.Failed) revert NotFailed();
        units = remainingUnits();
        if (units == 0) revert NothingToWithdraw();
        IERC1155(pactToken).safeTransferFrom(address(this), treasury, TOKEN_ID, units, "");
        emit FailedUnitsSwept(treasury, units);
    }

    /// @notice Sends newly claimable USDC proceeds to treasury after the minimum is met.
    /// @dev Permissionless, but funds always go to treasury.
    function withdraw() public nonReentrant returns (uint256 amount) {
        if (!minMet) revert MinimumNotMet();
        amount = raised - withdrawn;
        if (amount == 0) revert NothingToWithdraw();
        withdrawn += amount;
        SafeTransferLib.safeTransfer(USDC, treasury, amount);
        emit Withdrawn(treasury, amount);
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

    /// @notice Accepts ETH so SplitMain's permissionless withdraw can deliver
    /// an ETH split share credited while the escrow held units — without this
    /// the push reverts and the share is stranded in SplitMain forever (audit
    /// Finding 1). Recover with `rescue(address(0), to)`.
    receive() external payable {}

    /// @notice Recovers tokens that are not the payment token or the cap table,
    /// and ETH via `token == address(0)` (audit M-1, Finding 1). ETH is never
    /// buyer liability — all deposits are USDC — so the full balance is safe to
    /// sweep.
    function rescue(address token, address to) external onlyOwner nonReentrant {
        if (token == USDC || token == pactToken || to == address(0)) revert InvalidAddress();
        if (token == address(0)) {
            uint256 ethBalance = address(this).balance;
            if (ethBalance == 0) revert NothingToWithdraw();
            SafeTransferLib.safeTransferETH(to, ethBalance);
            return;
        }
        uint256 balance = SafeTransferLib.balanceOf(token, address(this));
        if (balance == 0) revert NothingToWithdraw();
        SafeTransferLib.safeTransfer(token, to, balance);
    }

    /// @notice Sweeps USDC in excess of the buyer liability to treasury —
    /// e.g. split revenue earned on escrowed units and pushed here by
    /// SplitMain's permissionless withdraw (audit M-1).
    function skimUsdc() external onlyOwner nonReentrant returns (uint256 amount) {
        uint256 liability = raised - withdrawn;
        uint256 balance = SafeTransferLib.balanceOf(USDC, address(this));
        if (balance <= liability) revert NothingToWithdraw();
        amount = balance - liability;
        SafeTransferLib.safeTransfer(USDC, treasury, amount);
    }

    /// @notice Updates the treasury address that receives withdrawals and unsold units.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert InvalidAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Starts a two-step ownership transfer (audit M-4). Note the new
    /// owner's acceptance revokes every outstanding allocation link, since
    /// vouchers verify against the live owner.
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

    /// @notice Accepts cap-table units only while the raise is live: refund
    /// reclaims (self-operated) always land; anything else must be a top-up of
    /// this offering's own token id during Funding.
    function onERC1155Received(address operator, address, uint256 id, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        // Refund reclaims pull units back while Failed; the escrow itself is the operator.
        if (operator != address(this)) {
            if (state != State.Funding) revert ClosedOrFailed();
            if (id != TOKEN_ID) revert BadTokenId();
            if (block.timestamp > closeDate && !minMet) revert PastCloseDate();
            if (pactToken != address(0) && msg.sender != pactToken) revert InvalidAddress();
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
        if (operator != address(this)) {
            if (state != State.Funding) revert ClosedOrFailed();
            if (block.timestamp > closeDate && !minMet) revert PastCloseDate();
            if (pactToken != address(0) && msg.sender != pactToken) revert InvalidAddress();
            for (uint256 i = 0; i < ids.length; i++) {
                if (ids[i] != TOKEN_ID) revert BadTokenId();
            }
        }
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == 0x01ffc9a7;
    }

    // Solady has no non-reverting ERC20 transfer; refundAll needs one to skip
    // blocklisted buyers instead of bricking the whole batch.
    function _tryTransfer(address token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }
}
