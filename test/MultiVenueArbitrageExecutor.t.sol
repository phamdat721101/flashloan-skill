// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {MultiVenueArbitrageExecutor} from "../contracts/MultiVenueArbitrageExecutor.sol";
import {TestToken, TestProvider, TestAavePool, TestV4PoolManager} from "./ImmutableArbitrageExecutor.t.sol";

contract TestMorphoLender {
    bool public duplicate;
    function setDuplicate() external { duplicate = true; }
    function flashLoan(address token, uint256 amount, bytes calldata data) external {
        TestToken(token).transfer(msg.sender, amount);
        MultiVenueArbitrageExecutor(msg.sender).onMorphoFlashLoan(amount, data);
        if (duplicate) MultiVenueArbitrageExecutor(msg.sender).onMorphoFlashLoan(amount, data);
        TestToken(token).transferFrom(msg.sender, address(this), amount);
    }
}

contract TestBalancerLender {
    function flashLoan(address receiver, address[] calldata tokens, uint256[] calldata amounts, bytes calldata data) external {
        uint256 opening = TestToken(tokens[0]).balanceOf(address(this));
        TestToken(tokens[0]).transfer(receiver, amounts[0]);
        uint256[] memory fees = new uint256[](1); fees[0] = 3;
        MultiVenueArbitrageExecutor(receiver).receiveFlashLoan(tokens, amounts, fees, data);
        require(TestToken(tokens[0]).balanceOf(address(this)) == opening + 3, "actual fee not returned");
    }
}

contract TestAlgebraFactory {
    address public pool;
    function setPool(address value) external { pool = value; }
    function poolByPair(address, address) external view returns (address) { return pool; }
}

contract TestAlgebraPool {
    address public token0;
    address public token1;
    bool public duplicate;
    constructor(address a, address b) { token0 = a; token1 = b; }
    function setDuplicate() external { duplicate = true; }
    function swap(address recipient, bool zeroForOne, int256 input, uint160, bytes calldata) external returns (int256, int256) {
        require(input > 0, "positive exact input required");
        uint256 output = uint256(input) * 11 / 10;
        TestToken(zeroForOne ? token1 : token0).transfer(recipient, output);
        MultiVenueArbitrageExecutor(msg.sender).algebraSwapCallback(zeroForOne ? input : -int256(output), zeroForOne ? -int256(output) : input, bytes(""));
        if (duplicate) MultiVenueArbitrageExecutor(msg.sender).algebraSwapCallback(input, 0, bytes(""));
        return zeroForOne ? (input, -int256(output)) : (-int256(output), input);
    }
}

