// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IUniswapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);
}

interface ICamelotRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 limitSqrtPrice;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);
}

/**
 * @title ArbitrumMultiSplitFlashExecutor
 * @notice Production Flash Loan Executor for Arbitrum One mainnet.
 *         Supports >= $100k Morpho Blue 0%-fee flash loans with:
 *          1. Multi-pool convex split routes across non-USDC assets (WETH, ARB, USDT, etc.).
 *          2. Multi-hop triangular routing across DEX venues (PancakeSwap, Camelot, Uniswap).
 *          3. Dynamic intermediate balance unwinding avoiding 1-wei rounding mismatches.
 *          4. 100% atomic profit verification and sweep to treasury.
 */
contract ArbitrumMultiSplitFlashExecutor {
    address public immutable owner;
    address public constant MORPHO_BLUE = 0x6c247b1F6182318877311737BaC0844bAa518F5e;
    address public constant UNISWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public constant PANCAKESWAP_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    address public constant CAMELOT_ROUTER = 0x1F721E2E82F6676FCE4eA07A5958cF098D339e18;

    address public treasury;

    enum DexVenue {
        PANCAKESWAP_V3,
        CAMELOT_V3,
        UNISWAP_V3
    }

    enum ActionType {
        MULTI_SPLIT_PAIR,
        TRIANGULAR_MULTI_HOP
    }

    struct SplitPairLeg {
        address targetToken;
        uint256 amountIn;
        DexVenue buyVenue;
        DexVenue sellVenue;
        uint24 buyFee;
        uint24 sellFee;
    }

    struct MultiSplitPairParams {
        address flashToken;
        uint256 flashAmount;
        uint256 minProfit;
        SplitPairLeg[] legs;
    }

    struct TriangularHop {
        address tokenIn;
        address tokenOut;
        DexVenue venue;
        uint24 fee;
        uint256 amountIn; // 0 = use entire balance
    }

    struct TriangularParams {
        address flashToken;
        uint256 flashAmount;
        uint256 minProfit;
        TriangularHop[] hops;
    }

    error Unauthorized();
    error OnlyMorphoCaller();
    error InsufficientProfit(uint256 actualProfit, uint256 minRequired);
    error SwapFailed(uint256 legIndex);
    error SafeTransferFailed();
    error SafeApproveFailed();

    event MultiSplitArbitrageExecuted(
        address indexed flashToken,
        uint256 flashAmount,
        uint256 netProfit,
        uint256 legsExecuted
    );
    event ProfitSwept(address indexed token, uint256 amount, address indexed recipient);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyMorpho() {
        if (msg.sender != MORPHO_BLUE) revert OnlyMorphoCaller();
        _;
    }

    constructor(address _treasury) {
        owner = msg.sender;
        treasury = _treasury == address(0) ? msg.sender : _treasury;
    }

    /**
     * @notice Execute multi-pool split pair arbitrage funded by >= $100k Morpho Blue flash loan
     */
    function executeMultiSplitPairArbitrage(MultiSplitPairParams calldata params) external onlyOwner {
        bytes memory payload = abi.encode(ActionType.MULTI_SPLIT_PAIR, params);
        IMorpho(MORPHO_BLUE).flashLoan(params.flashToken, params.flashAmount, payload);
    }

    /**
     * @notice Execute multi-hop triangular arbitrage funded by >= $100k Morpho Blue flash loan
     */
    function executeTriangularArbitrage(TriangularParams calldata params) external onlyOwner {
        bytes memory payload = abi.encode(ActionType.TRIANGULAR_MULTI_HOP, params);
        IMorpho(MORPHO_BLUE).flashLoan(params.flashToken, params.flashAmount, payload);
    }

    /**
     * @notice Morpho Blue callback
     */
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external onlyMorpho {
        ActionType action = abi.decode(data, (ActionType));

        if (action == ActionType.MULTI_SPLIT_PAIR) {
            (, MultiSplitPairParams memory p) = abi.decode(data, (ActionType, MultiSplitPairParams));
            _handleMultiSplitPair(assets, p);
        } else if (action == ActionType.TRIANGULAR_MULTI_HOP) {
            (, TriangularParams memory p) = abi.decode(data, (ActionType, TriangularParams));
            _handleTriangular(assets, p);
        }
    }

    function _handleMultiSplitPair(uint256 assets, MultiSplitPairParams memory p) internal {
        for (uint256 i = 0; i < p.legs.length; i++) {
            SplitPairLeg memory leg = p.legs[i];
            if (leg.amountIn > 0 && leg.targetToken != address(0)) {
                // Leg 1: Buy targetToken with flashToken
                _swap(
                    _getRouter(leg.buyVenue),
                    p.flashToken,
                    leg.targetToken,
                    leg.amountIn,
                    leg.buyFee,
                    leg.buyVenue == DexVenue.CAMELOT_V3
                );

                // Leg 2: Sell 100% of targetToken back to flashToken dynamically
                uint256 targetBalance = IERC20(leg.targetToken).balanceOf(address(this));
                if (targetBalance > 0) {
                    _swap(
                        _getRouter(leg.sellVenue),
                        leg.targetToken,
                        p.flashToken,
                        targetBalance,
                        leg.sellFee,
                        leg.sellVenue == DexVenue.CAMELOT_V3
                    );
                }
            }
        }

        // Verify ending balance
        uint256 endingBalance = IERC20(p.flashToken).balanceOf(address(this));
        if (endingBalance < assets + p.minProfit) {
            revert InsufficientProfit(endingBalance > assets ? endingBalance - assets : 0, p.minProfit);
        }

        // Repay Morpho Blue
        _safeApprove(p.flashToken, MORPHO_BLUE, assets);

        // Sweep profit to treasury
        uint256 netProfit = endingBalance - assets;
        if (netProfit > 0) {
            _safeTransfer(p.flashToken, treasury, netProfit);
            emit ProfitSwept(p.flashToken, netProfit, treasury);
        }

        emit MultiSplitArbitrageExecuted(p.flashToken, assets, netProfit, p.legs.length);
    }

    function _handleTriangular(uint256 assets, TriangularParams memory p) internal {
        for (uint256 i = 0; i < p.hops.length; i++) {
            TriangularHop memory hop = p.hops[i];
            uint256 inAmt = hop.amountIn == 0 ? IERC20(hop.tokenIn).balanceOf(address(this)) : hop.amountIn;
            if (inAmt > 0) {
                _swap(
                    _getRouter(hop.venue),
                    hop.tokenIn,
                    hop.tokenOut,
                    inAmt,
                    hop.fee,
                    hop.venue == DexVenue.CAMELOT_V3
                );
            }
        }

        // Verify ending balance
        uint256 endingBalance = IERC20(p.flashToken).balanceOf(address(this));
        if (endingBalance < assets + p.minProfit) {
            revert InsufficientProfit(endingBalance > assets ? endingBalance - assets : 0, p.minProfit);
        }

        // Repay Morpho Blue
        _safeApprove(p.flashToken, MORPHO_BLUE, assets);

        // Sweep profit to treasury
        uint256 netProfit = endingBalance - assets;
        if (netProfit > 0) {
            _safeTransfer(p.flashToken, treasury, netProfit);
            emit ProfitSwept(p.flashToken, netProfit, treasury);
        }

        emit MultiSplitArbitrageExecuted(p.flashToken, assets, netProfit, p.hops.length);
    }

    function _swap(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee,
        bool isCamelot
    ) internal returns (uint256 amountOut) {
        _safeApprove(tokenIn, router, amountIn);
        if (isCamelot) {
            ICamelotRouter.ExactInputSingleParams memory params = ICamelotRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: amountIn,
                amountOutMinimum: 0,
                limitSqrtPrice: 0
            });
            amountOut = ICamelotRouter(router).exactInputSingle(params);
        } else {
            IUniswapRouter.ExactInputSingleParams memory params = IUniswapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            });
            amountOut = IUniswapRouter(router).exactInputSingle(params);
        }
    }

    function _getRouter(DexVenue venue) internal pure returns (address) {
        if (venue == DexVenue.PANCAKESWAP_V3) return PANCAKESWAP_ROUTER;
        if (venue == DexVenue.CAMELOT_V3) return CAMELOT_ROUTER;
        return UNISWAP_ROUTER;
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Zero address");
        treasury = _treasury;
    }

    function sweepToken(address token, address recipient) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) _safeTransfer(token, recipient, balance);
    }

    function sweepETH(address payable recipient) external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = recipient.call{value: balance}("");
            if (!success) revert SafeTransferFailed();
        }
    }

    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool success, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        if (!success || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            // USDT reset allowance to 0 first
            token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, 0));
            (bool success2, bytes memory ret2) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
            if (!success2 || (ret2.length != 0 && !abi.decode(ret2, (bool)))) revert SafeApproveFailed();
        }
    }

    function _safeTransfer(address token, address recipient, uint256 amount) internal {
        (bool success, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, recipient, amount));
        if (!success || (ret.length != 0 && !abi.decode(ret, (bool)))) revert SafeTransferFailed();
    }
}
