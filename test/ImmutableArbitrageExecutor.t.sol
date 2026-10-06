// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {ImmutableArbitrageExecutor, IERC20, IAaveV3AddressesProvider, IAaveV3Pool, IUniswapV4PoolManager, PoolKey, SwapParams, BalanceDelta} from "../contracts/ImmutableArbitrageExecutor.sol";

contract TestToken is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { return _transfer(msg.sender, to, amount); }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        return _transfer(from, to, amount);
    }
    function _transfer(address from, address to, uint256 amount) private returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract TestProvider is IAaveV3AddressesProvider {
    address public pool;
    function setPool(address value) external { pool = value; }
    function getPool() external view returns (address) { return pool; }
}

contract TestAavePool is IAaveV3Pool {
    TestProvider public immutable provider;
    TestToken public immutable token;

    constructor(TestProvider value, TestToken asset) { provider = value; token = asset; }
    function ADDRESSES_PROVIDER() external view returns (address) { return address(provider); }
    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16) external {
        require(asset == address(token), "asset");
        token.mint(receiver, amount);
        bool ok = ImmutableArbitrageExecutor(receiver).executeOperation(asset, amount, 0, receiver, params);
        require(ok, "callback");
        token.transferFrom(receiver, address(this), amount);
    }
}

contract TestV4PoolManager is IUniswapV4PoolManager {
    TestToken public immutable tokenA;
    TestToken public immutable tokenB;
    uint256 public firstAmountIn;
    uint256 public swaps;

    constructor(TestToken assetA, TestToken assetB) { tokenA = assetA; tokenB = assetB; }
    function unlock(bytes calldata data) external returns (bytes memory) { return ImmutableArbitrageExecutor(msg.sender).unlockCallback(data); }
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata) external returns (BalanceDelta delta) {
        uint256 amount = uint256(-params.amountSpecified);
        if (swaps == 0) {
            require(params.zeroForOne && key.currency0 == address(tokenA) && key.currency1 == address(tokenB), "first swap");
            firstAmountIn = amount;
            delta = BalanceDelta.wrap(
                int256(uint256(uint128(int128(-int256(amount))))) | (int256(int128(int256(amount + 10))) << 128)
            );
        } else {
            require(!params.zeroForOne && key.currency0 == address(tokenA) && key.currency1 == address(tokenB), "second swap");
            delta = BalanceDelta.wrap(
                int256(uint256(uint128(int128(int256(amount + 10))))) | (int256(int128(-int256(amount))) << 128)
            );
        }
        swaps++;
    }
    function sync(address) external {}
    function settle() external payable returns (uint256) { return 0; }
    function take(address currency, address to, uint256 amount) external {
        if (currency == address(tokenA)) tokenA.transfer(to, amount);
        else tokenB.transfer(to, amount);
    }
}

contract ImmutableArbitrageExecutorTest {
    function testV4UnlockSettlesExactFlashInputAndPreservesExistingBalance() external {
        TestToken tokenA = new TestToken();
        TestToken tokenB = new TestToken();
        TestProvider provider = new TestProvider();
        TestAavePool aavePool = new TestAavePool(provider, tokenA);
        provider.setPool(address(aavePool));
        TestV4PoolManager manager = new TestV4PoolManager(tokenA, tokenB);
        tokenA.mint(address(manager), 1_000);
        tokenB.mint(address(manager), 1_000);

        ImmutableArbitrageExecutor executor = new ImmutableArbitrageExecutor();
        executor.configureAaveProvider(address(provider), address(provider).codehash, true);
        executor.configurePoolManager(address(manager), address(manager).codehash, true, false);
        tokenA.mint(address(executor), 7);

        PoolKey memory key = PoolKey(address(tokenA), address(tokenB), 500, 10, address(0));
        ImmutableArbitrageExecutor.V4Hop[] memory hops = new ImmutableArbitrageExecutor.V4Hop[](2);
        hops[0] = ImmutableArbitrageExecutor.V4Hop(key, keccak256(abi.encode(key)), true, 0, bytes(""));
        hops[1] = ImmutableArbitrageExecutor.V4Hop(key, keccak256(abi.encode(key)), false, 0, bytes(""));
        ImmutableArbitrageExecutor.V4Route memory route = ImmutableArbitrageExecutor.V4Route(address(provider), address(manager), address(tokenA), 100, hops, 20, block.timestamp + 1);
        executor.executeV4Arbitrage(route);

        require(manager.firstAmountIn() == 100, "must not trade pre-existing balance");
        require(tokenA.balanceOf(address(executor)) == 27, "profit and pre-existing balance remain");
    }

    function testRejectsUnlockCallbackOutsideActiveManagerUnlock() external {
        ImmutableArbitrageExecutor executor = new ImmutableArbitrageExecutor();
        (bool ok,) = address(executor).call(abi.encodeCall(executor.unlockCallback, bytes("")));
        require(!ok, "untrusted direct callback accepted");
    }
}

contract ImmutableArbitrageExecutorArbitrumForkTest {
    address private constant AAVE_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    address private constant V4_POOL_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
    address private constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address private constant OTHER_ASSET = 0x2F714d7b9A035d4ce24af8d9b6091c07E37f43Fb;
    bytes32 private constant AAVE_PROVIDER_CODE_HASH = 0x1a95f317ee56e0b9aedc4f4b7abd9e546dc45c26d1d77e95bcf62b789d9a5486;
    bytes32 private constant V4_MANAGER_CODE_HASH = 0xe4b2759e456c9c4ef763e3b4e257c5105e1ba283d7de8b131dd321197de794a4;
    bytes32 private constant POOL_ID = 0xd876b021bf6200cd65472c4783443b1b12d589c77bf181a10b6173731b91208a;
    uint160 private constant MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970340;

    /// Run only with `forge test --fork-url ...`; the local suite remains RPC-free.
    function testForkReachesV4UnlockThenRejectsNonCircularRoute() external {
        if (block.chainid != 42161) return;
        require(AAVE_PROVIDER.codehash == AAVE_PROVIDER_CODE_HASH, "Aave provider code drift");
        require(V4_POOL_MANAGER.codehash == V4_MANAGER_CODE_HASH, "V4 manager code drift");
        ImmutableArbitrageExecutor executor = new ImmutableArbitrageExecutor();
        executor.configureAaveProvider(AAVE_PROVIDER, AAVE_PROVIDER_CODE_HASH, true);
        executor.configurePoolManager(V4_POOL_MANAGER, V4_MANAGER_CODE_HASH, true, false);
        PoolKey memory key = PoolKey({ currency0: OTHER_ASSET, currency1: USDC, fee: 203181, tickSpacing: 10, hooks: address(0) });
        ImmutableArbitrageExecutor.V4Hop[] memory hops = new ImmutableArbitrageExecutor.V4Hop[](1);
        hops[0] = ImmutableArbitrageExecutor.V4Hop(key, POOL_ID, false, MAX_SQRT_PRICE_LIMIT, bytes(""));
        ImmutableArbitrageExecutor.V4Route memory route = ImmutableArbitrageExecutor.V4Route(AAVE_PROVIDER, V4_POOL_MANAGER, USDC, 1_000_000, hops, 0, block.timestamp + 1);
        try executor.executeV4Arbitrage(route) { revert("non-circular route unexpectedly completed"); }
        catch (bytes memory reason) {
            require(reason.length >= 4 && bytes4(reason) == ImmutableArbitrageExecutor.InvalidRoute.selector, "unexpected live V4 failure");
        }
    }
}