contract MultiVenueArbitrageExecutorTest {
    function testAlgebraFactoryPinAndCallbackRepayLoanWithoutUsingOpeningFunds() external {
        TestToken a = new TestToken(); TestToken b = new TestToken();
        (TestToken token0, TestToken token1) = address(a) < address(b) ? (a, b) : (b, a);
        TestAlgebraPool pool = new TestAlgebraPool(address(token0), address(token1));
        TestAlgebraFactory factory = new TestAlgebraFactory(); factory.setPool(address(pool));
        token0.mint(address(pool), 1000); token1.mint(address(pool), 1000);
        TestMorphoLender lender = new TestMorphoLender(); token0.mint(address(lender), 1000);
        MultiVenueArbitrageExecutor executor = new MultiVenueArbitrageExecutor(); token0.mint(address(executor), 7);
        executor.configureRoot(5, address(factory), address(factory).codehash, true, false);
        executor.configureLender(1, address(lender), address(lender).codehash, true);
        MultiVenueArbitrageExecutor.Leg[] memory legs = new MultiVenueArbitrageExecutor.Leg[](2);
        legs[0] = MultiVenueArbitrageExecutor.Leg(5, address(factory), address(pool), address(token0), address(token1), 110, 0, 1, 0, address(0), bytes(""));
        legs[1] = MultiVenueArbitrageExecutor.Leg(5, address(factory), address(pool), address(token1), address(token0), 120, 0, 1, 0, address(0), bytes(""));
        MultiVenueArbitrageExecutor.LenderRoute memory route = MultiVenueArbitrageExecutor.LenderRoute(1, address(lender), address(token0), 100, legs, 20, block.timestamp + 1);
        executor.executeLenderArbitrage(route);
        require(token0.balanceOf(address(lender)) == 1000 && token0.balanceOf(address(executor)) == 28, "Algebra debt/custody mismatch");
        pool.setDuplicate();
        (bool ok,) = address(executor).call(abi.encodeCall(executor.executeLenderArbitrage, route));
        require(!ok, "duplicate Algebra callback accepted");
        executor.configureRoot(5, address(factory), bytes32(0), false, false);
        (ok,) = address(executor).call(abi.encodeCall(executor.executeLenderArbitrage, route));
        require(!ok, "untrusted Algebra factory accepted");
        (ok,) = address(executor).call(abi.encodeCall(executor.algebraSwapCallback, (int256(1), int256(0), bytes(""))));
        require(!ok, "unauthenticated Algebra callback accepted");
    }
    function lenderFixture(uint8 kind, uint256 floor) private returns (MultiVenueArbitrageExecutor executor, TestToken token, address lender, MultiVenueArbitrageExecutor.LenderRoute memory route) {
        TestToken a = new TestToken(); TestToken b = new TestToken();
        (TestToken token0, TestToken token1) = address(a) < address(b) ? (a, b) : (b, a);
        TestV4PoolManager manager = new TestV4PoolManager(token0, token1);
        token0.mint(address(manager), 1000); token1.mint(address(manager), 1000);
        executor = new MultiVenueArbitrageExecutor();
        executor.configureRoot(4, address(manager), address(manager).codehash, true, false);
        lender = kind == 1 ? address(new TestMorphoLender()) : address(new TestBalancerLender());
        token0.mint(lender, 1000); token0.mint(address(executor), 7);
        executor.configureLender(kind, lender, lender.codehash, true);
        MultiVenueArbitrageExecutor.Leg[] memory legs = new MultiVenueArbitrageExecutor.Leg[](2);
        legs[0] = MultiVenueArbitrageExecutor.Leg(4, address(manager), address(0), address(token0), address(token1), 110, 500, 0, 10, address(0), bytes(""));
        legs[1] = MultiVenueArbitrageExecutor.Leg(4, address(manager), address(0), address(token1), address(token0), 120, 500, 0, 10, address(0), bytes(""));
        route = MultiVenueArbitrageExecutor.LenderRoute(kind, lender, address(token0), 100, legs, floor, block.timestamp + 1);
        token = token0;
    }

    function testMorphoPullRepaymentAndBalancerActualFee() external {
        for (uint8 kind = 1; kind <= 2; ++kind) {
            (MultiVenueArbitrageExecutor executor, TestToken token, address lender, MultiVenueArbitrageExecutor.LenderRoute memory route) = lenderFixture(kind, kind == 1 ? 20 : 17);
            executor.executeLenderArbitrage(route);
            require(token.balanceOf(lender) == (kind == 1 ? 1000 : 1003), "repayment mismatch");
            require(token.balanceOf(address(executor)) == (kind == 1 ? 27 : 24), "opening balance/profit lost");
        }
    }

    function testInsufficientLenderProfitFloorRollsBackAllBalances() external {
        for (uint8 kind = 1; kind <= 2; ++kind) {
            (MultiVenueArbitrageExecutor executor, TestToken token, address lender, MultiVenueArbitrageExecutor.LenderRoute memory route) = lenderFixture(kind, 21);
            (bool ok,) = address(executor).call(abi.encodeCall(executor.executeLenderArbitrage, route));
            require(!ok, "unprofitable loan accepted");
            require(token.balanceOf(lender) == 1000 && token.balanceOf(address(executor)) == 7, "rollback failed");
        }
    }

    function testRejectsDuplicateMorphoCallback() external {
        (MultiVenueArbitrageExecutor executor, TestToken token, address lender, MultiVenueArbitrageExecutor.LenderRoute memory route) = lenderFixture(1, 20);
        TestMorphoLender(lender).setDuplicate();
        (bool ok,) = address(executor).call(abi.encodeCall(executor.executeLenderArbitrage, route));
        require(!ok && token.balanceOf(lender) == 1000, "duplicate callback accepted");
    }

    function testRejectsUnauthenticatedLenderCallbacks() external {
        MultiVenueArbitrageExecutor executor = new MultiVenueArbitrageExecutor();
        (bool morpho,) = address(executor).call(abi.encodeCall(executor.onMorphoFlashLoan, (100, bytes(""))));
        address[] memory tokens = new address[](1); uint256[] memory amounts = new uint256[](1);
        (bool balancer,) = address(executor).call(abi.encodeCall(executor.receiveFlashLoan, (tokens, amounts, amounts, bytes(""))));
        require(!morpho && !balancer, "direct lender callback accepted");
    }

    function testCanonicalV4DeltasBothDirectionsPreserveOpeningBalance() external {
        TestToken a = new TestToken();
        TestToken b = new TestToken();
        (TestToken token0, TestToken token1) = address(a) < address(b) ? (a, b) : (b, a);
        TestProvider provider = new TestProvider();
        TestAavePool lender = new TestAavePool(provider, token0);
        provider.setPool(address(lender));
        TestV4PoolManager manager = new TestV4PoolManager(token0, token1);
        token0.mint(address(manager), 1_000);
        token1.mint(address(manager), 1_000);
        MultiVenueArbitrageExecutor executor = new MultiVenueArbitrageExecutor();
        executor.configureAaveProvider(address(provider), address(provider).codehash, true);
        executor.configureRoot(4, address(manager), address(manager).codehash, true, false);
        token0.mint(address(executor), 7);
        MultiVenueArbitrageExecutor.Leg[] memory legs = new MultiVenueArbitrageExecutor.Leg[](2);
        legs[0] = MultiVenueArbitrageExecutor.Leg(4, address(manager), address(0), address(token0), address(token1), 110, 500, 0, 10, address(0), bytes(""));
        legs[1] = MultiVenueArbitrageExecutor.Leg(4, address(manager), address(0), address(token1), address(token0), 120, 500, 0, 10, address(0), bytes(""));
        executor.executeArbitrage(MultiVenueArbitrageExecutor.ArbitrageRoute(address(provider), address(token0), 100, legs, 20, block.timestamp + 1));
        require(manager.firstAmountIn() == 100, "opening funds consumed");
        require(token0.balanceOf(address(executor)) == 27, "canonical deltas or profit incorrect");
        require(token0.balanceOf(address(lender)) == 100, "loan not repaid");
    }

    function testRejectsEmptyOrUntrustedRouteBeforeAnyExternalCall() external {
        MultiVenueArbitrageExecutor executor = new MultiVenueArbitrageExecutor();
        MultiVenueArbitrageExecutor.Leg[] memory legs = new MultiVenueArbitrageExecutor.Leg[](0);
        MultiVenueArbitrageExecutor.ArbitrageRoute memory route = MultiVenueArbitrageExecutor.ArbitrageRoute({
            aaveProvider: address(0), flashAsset: address(0), flashAmount: 0, legs: legs, minProfit: 0, deadline: block.timestamp
        });
        (bool ok,) = address(executor).call(abi.encodeCall(executor.executeArbitrage, route));
        require(!ok, "empty route accepted");
    }

    function testRejectsDirectCallbacks() external {
        MultiVenueArbitrageExecutor executor = new MultiVenueArbitrageExecutor();
        (bool v3ok,) = address(executor).call(abi.encodeCall(executor.uniswapV3SwapCallback, (int256(1), int256(0), bytes(""))));
        (bool v4ok,) = address(executor).call(abi.encodeCall(executor.unlockCallback, bytes("")));
        require(!v3ok && !v4ok, "unauthenticated callback accepted");
    }
}

