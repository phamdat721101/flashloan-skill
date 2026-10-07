// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

interface IMVToken { function balanceOf(address) external view returns (uint256); function transfer(address, uint256) external returns (bool); function approve(address, uint256) external returns (bool); }
interface IMVAaveProvider { function getPool() external view returns (address); }
interface IMVAavePool { function ADDRESSES_PROVIDER() external view returns (address); function flashLoanSimple(address, address, uint256, bytes calldata, uint16) external; }
interface IMVV2Factory { function getPair(address, address) external view returns (address); }
interface IMVV2Pair { function token0() external view returns (address); function token1() external view returns (address); function swap(uint256, uint256, address, bytes calldata) external; }
interface IMVV3Factory { function getPool(address, address, uint24) external view returns (address); }
interface IMVV3Pool { function token0() external view returns (address); function token1() external view returns (address); function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256); }

struct MVPoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct MVSwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
type MVBalanceDelta is int256;
interface IMVV4PoolManager { function unlock(bytes calldata) external returns (bytes memory); function swap(MVPoolKey calldata, MVSwapParams calldata, bytes calldata) external returns (MVBalanceDelta); function sync(address) external; function settle() external payable returns (uint256); function take(address, address, uint256) external; }

/// @notice A callback-authenticated, bounded V2/V3/V4 route executor. It never dispatches arbitrary calldata.
contract MultiVenueArbitrageExecutor {
    error Unauthorized(); error Busy(); error InvalidRoute(); error Expired(); error UntrustedRoot(); error CallbackOnly(); error InsufficientOutput(); error Unprofitable(); error TransferFailed(); error HooksDisabled();
    uint8 private constant V2 = 2; uint8 private constant V3 = 3; uint8 private constant V4 = 4; uint256 private constant MAX_HOPS = 6;
    enum Phase { Idle, AwaitingFlash, AwaitingV3Swap, UnlockingV4 }
    address public immutable owner;
    Phase private phase;
    address private activeAaveProvider;
    address private expectedCallback;
    uint256 private expectedInput;
    address private expectedInputToken;
    mapping(address => bytes32) public trustedAaveProviderCodeHash;
    mapping(address => bytes32) public trustedV2FactoryCodeHash;
    mapping(address => bytes32) public trustedV3FactoryCodeHash;
    mapping(address => bytes32) public trustedV4ManagerCodeHash;
    mapping(address => bool) public v4HooksAllowed;

    struct Leg {
        uint8 venueVersion;
        address root;
        address pool;
        address tokenIn;
        address tokenOut;
        uint256 minAmountOut;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }
    struct ArbitrageRoute { address aaveProvider; address flashAsset; uint256 flashAmount; Leg[] legs; uint256 minProfit; uint256 deadline; }

    event RootConfigured(uint8 indexed venueVersion, address indexed root, bytes32 codeHash, bool allowed, bool allowHooks);
    event MultiVenueArbitrageExecuted(bytes32 indexed routeHash, address indexed asset, uint256 flashAmount, uint256 netProfit, uint256 legs);

    constructor() { owner = msg.sender; }

    function configureRoot(uint8 venueVersion, address root, bytes32 codeHash, bool allowed, bool allowHooks) external onlyOwner onlyIdle {
        if (root == address(0) || venueVersion < V2 || venueVersion > V4 || (allowed && (codeHash == bytes32(0) || root.codehash != codeHash))) revert InvalidRoute();
        bytes32 value = allowed ? codeHash : bytes32(0);
        if (venueVersion == V2) trustedV2FactoryCodeHash[root] = value;
        else if (venueVersion == V3) trustedV3FactoryCodeHash[root] = value;
        else { trustedV4ManagerCodeHash[root] = value; v4HooksAllowed[root] = allowed && allowHooks; }
        emit RootConfigured(venueVersion, root, codeHash, allowed, allowed && allowHooks);
    }

    function configureAaveProvider(address provider, bytes32 codeHash, bool allowed) external onlyOwner onlyIdle {
        if (provider == address(0) || (allowed && (codeHash == bytes32(0) || provider.codehash != codeHash))) revert InvalidRoute();
        trustedAaveProviderCodeHash[provider] = allowed ? codeHash : bytes32(0);
        emit RootConfigured(1, provider, codeHash, allowed, false);
    }

    function executeArbitrage(ArbitrageRoute calldata route) external onlyOwner onlyIdle {
        _validateRoute(route);
        address pool = IMVAaveProvider(route.aaveProvider).getPool();
        if (pool == address(0) || IMVAavePool(pool).ADDRESSES_PROVIDER() != route.aaveProvider) revert UntrustedRoot();
        phase = Phase.AwaitingFlash;
        activeAaveProvider = route.aaveProvider;
        IMVAavePool(pool).flashLoanSimple(address(this), route.flashAsset, route.flashAmount, abi.encode(route), 0);
        if (phase != Phase.AwaitingFlash) revert CallbackOnly();
        phase = Phase.Idle; activeAaveProvider = address(0);
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool) {
        if (phase != Phase.AwaitingFlash || initiator != address(this) || IMVAaveProvider(activeAaveProvider).getPool() != msg.sender || IMVAavePool(msg.sender).ADDRESSES_PROVIDER() != activeAaveProvider) revert CallbackOnly();
        ArbitrageRoute memory route = abi.decode(params, (ArbitrageRoute));
        if (route.aaveProvider != activeAaveProvider || route.flashAsset != asset || route.flashAmount != amount) revert InvalidRoute();
        uint256 openingBalance = IMVToken(asset).balanceOf(address(this)) - amount;
        uint256 currentAmount = amount;
        for (uint256 i; i < route.legs.length; ++i) currentAmount = _executeLeg(route.legs[i], currentAmount);
        if (route.legs[route.legs.length - 1].tokenOut != asset) revert InvalidRoute();
        uint256 repayment = amount + premium;
        uint256 closingBalance = IMVToken(asset).balanceOf(address(this));
        if (closingBalance < openingBalance + repayment + route.minProfit) revert Unprofitable();
        _safeApprove(asset, msg.sender, repayment);
        emit MultiVenueArbitrageExecuted(keccak256(params), asset, amount, closingBalance - openingBalance - repayment, route.legs.length);
        return true;
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (phase != Phase.AwaitingV3Swap || msg.sender != expectedCallback) revert CallbackOnly();
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : amount1Delta > 0 ? uint256(amount1Delta) : 0;
        if (owed == 0 || owed > expectedInput) revert InvalidRoute();
        phase = Phase.AwaitingFlash;
        _safeTransfer(expectedInputToken, msg.sender, owed);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (phase != Phase.UnlockingV4 || msg.sender != expectedCallback || !_trustedV4Manager(msg.sender)) revert CallbackOnly();
        Leg memory leg = abi.decode(data, (Leg));
        if (leg.venueVersion != V4 || leg.root != msg.sender) revert InvalidRoute();
        MVPoolKey memory key = MVPoolKey(leg.tokenIn < leg.tokenOut ? leg.tokenIn : leg.tokenOut, leg.tokenIn < leg.tokenOut ? leg.tokenOut : leg.tokenIn, leg.fee, leg.tickSpacing, leg.hooks);
        if (!v4HooksAllowed[msg.sender] && key.hooks != address(0)) revert HooksDisabled();
        bool zeroForOne = leg.tokenIn == key.currency0;
        MVBalanceDelta delta = IMVV4PoolManager(msg.sender).swap(key, MVSwapParams(zeroForOne, -int256(expectedInput), leg.sqrtPriceLimitX96), leg.hookData);
        int256 packed = MVBalanceDelta.unwrap(delta);
        int128 amount0 = int128(packed); int128 amount1 = int128(packed >> 128);
        _settleV4(msg.sender, key.currency0, amount0); _settleV4(msg.sender, key.currency1, amount1);
        phase = Phase.AwaitingFlash;
        return bytes("");
    }

    function withdraw(address token, uint256 amount, address recipient) external onlyOwner onlyIdle { _safeTransfer(token, recipient, amount); }

    function _executeLeg(Leg memory leg, uint256 amountIn) private returns (uint256 amountOut) {
        if (amountIn == 0 || leg.tokenIn == address(0) || leg.tokenOut == address(0) || leg.tokenIn == leg.tokenOut) revert InvalidRoute();
        uint256 beforeOut = IMVToken(leg.tokenOut).balanceOf(address(this));
        if (leg.venueVersion == V2) {
            if (!_trustedV2Factory(leg.root) || IMVV2Factory(leg.root).getPair(leg.tokenIn, leg.tokenOut) != leg.pool) revert UntrustedRoot();
            address token0 = IMVV2Pair(leg.pool).token0(); address token1 = IMVV2Pair(leg.pool).token1();
            if (!((token0 == leg.tokenIn && token1 == leg.tokenOut) || (token1 == leg.tokenIn && token0 == leg.tokenOut))) revert InvalidRoute();
            _safeTransfer(leg.tokenIn, leg.pool, amountIn);
            IMVV2Pair(leg.pool).swap(token0 == leg.tokenOut ? leg.minAmountOut : 0, token1 == leg.tokenOut ? leg.minAmountOut : 0, address(this), bytes(""));
        } else if (leg.venueVersion == V3) {
            if (!_trustedV3Factory(leg.root) || IMVV3Factory(leg.root).getPool(leg.tokenIn, leg.tokenOut, leg.fee) != leg.pool) revert UntrustedRoot();
            if (IMVV3Pool(leg.pool).token0() != (leg.tokenIn < leg.tokenOut ? leg.tokenIn : leg.tokenOut)) revert InvalidRoute();
            expectedCallback = leg.pool; expectedInput = amountIn; expectedInputToken = leg.tokenIn; phase = Phase.AwaitingV3Swap;
            IMVV3Pool(leg.pool).swap(address(this), leg.tokenIn < leg.tokenOut, int256(amountIn), leg.sqrtPriceLimitX96, bytes(""));
            if (phase != Phase.AwaitingFlash) revert CallbackOnly(); expectedCallback = address(0); expectedInput = 0; expectedInputToken = address(0);
        } else if (leg.venueVersion == V4) {
            if (!_trustedV4Manager(leg.root) || leg.pool != address(0)) revert UntrustedRoot();
            expectedCallback = leg.root; expectedInput = amountIn; phase = Phase.UnlockingV4;
            IMVV4PoolManager(leg.root).unlock(abi.encode(leg));
            if (phase != Phase.AwaitingFlash) revert CallbackOnly(); expectedCallback = address(0); expectedInput = 0;
        } else revert InvalidRoute();
        amountOut = IMVToken(leg.tokenOut).balanceOf(address(this)) - beforeOut;
        if (amountOut < leg.minAmountOut) revert InsufficientOutput();
    }

    function _validateRoute(ArbitrageRoute calldata route) private view {
        if (block.timestamp > route.deadline || route.flashAmount == 0 || route.legs.length < 2 || route.legs.length > MAX_HOPS || !_trustedAaveProvider(route.aaveProvider)) revert InvalidRoute();
        address token = route.flashAsset;
        for (uint256 i; i < route.legs.length; ++i) { if (route.legs[i].tokenIn != token || route.legs[i].minAmountOut == 0) revert InvalidRoute(); token = route.legs[i].tokenOut; }
        if (token != route.flashAsset) revert InvalidRoute();
    }
    function _settleV4(address manager, address currency, int128 delta) private { if (delta > 0) IMVV4PoolManager(manager).take(currency, address(this), uint256(uint128(delta))); else if (delta < 0) { IMVV4PoolManager(manager).sync(currency); _safeTransfer(currency, manager, uint256(uint128(-delta))); IMVV4PoolManager(manager).settle(); } }
    function _trustedAaveProvider(address a) private view returns (bool) { return trustedAaveProviderCodeHash[a] != bytes32(0) && a.codehash == trustedAaveProviderCodeHash[a]; }
    function _trustedV2Factory(address a) private view returns (bool) { return trustedV2FactoryCodeHash[a] != bytes32(0) && a.codehash == trustedV2FactoryCodeHash[a]; }
    function _trustedV3Factory(address a) private view returns (bool) { return trustedV3FactoryCodeHash[a] != bytes32(0) && a.codehash == trustedV3FactoryCodeHash[a]; }
    function _trustedV4Manager(address a) private view returns (bool) { return trustedV4ManagerCodeHash[a] != bytes32(0) && a.codehash == trustedV4ManagerCodeHash[a]; }
    function _safeApprove(address token, address spender, uint256 amount) private { (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IMVToken.approve.selector, spender, amount)); if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed(); }
    function _safeTransfer(address token, address recipient, uint256 amount) private { (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IMVToken.transfer.selector, recipient, amount)); if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed(); }
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier onlyIdle() { if (phase != Phase.Idle) revert Busy(); _; }
}
