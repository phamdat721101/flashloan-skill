// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

interface IExactSwapPool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256, int256);
}

interface IProbeToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @notice Never deployed: injected with an eth_call state override. Runs a concentrated-liquidity pool's real
/// exact-input swap (Uniswap V3 forks, PancakeSwap V3, Algebra, Slipstream) and reverts from the callback with the
/// deltas, so the quote includes fees, tick crossings and price impact at the pinned block. Nothing is paid.
contract ExactSwapQuoter {
    error PartialFill();
    error NoCallback();

    uint160 private constant MIN_SQRT = 4295128740;
    uint160 private constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    function quote(address pool, bool zeroForOne, uint256 amountIn) external returns (uint256 amountOut) {
        try IExactSwapPool(pool).swap(address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT : MAX_SQRT, "") {
            revert NoCallback();
        } catch (bytes memory reason) {
            if (reason.length != 64) assembly { revert(add(reason, 32), mload(reason)) }
            (int256 amount0, int256 amount1) = abi.decode(reason, (int256, int256));
            if ((zeroForOne ? amount0 : amount1) < int256(amountIn)) revert PartialFill();
            amountOut = uint256(-(zeroForOne ? amount1 : amount0));
        }
    }

    /// token-behavior/1 (PRD §5.5 R0b): transfers `amount` held through a balance-slot state override and reports what
    /// `to` actually received, so transfer/sell taxes and blacklists show at the pinned block. ok=false means it reverted.
    function probeTransfer(address token, address to, uint256 amount) external returns (bool ok, uint256 received) {
        uint256 before = IProbeToken(token).balanceOf(to);
        (bool success, bytes memory r) = token.call(abi.encodeWithSelector(IProbeToken.transfer.selector, to, amount));
        if (!success || (r.length != 0 && (r.length < 32 || !abi.decode(r, (bool))))) return (false, 0);
        uint256 afterBalance = IProbeToken(token).balanceOf(to);
        return (true, afterBalance > before ? afterBalance - before : 0);
    }

    function uniswapV3SwapCallback(int256 amount0, int256 amount1, bytes calldata) external pure { _report(amount0, amount1); }
    function pancakeV3SwapCallback(int256 amount0, int256 amount1, bytes calldata) external pure { _report(amount0, amount1); }
    function algebraSwapCallback(int256 amount0, int256 amount1, bytes calldata) external pure { _report(amount0, amount1); }

    function _report(int256 amount0, int256 amount1) private pure {
        assembly { mstore(0, amount0) mstore(32, amount1) revert(0, 64) }
    }
}