/// @notice Read-only fork proof for the live deployment. Run with
/// `forge test --fork-url "$ARBITRUM_RPC_URL"`; it never broadcasts.
contract MultiVenueArbitrageExecutorArbitrumForkProof {
    address private constant EXECUTOR = 0xD130B45b7E7D08FB7DbB1c79FA5d9B95Ea8e27B2;
    address private constant OWNER = 0xc75aAeBD1F395cFc9e7c7f291Ea32d5C9d4c270a;
    address private constant AAVE_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    address private constant V2_FACTORY = 0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9;
    address private constant V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address private constant V4_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
    bytes32 private constant AAVE_HASH = 0x1a95f317ee56e0b9aedc4f4b7abd9e546dc45c26d1d77e95bcf62b789d9a5486;
    bytes32 private constant V2_HASH = 0xbab145d02e7005f0d84c6c1639d39b799b0ea16df99ebbdaf5a14d9da820b4e0;
    bytes32 private constant V3_HASH = 0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69;
    bytes32 private constant V4_HASH = 0xe4b2759e456c9c4ef763e3b4e257c5105e1ba283d7de8b131dd321197de794a4;

    function testForkDeploymentPinsExactRootsAndDisablesHooks() external view {
        if (block.chainid != 42161) return;
        MultiVenueArbitrageExecutor executor = MultiVenueArbitrageExecutor(EXECUTOR);
        require(executor.owner() == OWNER, "owner mismatch");
        require(EXECUTOR.codehash == 0xb9e2738a3643a2b8dc566f475df658f610a9f6d587d5d2ebea072104a4fccbed, "executor code drift");
        require(executor.trustedAaveProviderCodeHash(AAVE_PROVIDER) == AAVE_HASH, "aave pin mismatch");
        require(executor.trustedV2FactoryCodeHash(V2_FACTORY) == V2_HASH, "v2 pin mismatch");
        require(executor.trustedV3FactoryCodeHash(V3_FACTORY) == V3_HASH, "v3 pin mismatch");
        require(executor.trustedV4ManagerCodeHash(V4_MANAGER) == V4_HASH, "v4 pin mismatch");
        require(!executor.v4HooksAllowed(V4_MANAGER), "hooks unexpectedly enabled");
    }
}

