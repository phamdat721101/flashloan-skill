// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IAaveV3AddressesProvider {
    function getPool() external view returns (address);
}

interface IAaveV3Pool {
    function ADDRESSES_PROVIDER() external view returns (address);
    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external;
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

type BalanceDelta is int256;

interface IUniswapV4PoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData) external returns (BalanceDelta delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

/**
 * Immutable execution code with a small, owner-managed protocol-root registry.
 *
 * Pools, paths, amounts and the active Aave pool are intentionally NOT stored in
 * this contract. A route comes from the scanner, but it can run only through a
 * registered Aave addresses provider and registered V4 PoolManager. The Aave
 * pool is resolved from its provider immediately before each flash loan.
 */
contract ImmutableArbitrageExecutor {
    error Unauthorized(); error Busy(); error Expired(); error InvalidRoute(); error UntrustedRoot(); error CallbackOnly(); error Unprofitable(); error TransferFailed(); error HookNotAllowed();

    uint256 private constant MAX_HOPS = 4;
    address private constant ZERO_ADDRESS = address(0);

    enum Phase { Idle, AwaitingFlash, Unlocking }

    address public immutable owner;
    mapping(address => bytes32) public trustedAaveProviderCodeHash;
    mapping(address => bytes32) public trustedPoolManagerCodeHash;
    mapping(address => bool) public hooksAllowed;
    Phase private phase;
    address private activeProvider;
    address private activePoolManager;

    struct V4Hop {
        PoolKey key;
        bytes32 poolId;
        bool zeroForOne;
        uint160 sqrtPriceLimitX96;
        bytes hookData;
    }

    struct V4Route {
        address aaveProvider;
        address poolManager;
        address flashAsset;
        uint256 flashAmount;
        V4Hop[] hops;
        uint256 minProfit;
        uint256 deadline;
    }

    event AaveProviderConfigured(address indexed provider, bytes32 codeHash, bool allowed);
    event PoolManagerConfigured(address indexed manager, bytes32 codeHash, bool allowed, bool allowHooks);
    event V4ArbitrageExecuted(address indexed token, uint256 flashAmount, uint256 netProfit);

    constructor() { owner = msg.sender; }

    function configureAaveProvider(address provider, bytes32 codeHash, bool allowed) external onlyOwner onlyIdle {
        if (provider == ZERO_ADDRESS || (allowed && (codeHash == bytes32(0) || provider.codehash != codeHash))) revert InvalidRoute();
        trustedAaveProviderCodeHash[provider] = allowed ? codeHash : bytes32(0);
        emit AaveProviderConfigured(provider, codeHash, allowed);
    }

    function configurePoolManager(address manager, bytes32 codeHash, bool allowed, bool allowHooks) external onlyOwner onlyIdle {
        if (manager == ZERO_ADDRESS || (allowed && (codeHash == bytes32(0) || manager.codehash != codeHash))) revert InvalidRoute();
        trustedPoolManagerCodeHash[manager] = allowed ? codeHash : bytes32(0);
        hooksAllowed[manager] = allowed && allowHooks;
        emit PoolManagerConfigured(manager, codeHash, allowed, allowed && allowHooks);
    }

    function executeV4Arbitrage(V4Route calldata route) external onlyOwner onlyIdle {
        _validateRoute(route);
        address pool = IAaveV3AddressesProvider(route.aaveProvider).getPool();
        if (pool == ZERO_ADDRESS || IAaveV3Pool(pool).ADDRESSES_PROVIDER() != route.aaveProvider) revert UntrustedRoot();
        phase = Phase.AwaitingFlash;
        activeProvider = route.aaveProvider;
        activePoolManager = route.poolManager;
        IAaveV3Pool(pool).flashLoanSimple(address(this), route.flashAsset, route.flashAmount, abi.encode(route), 0);
        if (phase != Phase.AwaitingFlash) revert CallbackOnly();
        phase = Phase.Idle;
        activeProvider = ZERO_ADDRESS;
        activePoolManager = ZERO_ADDRESS;
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool) {
        if (phase != Phase.AwaitingFlash || initiator != address(this)) revert CallbackOnly();
        if (IAaveV3AddressesProvider(activeProvider).getPool() != msg.sender || IAaveV3Pool(msg.sender).ADDRESSES_PROVIDER() != activeProvider) revert CallbackOnly();
        V4Route memory route = abi.decode(params, (V4Route));
        if (route.aaveProvider != activeProvider || route.poolManager != activePoolManager || route.flashAsset != asset || route.flashAmount != amount) revert InvalidRoute();
        uint256 openingBalance = IERC20(asset).balanceOf(address(this)) - amount;
        phase = Phase.Unlocking;
        IUniswapV4PoolManager(activePoolManager).unlock(abi.encode(route));
        if (phase != Phase.Unlocking) revert CallbackOnly();
        phase = Phase.AwaitingFlash;
        uint256 repayment = amount + premium;
        uint256 closingBalance = IERC20(asset).balanceOf(address(this));
        if (closingBalance < openingBalance + repayment + route.minProfit) revert Unprofitable();
        _safeApprove(asset, msg.sender, repayment);
        emit V4ArbitrageExecuted(asset, amount, closingBalance - openingBalance - repayment);
        return true;
    }

    /** PoolManager can invoke this only while its authenticated `unlock` is live. */
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (phase != Phase.Unlocking || msg.sender != activePoolManager || !_trustedPoolManager(msg.sender)) revert CallbackOnly();
        V4Route memory route = abi.decode(data, (V4Route));
        if (route.poolManager != msg.sender || route.aaveProvider != activeProvider) revert InvalidRoute();
        address currentAsset = route.flashAsset;
        uint256 amountIn = route.flashAmount;
        for (uint256 i; i < route.hops.length; ++i) {
            V4Hop memory hop = route.hops[i];
            if (keccak256(abi.encode(hop.key)) != hop.poolId) revert InvalidRoute();
            if (!hooksAllowed[msg.sender] && hop.key.hooks != ZERO_ADDRESS) revert HookNotAllowed();
            address inputAsset = hop.zeroForOne ? hop.key.currency0 : hop.key.currency1;
            address outputAsset = hop.zeroForOne ? hop.key.currency1 : hop.key.currency0;
            if (inputAsset != currentAsset || inputAsset == ZERO_ADDRESS || outputAsset == ZERO_ADDRESS) revert InvalidRoute();
            if (amountIn == 0 || amountIn > uint256(type(int256).max)) revert InvalidRoute();
            BalanceDelta delta = IUniswapV4PoolManager(msg.sender).swap(hop.key, SwapParams(hop.zeroForOne, -int256(amountIn), hop.sqrtPriceLimitX96), hop.hookData);
            (int128 amount0, int128 amount1) = _amounts(delta);
            if (hop.zeroForOne ? amount0 >= 0 || amount1 <= 0 : amount1 >= 0 || amount0 <= 0) revert InvalidRoute();
            _settleDelta(msg.sender, hop.key.currency0, amount0);
            _settleDelta(msg.sender, hop.key.currency1, amount1);
            amountIn = uint256(uint128(hop.zeroForOne ? amount1 : amount0));
            currentAsset = outputAsset;
        }
        if (currentAsset != route.flashAsset) revert InvalidRoute();
        return bytes("");
    }

    function withdraw(address asset, uint256 amount, address recipient) external onlyOwner onlyIdle {
        _safeTransfer(asset, recipient, amount);
    }

    function _validateRoute(V4Route calldata route) private view {
        if (block.timestamp > route.deadline || route.flashAmount == 0 || route.hops.length == 0 || route.hops.length > MAX_HOPS) revert InvalidRoute();
        if (!_trustedAaveProvider(route.aaveProvider) || !_trustedPoolManager(route.poolManager)) revert UntrustedRoot();
        if (route.flashAsset == ZERO_ADDRESS) revert InvalidRoute();
    }

    function _settleDelta(address manager, address currency, int128 delta) private {
        if (delta > 0) IUniswapV4PoolManager(manager).take(currency, address(this), uint256(uint128(delta)));
        else if (delta < 0) {
            uint256 amount = uint256(uint128(-delta));
            IUniswapV4PoolManager(manager).sync(currency);
            _safeTransfer(currency, manager, amount);
            IUniswapV4PoolManager(manager).settle();
        }
    }

    function _trustedAaveProvider(address provider) private view returns (bool) {
        bytes32 codeHash = trustedAaveProviderCodeHash[provider];
        return codeHash != bytes32(0) && provider.codehash == codeHash;
    }

    function _trustedPoolManager(address manager) private view returns (bool) {
        bytes32 codeHash = trustedPoolManagerCodeHash[manager];
        return codeHash != bytes32(0) && manager.codehash == codeHash;
    }

    function _amounts(BalanceDelta delta) private pure returns (int128 amount0, int128 amount1) {
        int256 packed = BalanceDelta.unwrap(delta);
        amount0 = int128(packed);
        amount1 = int128(packed >> 128);
    }

    function _safeApprove(address asset, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = asset.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransfer(address asset, address recipient, uint256 amount) private {
        (bool ok, bytes memory data) = asset.call(abi.encodeWithSelector(IERC20.transfer.selector, recipient, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier onlyIdle() { if (phase != Phase.Idle) revert Busy(); _; }
}
