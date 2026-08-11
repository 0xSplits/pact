// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

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
/// @notice Sells a Liquid Split token carve-out along a linear USDC bonding curve.
/// @dev Token id is fixed to 0 for stock 0xSplits Liquid Splits. Once the minimum
/// raise is met, buyers lose refund rights and the treasury can withdraw proceeds.
/// The owner decides when to close a successful offer and reclaim unsold units.
contract Offering is IERC1155Receiver {
    enum State {
        Funding,
        Failed,
        Closed
    }

    uint256 public constant TOKEN_ID = 0;

    IERC20 public immutable paymentToken;
    uint256 public immutable raiseMin;
    uint64 public immutable closeDate;
    uint256 public immutable priceStart;
    uint256 public immutable priceSlope;

    address public liquidSplit;
    address public treasury;
    address public owner;

    uint256 public raised;
    uint256 public withdrawn;
    uint256 public unitsSold;
    bool public minMet;
    State public state;

    mapping(address => uint256) public deposits;

    bool private locked;
    bool private initialized;

    event Initialized(address indexed liquidSplit);
    event Bought(address indexed buyer, uint256 units, uint256 cost);
    event RefundPaid(address indexed buyer, uint256 amount);
    event Failed();
    event Withdrawn(address indexed treasury, uint256 amount);
    event Closed(address indexed treasury, uint256 usdcAmount, uint256 unsoldUnits);
    event TreasuryUpdated(address indexed treasury);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error Reentrant();
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
    error Slippage();
    error BadTokenId();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (locked) revert Reentrant();
        locked = true;
        _;
        locked = false;
    }

    constructor(
        IERC20 paymentToken_,
        uint256 raiseMin_,
        uint64 closeDate_,
        uint256 priceStart_,
        uint256 priceSlope_,
        address treasury_,
        address owner_
    ) {
        if (address(paymentToken_) == address(0) || treasury_ == address(0) || owner_ == address(0)) {
            revert InvalidAddress();
        }
        if (closeDate_ <= block.timestamp || priceStart_ == 0) revert InvalidConfig();

        paymentToken = paymentToken_;
        raiseMin = raiseMin_;
        closeDate = closeDate_;
        priceStart = priceStart_;
        priceSlope = priceSlope_;
        treasury = treasury_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    /// @notice Binds this escrow to the Liquid Split created for this offering.
    /// @dev Callable once by the owner after the Liquid Split factory returns the clone address.
    function initialize(address liquidSplit_) external onlyOwner {
        if (initialized) revert AlreadyInitialized();
        if (liquidSplit_ == address(0)) revert InvalidAddress();
        liquidSplit = liquidSplit_;
        initialized = true;
        emit Initialized(liquidSplit_);
    }

    /// @notice Current unsold Liquid Split units held by this contract.
    function remainingUnits() public view returns (uint256) {
        if (liquidSplit == address(0)) return 0;
        return IERC1155(liquidSplit).balanceOf(address(this), TOKEN_ID);
    }

    /// @notice Cost in payment token base units to buy `units` from the current curve position.
    function quote(uint256 units) external view returns (uint256) {
        return costFor(unitsSold, units);
    }

    /// @notice Cost in payment token base units for `units` starting from sold count `sold`.
    function costFor(uint256 sold, uint256 units) public view returns (uint256) {
        if (units == 0) return 0;
        return units * priceStart + priceSlope * (sold * units + (units * (units - 1)) / 2);
    }

    /// @notice Buys exact whole Liquid Split units with a max cost slippage guard.
    function buy(uint256 unitsWanted, uint256 maxCost) external nonReentrant returns (uint256 cost) {
        if (state != State.Funding) revert NotFunding();
        if (!initialized) revert NotInitialized();
        if (unitsWanted == 0) revert InvalidConfig();
        if (block.timestamp > closeDate && !minMet) revert PastCloseDate();

        uint256 supply = remainingUnits();
        if (unitsWanted > supply) revert InsufficientSupply();

        cost = costFor(unitsSold, unitsWanted);
        if (cost > maxCost) revert Slippage();

        deposits[msg.sender] += cost;
        raised += cost;
        unitsSold += unitsWanted;
        if (!minMet && raised >= raiseMin) minMet = true;

        _safeTransferFrom(paymentToken, msg.sender, address(this), cost);
        IERC1155(liquidSplit).safeTransferFrom(address(this), msg.sender, TOKEN_ID, unitsWanted, "");
        emit Bought(msg.sender, unitsWanted, cost);
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

    /// @notice Refunds the caller's USDC after failure. Buyer Liquid Split units are not moved.
    function refund() external nonReentrant {
        if (state != State.Failed) revert NotFailed();
        uint256 amount = deposits[msg.sender];
        if (amount == 0) revert NothingToRefund();
        deposits[msg.sender] = 0;
        _safeTransfer(paymentToken, msg.sender, amount);
        emit RefundPaid(msg.sender, amount);
    }

    /// @notice Pushes refunds to a batch of buyers after failure.
    function refundAll(address[] calldata buyers) external onlyOwner nonReentrant {
        if (state != State.Failed) revert NotFailed();
        for (uint256 i = 0; i < buyers.length; i++) {
            address buyer = buyers[i];
            uint256 amount = deposits[buyer];
            if (amount == 0) continue;
            deposits[buyer] = 0;
            _safeTransfer(paymentToken, buyer, amount);
            emit RefundPaid(buyer, amount);
        }
    }

    /// @notice Sends newly claimable USDC proceeds to treasury after the minimum is met.
    /// @dev Permissionless, but funds always go to treasury.
    function withdraw() public nonReentrant returns (uint256 amount) {
        if (!minMet) revert MinimumNotMet();
        amount = raised - withdrawn;
        if (amount == 0) revert NothingToWithdraw();
        withdrawn += amount;
        _safeTransfer(paymentToken, treasury, amount);
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
            _safeTransfer(paymentToken, treasury, amount);
            emit Withdrawn(treasury, amount);
        }

        uint256 unsoldUnits = remainingUnits();
        if (unsoldUnits > 0) {
            IERC1155(liquidSplit).safeTransferFrom(address(this), treasury, TOKEN_ID, unsoldUnits, "");
        }
        emit Closed(treasury, amount, unsoldUnits);
    }

    /// @notice Updates the treasury address that receives withdrawals and unsold units.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert InvalidAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Transfers owner/admin rights.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    function onERC1155Received(address, address, uint256 id, uint256, bytes calldata) external view returns (bytes4) {
        if (state != State.Funding) revert ClosedOrFailed();
        if (id != TOKEN_ID) revert BadTokenId();
        if (block.timestamp > closeDate && !minMet) revert PastCloseDate();
        if (initialized && msg.sender != liquidSplit) revert InvalidAddress();
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata ids, uint256[] calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (state != State.Funding) revert ClosedOrFailed();
        if (block.timestamp > closeDate && !minMet) revert PastCloseDate();
        if (initialized && msg.sender != liquidSplit) revert InvalidAddress();
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] != TOKEN_ID) revert BadTokenId();
        }
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == 0x01ffc9a7;
    }

    function _safeTransfer(IERC20 token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(IERC20 token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}