interface ForkVm { function deal(address account, uint256 balance) external; }
interface ForkWeth {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}
interface ForkAaveProvider { function getPool() external view returns (address); }
interface ForkAavePool { function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128); }
interface ForkBalancerVault { function getProtocolFeesCollector() external view returns (address); }
interface ForkBalancerFees { function getFlashLoanFeePercentage() external view returns (uint256); }

/// Real lender debt/callback proof; venue liquidity is a deliberately synthetic
/// local fixture funded only on the fork. This is NOT live AMM/canary evidence.
contract MultiVenueRealLenderDebtForkProof {
    ForkVm private constant VM = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address private constant MORPHO = 0x6c247b1F6182318877311737BaC0844bAa518F5e;
    address private constant BALANCER = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address private constant AAVE_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    uint256 private constant PRINCIPAL = 1_000_000;
    event ForkDebtCustodyProven(uint8 kind, address lender, uint256 principal, uint256 fee, uint256 retainedProfit, uint256 forkBlock, bytes32 lenderCodeHash);

    function fixture(uint256 fee) private returns (MultiVenueArbitrageExecutor executor, MultiVenueArbitrageExecutor.Leg[] memory legs) {
        TestToken other = new TestToken();
        // The existing canonical-delta fixture swaps currency0 -> currency1 first.
        for (uint256 i; address(other) < WETH && i < 32; ++i) other = new TestToken();
        require(address(other) > WETH, "unable to create sorted venue fixture");
        TestV4PoolManager venue = new TestV4PoolManager(TestToken(WETH), other);
        venue.setSwapBonus(fee + 10);
        uint256 fixtureFunds = PRINCIPAL + 2 * (fee + 10) + 7;
        VM.deal(address(this), fixtureFunds);
        ForkWeth(WETH).deposit{value: fixtureFunds}();
        require(ForkWeth(WETH).transfer(address(venue), fixtureFunds - 7), "LP fixture funding failed");
        other.mint(address(venue), fixtureFunds);
        executor = new MultiVenueArbitrageExecutor();
        require(ForkWeth(WETH).transfer(address(executor), 7), "opening funding failed");
        executor.configureRoot(4, address(venue), address(venue).codehash, true, false);
        legs = new MultiVenueArbitrageExecutor.Leg[](2);
        legs[0] = MultiVenueArbitrageExecutor.Leg(4, address(venue), address(0), WETH, address(other), PRINCIPAL + fee + 10, 500, 0, 10, address(0), bytes(""));
        legs[1] = MultiVenueArbitrageExecutor.Leg(4, address(venue), address(0), address(other), WETH, PRINCIPAL + 2 * (fee + 10), 500, 0, 10, address(0), bytes(""));
    }
    function testForkRealMorphoPrincipalPullAndRetainedCustody() external {
        if (block.chainid != 42161) return;
        require(MORPHO.code.length > 0 && ForkWeth(WETH).balanceOf(MORPHO) >= PRINCIPAL, "real Morpho liquidity absent");
        uint256 beforeLender = ForkWeth(WETH).balanceOf(MORPHO);
        (MultiVenueArbitrageExecutor executor, MultiVenueArbitrageExecutor.Leg[] memory legs) = fixture(0);
        executor.configureLender(1, MORPHO, MORPHO.codehash, true);
        executor.executeLenderArbitrage(MultiVenueArbitrageExecutor.LenderRoute(1, MORPHO, WETH, PRINCIPAL, legs, 20, block.timestamp + 60));
        require(ForkWeth(WETH).balanceOf(MORPHO) == beforeLender, "Morpho principal not restored");
        require(ForkWeth(WETH).allowance(address(executor), MORPHO) == 0, "Morpho repayment approval not consumed");
        require(ForkWeth(WETH).balanceOf(address(executor)) == 27, "Morpho debt or opening/profit custody incorrect");
        emit ForkDebtCustodyProven(1, MORPHO, PRINCIPAL, 0, 20, block.number, MORPHO.codehash);
    }
    function testForkRealBalancerActualFeeRepaymentAndRetainedCustody() external {
        if (block.chainid != 42161) return;
        require(BALANCER.code.length > 0 && ForkWeth(WETH).balanceOf(BALANCER) >= PRINCIPAL, "real Balancer liquidity absent");
        address collector = ForkBalancerVault(BALANCER).getProtocolFeesCollector();
        uint256 feeRate = ForkBalancerFees(collector).getFlashLoanFeePercentage();
        uint256 fee = (PRINCIPAL * feeRate + 1e18 - 1) / 1e18;
        uint256 beforeVault = ForkWeth(WETH).balanceOf(BALANCER);
        uint256 beforeCollector = ForkWeth(WETH).balanceOf(collector);
        (MultiVenueArbitrageExecutor executor, MultiVenueArbitrageExecutor.Leg[] memory legs) = fixture(fee);
        executor.configureLender(2, BALANCER, BALANCER.codehash, true);
        executor.executeLenderArbitrage(MultiVenueArbitrageExecutor.LenderRoute(2, BALANCER, WETH, PRINCIPAL, legs, fee + 20, block.timestamp + 60));
        require(ForkWeth(WETH).balanceOf(BALANCER) == beforeVault, "Balancer principal not restored");
        require(ForkWeth(WETH).balanceOf(collector) == beforeCollector + fee, "Balancer actual fee not collected");
        require(ForkWeth(WETH).balanceOf(address(executor)) == 7 + fee + 20, "Balancer debt or opening/profit custody incorrect");
        emit ForkDebtCustodyProven(2, BALANCER, PRINCIPAL, fee, fee + 20, block.number, BALANCER.codehash);
    }
    function testForkRealAavePremiumPullAndRetainedCustody() external {
        if (block.chainid != 42161) return;
        address lender = ForkAaveProvider(AAVE_PROVIDER).getPool();
        uint256 fee = PRINCIPAL * ForkAavePool(lender).FLASHLOAN_PREMIUM_TOTAL() / 10000;
        (MultiVenueArbitrageExecutor executor, MultiVenueArbitrageExecutor.Leg[] memory legs) = fixture(fee);
        executor.configureAaveProvider(AAVE_PROVIDER, AAVE_PROVIDER.codehash, true);
        executor.executeArbitrage(MultiVenueArbitrageExecutor.ArbitrageRoute(AAVE_PROVIDER, WETH, PRINCIPAL, legs, fee + 20, block.timestamp + 60));
        require(ForkWeth(WETH).allowance(address(executor), lender) == 0, "Aave repayment approval not consumed");
        require(ForkWeth(WETH).balanceOf(address(executor)) == 7 + fee + 20, "Aave premium or opening/profit custody incorrect");
        emit ForkDebtCustodyProven(3, lender, PRINCIPAL, fee, fee + 20, block.number, lender.codehash);
    }
}
