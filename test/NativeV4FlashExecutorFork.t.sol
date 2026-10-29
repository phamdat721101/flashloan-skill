// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {NativeV4FlashExecutor, NativePoolKey} from "../contracts/NativeV4FlashExecutor.sol";
import {FlashCallbackCore} from "../contracts/core/FlashCallbackCore.sol";

interface NativeForkVm {
    function envOr(string calldata, bool) external returns (bool);
    function skip(bool) external;
    function expectRevert(bytes4) external;
    function deal(address, uint256) external;
}
interface NativeForkToken { function balanceOf(address) external view returns (uint256); }

/// v7 lane B: NativeV4FlashExecutor against real Robinhood Morpho, WETH and the canonical v4 PoolManager.
/// Run with EVM_FORK_REQUIRED=true and an explicit archive --fork-url and --fork-block-number (see docs/deployments/robinhood-native-v4-fork-verification.json).
/// It proves the real lender, wrapper and swap paths and the profit guard, never a profitable route.
contract NativeV4FlashExecutorForkProof {
    NativeForkVm private constant vm = NativeForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address private constant MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address private constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    // Deepest hookless native pool in the 2026-10-29 MCP capture: ETH/0x2932..9ee2, fee 9000, tickSpacing 90 (poolId 0xbeb9..7cfd).
    address private constant TOKEN = 0x2932B2f5761cadCa5cB3e09D940092cA723D9EE2;
    uint24 private constant FEE = 9000;
    int24 private constant SPACING = 90;
    uint160 private constant LOW = 4295128740;
    uint160 private constant HIGH = 1461446703485210103287273052203988822378723970341;
    uint8 private constant SWAP = 0;
    uint8 private constant UNWRAP = 1;
    uint8 private constant WRAP = 2;

    function executor() private returns (NativeV4FlashExecutor e) {
        if (!vm.envOr("EVM_FORK_REQUIRED", false)) { vm.skip(true); return e; }
        require(block.chainid == 4663, "ROBINHOOD_FORK_REQUIRED");
        require(MORPHO.code.length > 0 && MANAGER.code.length > 0 && WETH.code.length > 0 && TOKEN.code.length > 0, "fork code missing");
        e = new NativeV4FlashExecutor(WETH, WETH.codehash);
        e.configureLender(1, MORPHO, MORPHO.codehash, true);
        e.configureManager(MANAGER, MANAGER.codehash, true);
    }

    function wrapAction(uint8 kind, uint256 amount) private pure returns (NativeV4FlashExecutor.NativeAction memory a) {
        a.kind = kind; a.minAmountOut = amount;
        (a.tokenIn, a.tokenOut) = kind == UNWRAP ? (WETH, address(0)) : (address(0), WETH);
    }

    function swapAction(address tokenIn, address tokenOut, uint160 limit) private pure returns (NativeV4FlashExecutor.NativeAction memory a) {
        a.kind = SWAP; a.tokenIn = tokenIn; a.tokenOut = tokenOut; a.minAmountOut = 1; a.manager = MANAGER; a.sqrtPriceLimitX96 = limit;
        a.key = NativePoolKey(address(0), TOKEN, FEE, SPACING, address(0));
    }

    function route(NativeV4FlashExecutor.NativeAction[] memory actions, uint256 principal) private view returns (NativeV4FlashExecutor.NativeRoute memory r) {
        NativeV4FlashExecutor.NativeBranch[] memory branches = new NativeV4FlashExecutor.NativeBranch[](1);
        branches[0] = NativeV4FlashExecutor.NativeBranch(principal, actions);
        r = NativeV4FlashExecutor.NativeRoute(1, MORPHO, WETH, principal, branches, 0, block.timestamp + 60);
    }

    /// Criteria 1 and 4: real Morpho WETH borrow, real unwrap/rewrap through the native ledger, exact repayment;
    /// pre-existing (forced) ETH stays custody and is never converted into surplus.
    function test_FLASHLOAN_V7_RH_EDGE_03_realBorrowUnwrapWrapExactRepay() external {
        NativeV4FlashExecutor e = executor();
        if (address(e) == address(0)) return;
        uint256 principal = 1 ether;
        uint256 lenderOpening = NativeForkToken(WETH).balanceOf(MORPHO);
        require(lenderOpening >= principal, "lender WETH below principal");
        vm.deal(address(e), 0.5 ether); // forced ETH present before the round
        NativeV4FlashExecutor.NativeAction[] memory actions = new NativeV4FlashExecutor.NativeAction[](2);
        actions[0] = wrapAction(UNWRAP, principal);
        actions[1] = wrapAction(WRAP, principal);
        e.executeNativeArbitrage(route(actions, principal));
        require(NativeForkToken(WETH).balanceOf(MORPHO) == lenderOpening, "lender not repaid exactly");
        require(NativeForkToken(WETH).balanceOf(address(e)) == 0, "phantom WETH surplus");
        require(address(e).balance == 0.5 ether, "forced ETH was spent or wrapped");
    }

    /// Criteria 2 and 3: real native v4 swaps (ETH -> TOKEN -> ETH) against non-zero liquidity complete,
    /// then the loss-making round reverts Unprofitable with full rollback. A zero-liquidity pool would revert earlier (InvalidRoute).
    function test_FLASHLOAN_V7_RH_EDGE_03_realNativeSwapsRejectUnfundedProfit() external {
        NativeV4FlashExecutor e = executor();
        if (address(e) == address(0)) return;
        uint256 principal = 0.0001 ether;
        uint256 lenderOpening = NativeForkToken(WETH).balanceOf(MORPHO);
        NativeV4FlashExecutor.NativeAction[] memory actions = new NativeV4FlashExecutor.NativeAction[](4);
        actions[0] = wrapAction(UNWRAP, principal);
        actions[1] = swapAction(address(0), TOKEN, LOW);
        actions[2] = swapAction(TOKEN, address(0), HIGH);
        actions[3] = wrapAction(WRAP, 1);
        // The final wrap must consume exactly the swap output; minAmountOut=1 keeps it valid for any non-zero output.
        actions[3].minAmountOut = 1;
        vm.expectRevert(FlashCallbackCore.Unprofitable.selector);
        e.executeNativeArbitrage(route(actions, principal));
        require(NativeForkToken(WETH).balanceOf(MORPHO) == lenderOpening, "rollback incomplete");
    }

    /// The executor refuses a hooked key before any external call (HooksDisabled), so the 7 hooked captured pools can never be routed.
    function test_FLASHLOAN_V7_RH_EDGE_03_hookedKeyRejectedBeforeBorrow() external {
        NativeV4FlashExecutor e = executor();
        if (address(e) == address(0)) return;
        NativeV4FlashExecutor.NativeAction[] memory actions = new NativeV4FlashExecutor.NativeAction[](4);
        actions[0] = wrapAction(UNWRAP, 1 ether);
        actions[1] = swapAction(address(0), TOKEN, LOW);
        actions[1].key.hooks = address(0x00000000000000000000000000000000000000C0);
        actions[2] = swapAction(TOKEN, address(0), HIGH);
        actions[3] = wrapAction(WRAP, 1);
        vm.expectRevert(NativeV4FlashExecutor.HooksDisabled.selector);
        e.executeNativeArbitrage(route(actions, 1 ether));
    }
}
