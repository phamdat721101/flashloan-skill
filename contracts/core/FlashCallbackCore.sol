// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

interface IFCToken { function balanceOf(address) external view returns (uint256); function transfer(address, uint256) external returns (bool); function approve(address, uint256) external returns (bool); }
interface IFCMorpho { function flashLoan(address, uint256, bytes calldata) external; }
interface IFCBalancer { function flashLoan(address, address[] calldata, uint256[] calldata, bytes calldata) external; }

/// @notice Shared authenticated flash-loan state machine for new executor families (v7 SK-05).
/// Legacy executors keep their own reviewed copies until their next redeploy (debt D-01); CallbackAuthParity tests guard all three.
abstract contract FlashCallbackCore {
    error Unauthorized(); error Busy(); error InvalidRoute(); error Expired(); error UntrustedRoot(); error CallbackOnly(); error Unprofitable(); error TransferFailed();
    enum Phase { Idle, AwaitingFlash, UnlockingV4, Unwrapping, Wrapping }
    uint8 internal constant MORPHO = 1; uint8 internal constant BALANCER = 2;

    address public immutable owner;
    Phase internal phase;
    mapping(uint8 => mapping(address => bytes32)) public trustedLenderCodeHash;
    address private activeLender;
    uint8 private activeLenderKind;
    bytes32 internal activeLoanHash;
    bool private loanCallbackCompleted;

    event LenderConfigured(uint8 indexed kind, address indexed lender, bytes32 codeHash, bool allowed);

    constructor() { owner = msg.sender; }

    function configureLender(uint8 kind, address lender, bytes32 codeHash, bool allowed) external onlyOwner onlyIdle {
        if ((kind != MORPHO && kind != BALANCER) || lender == address(0) || (allowed && (codeHash == bytes32(0) || lender.codehash != codeHash))) revert InvalidRoute();
        trustedLenderCodeHash[kind][lender] = allowed ? codeHash : bytes32(0);
        emit LenderConfigured(kind, lender, codeHash, allowed);
    }

    /// Borrows exactly `amount` of `asset`; the callback receives the same bytes whose hash is pinned here.
    function _borrow(uint8 kind, address lender, address asset, uint256 amount, bytes memory data) internal {
        bytes32 pin = trustedLenderCodeHash[kind][lender];
        if (pin == bytes32(0) || lender.codehash != pin) revert UntrustedRoot();
        activeLender = lender; activeLenderKind = kind; activeLoanHash = keccak256(data); loanCallbackCompleted = false; phase = Phase.AwaitingFlash;
        if (kind == MORPHO) IFCMorpho(lender).flashLoan(asset, amount, data);
        else if (kind == BALANCER) {
            address[] memory tokens = new address[](1); tokens[0] = asset;
            uint256[] memory amounts = new uint256[](1); amounts[0] = amount;
            IFCBalancer(lender).flashLoan(address(this), tokens, amounts, data);
        } else revert InvalidRoute();
        if (!loanCallbackCompleted || phase != Phase.AwaitingFlash) revert CallbackOnly();
        phase = Phase.Idle; activeLender = address(0); activeLenderKind = 0; activeLoanHash = bytes32(0); loanCallbackCompleted = false;
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        _authenticateLoan(MORPHO, data);
        (address asset, uint256 amount) = _onLoan(data, 0);
        if (assets != amount) revert InvalidRoute();
        _safeApprove(asset, msg.sender, assets);
    }

    function receiveFlashLoan(address[] calldata tokens, uint256[] calldata amounts, uint256[] calldata fees, bytes calldata data) external {
        _authenticateLoan(BALANCER, data);
        if (tokens.length != 1 || amounts.length != 1 || fees.length != 1) revert InvalidRoute();
        (address asset, uint256 amount) = _onLoan(data, fees[0]);
        if (tokens[0] != asset || amounts[0] != amount) revert InvalidRoute();
        _safeTransfer(asset, msg.sender, amounts[0] + fees[0]);
    }

    /// Phase, single use, lender kind, sender, pinned request hash and lender code hash.
    function _authenticateLoan(uint8 kind, bytes calldata data) private {
        if (phase != Phase.AwaitingFlash || loanCallbackCompleted || activeLenderKind != kind || msg.sender != activeLender || keccak256(data) != activeLoanHash
            || msg.sender.codehash != trustedLenderCodeHash[kind][msg.sender]) revert CallbackOnly();
        loanCallbackCompleted = true;
    }

    /// Runs the authenticated route and returns the borrowed asset/amount it was built for; must leave principal + fee repayable.
    function _onLoan(bytes calldata data, uint256 fee) internal virtual returns (address asset, uint256 amount);

    function _safeApprove(address token, address spender, uint256 amount) internal { (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(IFCToken.approve.selector, spender, amount)); if (!ok || (r.length != 0 && !abi.decode(r, (bool)))) revert TransferFailed(); }
    function _safeTransfer(address token, address recipient, uint256 amount) internal { (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(IFCToken.transfer.selector, recipient, amount)); if (!ok || (r.length != 0 && !abi.decode(r, (bool)))) revert TransferFailed(); }
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier onlyIdle() { if (phase != Phase.Idle) revert Busy(); _; }
}
