// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import { FlashCallbackCore, IFCToken } from "./core/FlashCallbackCore.sol";

struct NativePoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct NativeSwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
type NativeBalanceDelta is int256;
interface INativeV4Manager {
    function unlock(bytes calldata) external returns (bytes memory);
    function swap(NativePoolKey calldata, NativeSwapParams calldata, bytes calldata) external returns (NativeBalanceDelta);
    function sync(address) external;
    function settle() external payable returns (uint256);
    function take(address, address, uint256) external;
}
interface IWrappedNative { function deposit() external payable; function withdraw(uint256) external; }

/// @notice Capability evm-native-v4/1, codec native-v4-route/1. Flash debt stays an ERC20 (WETH or another verified repayment token);
/// a branch may unwrap, swap native v4 currencies and rewrap. Only authenticated deltas count; forced ETH is reported, never profit.
contract NativeV4FlashExecutor is FlashCallbackCore {
    error InsufficientOutput(); error HooksDisabled(); error NativeAccounting();
    uint8 internal constant SWAP = 0; uint8 internal constant UNWRAP = 1; uint8 internal constant WRAP = 2;
    uint256 internal constant MAX_BRANCHES = 8; uint256 internal constant MAX_ACTIONS = 8;

    struct NativeAction { uint8 kind; address tokenIn; address tokenOut; uint256 minAmountOut; address manager; NativePoolKey key; uint160 sqrtPriceLimitX96; bytes hookData; }
    struct NativeBranch { uint256 allocationRaw; NativeAction[] actions; }
    struct NativeRoute { uint8 lenderKind; address lender; address flashAsset; uint256 principalRaw; NativeBranch[] branches; uint256 minSurplusRaw; uint256 deadline; }

    address public immutable wrappedNative;
    bytes32 public immutable wrappedNativeCodeHash;
    mapping(address => bytes32) public trustedV4ManagerCodeHash;

    uint256 private loanOpening;      // flash-asset balance before the loan; excluded from proceeds
    uint256 private nativeOpening;    // native balance before the loan; excluded from proceeds
    int256 private logicalNative;     // signed attributable native ledger for the active branch
    address private expectedManager;
    bytes32 private pendingActionHash;
    uint256 private expectedInput;
    uint256 private lastOutput;

    event ManagerConfigured(address indexed manager, bytes32 codeHash, bool allowed);
    event NativeArbitrageExecuted(bytes32 indexed routeHash, address indexed asset, uint256 principal, uint256 surplus, uint256 branches, uint256 unexplainedNative);

    constructor(address wrapped, bytes32 wrappedCodeHash) {
        if (wrapped == address(0) || wrappedCodeHash == bytes32(0) || wrapped.codehash != wrappedCodeHash) revert UntrustedRoot();
        wrappedNative = wrapped; wrappedNativeCodeHash = wrappedCodeHash;
    }

    function configureManager(address manager, bytes32 codeHash, bool allowed) external onlyOwner onlyIdle {
        if (manager == address(0) || (allowed && (codeHash == bytes32(0) || manager.codehash != codeHash))) revert InvalidRoute();
        trustedV4ManagerCodeHash[manager] = allowed ? codeHash : bytes32(0);
        emit ManagerConfigured(manager, codeHash, allowed);
    }

    function executeNativeArbitrage(NativeRoute calldata route) external onlyOwner onlyIdle {
        _validate(route);
        if (wrappedNative.codehash != wrappedNativeCodeHash) revert UntrustedRoot();
        loanOpening = IFCToken(route.flashAsset).balanceOf(address(this));
        nativeOpening = address(this).balance;
        _borrow(route.lenderKind, route.lender, route.flashAsset, route.principalRaw, abi.encode(route));
        // Morpho pulls repayment after the callback; the retained surplus must already exist and be attributable.
        if (IFCToken(route.flashAsset).balanceOf(address(this)) < loanOpening + route.minSurplusRaw) revert Unprofitable();
        loanOpening = 0; nativeOpening = 0;
    }

    function _onLoan(bytes calldata data, uint256 fee) internal override returns (address, uint256) {
        NativeRoute memory route = abi.decode(data, (NativeRoute));
        if (IFCToken(route.flashAsset).balanceOf(address(this)) < loanOpening + route.principalRaw) revert InvalidRoute();
        for (uint256 b; b < route.branches.length; ++b) {
            NativeBranch memory branch = route.branches[b];
            uint256 current = branch.allocationRaw;
            logicalNative = 0;
            for (uint256 a; a < branch.actions.length; ++a) current = _execute(branch.actions[a], current);
            if (logicalNative != 0) revert NativeAccounting(); // leftover native must be rewrapped inside the branch
        }
        uint256 closing = IFCToken(route.flashAsset).balanceOf(address(this));
        if (closing < loanOpening + route.principalRaw + fee + route.minSurplusRaw) revert Unprofitable();
        uint256 unexplained = address(this).balance - nativeOpening; // forced/unattributed ETH: custody, reported separately
        emit NativeArbitrageExecuted(activeLoanHash, route.flashAsset, route.principalRaw, closing - loanOpening - route.principalRaw - fee, route.branches.length, unexplained);
        return (route.flashAsset, route.principalRaw);
    }

    /// Each action consumes only the previous authenticated output; min-output applies to the attributable delta.
    function _execute(NativeAction memory action, uint256 amountIn) internal returns (uint256 out) {
        if (amountIn == 0) revert InvalidRoute();
        if (action.kind == UNWRAP) {
            uint256 before = address(this).balance;
            phase = Phase.Unwrapping;
            IWrappedNative(wrappedNative).withdraw(amountIn);
            phase = Phase.AwaitingFlash;
            if (address(this).balance - before != amountIn) revert NativeAccounting();
            logicalNative += int256(amountIn); out = amountIn;
        } else if (action.kind == WRAP) {
            if (logicalNative < int256(amountIn)) revert NativeAccounting(); // donations can never fund a wrap
            uint256 before = IFCToken(wrappedNative).balanceOf(address(this));
            phase = Phase.Wrapping;
            IWrappedNative(wrappedNative).deposit{ value: amountIn }();
            phase = Phase.AwaitingFlash;
            if (IFCToken(wrappedNative).balanceOf(address(this)) - before != amountIn) revert NativeAccounting();
            logicalNative -= int256(amountIn); out = amountIn;
        } else {
            if (action.tokenIn == address(0) && logicalNative < int256(amountIn)) revert NativeAccounting();
            uint256 before = action.tokenOut == address(0) ? 0 : IFCToken(action.tokenOut).balanceOf(address(this));
            expectedManager = action.manager; expectedInput = amountIn; lastOutput = 0;
            bytes memory data = abi.encode(action); pendingActionHash = keccak256(data);
            phase = Phase.UnlockingV4;
            INativeV4Manager(action.manager).unlock(data);
            if (phase != Phase.AwaitingFlash) revert CallbackOnly();
            out = lastOutput;
            if (action.tokenOut != address(0) && IFCToken(action.tokenOut).balanceOf(address(this)) - before != out) revert InsufficientOutput();
            expectedManager = address(0); expectedInput = 0; pendingActionHash = bytes32(0); lastOutput = 0;
        }
        if (out < action.minAmountOut) revert InsufficientOutput();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (phase != Phase.UnlockingV4 || msg.sender != expectedManager || keccak256(data) != pendingActionHash || !_trustedManager(msg.sender)) revert CallbackOnly();
        NativeAction memory action = abi.decode(data, (NativeAction));
        bool zeroForOne = action.tokenIn == action.key.currency0;
        NativeBalanceDelta delta = INativeV4Manager(msg.sender).swap(action.key, NativeSwapParams(zeroForOne, -int256(expectedInput), action.sqrtPriceLimitX96), action.hookData);
        int256 packed = NativeBalanceDelta.unwrap(delta);
        int128 amount0 = int128(packed >> 128); int128 amount1 = int128(packed); // Uniswap core: upper 128 bits are amount0
        (int128 deltaIn, int128 deltaOut) = zeroForOne ? (amount0, amount1) : (amount1, amount0);
        if (deltaIn >= 0 || deltaOut <= 0 || uint256(uint128(-deltaIn)) > expectedInput) revert InvalidRoute();
        _pay(msg.sender, action.tokenIn, uint256(uint128(-deltaIn)));
        uint256 received = uint256(uint128(deltaOut));
        INativeV4Manager(msg.sender).take(action.tokenOut, address(this), received);
        if (action.tokenOut == address(0)) logicalNative += int256(received);
        lastOutput = received;
        phase = Phase.AwaitingFlash;
        return bytes("");
    }

    /// ERC20 debt: sync -> transfer -> settle. Native debt: reset the synced currency with sync(address(0)) -> settle{value: owed}.
    function _pay(address manager, address currency, uint256 owed) internal {
        if (currency == address(0)) {
            if (logicalNative < int256(owed)) revert NativeAccounting();
            logicalNative -= int256(owed);
            INativeV4Manager(manager).sync(address(0));
            INativeV4Manager(manager).settle{ value: owed }();
        } else {
            INativeV4Manager(manager).sync(currency);
            _safeTransfer(currency, manager, owed);
            INativeV4Manager(manager).settle();
        }
    }

    /// Only the active manager (take) or wrapped-native contract (withdraw) may send ETH, and only in their phase. No state change, no reentry path.
    receive() external payable {
        if (!((phase == Phase.UnlockingV4 && msg.sender == expectedManager) || (phase == Phase.Unwrapping && msg.sender == wrappedNative))) revert CallbackOnly();
    }

    function withdraw(address token, uint256 amount, address recipient) external onlyOwner onlyIdle { _safeTransfer(token, recipient, amount); }
    function withdrawNative(uint256 amount, address payable recipient) external onlyOwner onlyIdle {
        (bool ok,) = recipient.call{ value: amount }(""); if (!ok) revert TransferFailed();
    }

    function _validate(NativeRoute calldata route) internal view {
        if (block.timestamp > route.deadline) revert Expired();
        if (route.principalRaw == 0 || route.flashAsset == address(0) || route.branches.length == 0 || route.branches.length > MAX_BRANCHES) revert InvalidRoute();
        uint256 allocated;
        for (uint256 b; b < route.branches.length; ++b) {
            NativeBranch calldata branch = route.branches[b];
            if (branch.allocationRaw == 0 || branch.actions.length == 0 || branch.actions.length > MAX_ACTIONS) revert InvalidRoute();
            allocated += branch.allocationRaw;
            address token = route.flashAsset;
            for (uint256 a; a < branch.actions.length; ++a) { _validateAction(branch.actions[a], token); token = branch.actions[a].tokenOut; }
            if (token != route.flashAsset) revert InvalidRoute();
        }
        if (allocated != route.principalRaw) revert InvalidRoute();
    }

    function _validateAction(NativeAction calldata a, address tokenIn) internal view {
        if (a.tokenIn != tokenIn || a.tokenIn == a.tokenOut || a.minAmountOut == 0) revert InvalidRoute();
        if (a.kind == SWAP) {
            if (!_trustedManager(a.manager)) revert UntrustedRoot();
            if (a.key.hooks != address(0) || a.hookData.length != 0) revert HooksDisabled();
            (address c0, address c1) = a.tokenIn < a.tokenOut ? (a.tokenIn, a.tokenOut) : (a.tokenOut, a.tokenIn);
            if (a.key.currency0 != c0 || a.key.currency1 != c1 || a.key.tickSpacing <= 0) revert InvalidRoute();
        } else if (a.kind == UNWRAP || a.kind == WRAP) {
            bool unwrap = a.kind == UNWRAP;
            if ((unwrap ? a.tokenIn : a.tokenOut) != wrappedNative || (unwrap ? a.tokenOut : a.tokenIn) != address(0)) revert InvalidRoute();
            if (a.manager != address(0) || a.key.currency0 != address(0) || a.key.currency1 != address(0) || a.key.fee != 0 || a.key.tickSpacing != 0 || a.key.hooks != address(0)
                || a.sqrtPriceLimitX96 != 0 || a.hookData.length != 0) revert InvalidRoute();
        } else revert InvalidRoute();
    }

    function _trustedManager(address manager) internal view returns (bool) { bytes32 pin = trustedV4ManagerCodeHash[manager]; return pin != bytes32(0) && manager.codehash == pin; }
}
