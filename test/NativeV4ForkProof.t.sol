// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {NativeV4FlashExecutor, NativePoolKey} from "../contracts/NativeV4FlashExecutor.sol";

interface ForkVm { function envOr(string calldata, bool) external returns (bool); function skip(bool) external; function deal(address, uint256) external; }
interface ForkErc20 { function balanceOf(address) external view returns (uint256); }
struct ForkSwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
interface ForkPoolManager {
    function unlock(bytes calldata) external returns (bytes memory);
    function swap(NativePoolKey calldata, ForkSwapParams calldata, bytes calldata) external returns (int256);
    function settle() external payable returns (uint256);
    function take(address, address, uint256) external;
}

/// Plays the trigger: a large ETH -> USDC exact-input swap on one native V4 pool, settled in native ETH.
contract TriggerSwapper {
    ForkPoolManager private immutable manager;
    constructor(ForkPoolManager m) { manager = m; }
    function push(NativePoolKey calldata key, uint256 amountIn) external payable {
        manager.unlock(abi.encode(key, amountIn));
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "manager only");
        (NativePoolKey memory key, uint256 amountIn) = abi.decode(data, (NativePoolKey, uint256));
        int256 delta = manager.swap(key, ForkSwapParams(true, -int256(amountIn), 4295128740), "");
        int128 out1 = int128(delta);
        manager.settle{value: amountIn}();
        manager.take(key.currency1, address(this), uint256(uint128(out1)));
        return "";
    }
    receive() external payable {}
}

/// R8 fork proof (PRD §8 R8, §17 A7). Run: EVM_FORK_REQUIRED=true forge test --match-contract NativeV4ForkProof --fork-url <base rpc> -vv
/// Deploys NativeV4FlashExecutor on a Base fork, pins Morpho and the PoolManager, then backruns a simulated trigger swap:
/// Morpho WETH flash -> unwrap -> ETH->USDC on the undisturbed pool -> USDC->ETH on the pushed pool -> wrap -> repay.
contract NativeV4ForkProof {
    ForkVm private constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant WETH = 0x4200000000000000000000000000000000000006;
    address private constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address private constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address private constant MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    event ForkProof(string step, uint256 value);

    function testNativeV4DeployConfigureAndBackrunOnBaseFork() external {
        if (!vm.envOr("EVM_FORK_REQUIRED", false)) { vm.skip(true); return; }
        require(block.chainid == 8453, "BASE_FORK_REQUIRED");
        uint256 gasBefore = gasleft();
        NativeV4FlashExecutor e = new NativeV4FlashExecutor(WETH, WETH.codehash);
        emit ForkProof("deploy_gas", gasBefore - gasleft());
        e.configureLender(1, MORPHO, MORPHO.codehash, true);
        e.configureManager(MANAGER, MANAGER.codehash, true);
        require(e.trustedV4ManagerCodeHash(MANAGER) == MANAGER.codehash, "manager pinned");

        NativePoolKey memory deep = NativePoolKey(address(0), USDC, 500, 10, address(0));
        NativePoolKey memory pushed = NativePoolKey(address(0), USDC, 3000, 60, address(0));
        TriggerSwapper trigger = new TriggerSwapper(ForkPoolManager(MANAGER));
        vm.deal(address(trigger), 400 ether);
        trigger.push(pushed, 400 ether);   // ETH is now cheap in `pushed`: buy USDC elsewhere, buy ETH back here

        uint256 principal = 1 ether;
        uint256 lenderBefore = ForkErc20(WETH).balanceOf(MORPHO);
        NativePoolKey memory none;
        NativeV4FlashExecutor.NativeAction[] memory a = new NativeV4FlashExecutor.NativeAction[](4);
        a[0] = NativeV4FlashExecutor.NativeAction(1, WETH, address(0), principal, address(0), none, 0, "");
        a[1] = NativeV4FlashExecutor.NativeAction(0, address(0), USDC, 1, MANAGER, deep, 4295128740, "");   // a real PoolManager rejects limit 0
        a[2] = NativeV4FlashExecutor.NativeAction(0, USDC, address(0), 1, MANAGER, pushed, 1461446703485210103287273052203988822378723970341, "");
        a[3] = NativeV4FlashExecutor.NativeAction(2, address(0), WETH, 1, address(0), none, 0, "");
        NativeV4FlashExecutor.NativeBranch[] memory b = new NativeV4FlashExecutor.NativeBranch[](1);
        b[0] = NativeV4FlashExecutor.NativeBranch(principal, a);
        gasBefore = gasleft();
        e.executeNativeArbitrage(NativeV4FlashExecutor.NativeRoute(1, MORPHO, WETH, principal, b, 1, block.timestamp + 60));
        emit ForkProof("execute_gas", gasBefore - gasleft());
        uint256 surplus = ForkErc20(WETH).balanceOf(address(e));
        emit ForkProof("surplus_weth_wei", surplus);
        require(ForkErc20(WETH).balanceOf(MORPHO) == lenderBefore, "lender exactly repaid");
        require(surplus > 0 && address(e).balance == 0, "positive surplus in WETH custody, no stray native");
    }
}
