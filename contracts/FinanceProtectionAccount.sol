// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {FlashCallbackCore, IFCToken} from "./core/FlashCallbackCore.sol";

interface IFPAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
}
/// Admitted exact-input swap adapter: pulls `amountIn` from the caller and returns at least `minOut` to `recipient`.
interface IFPSwapAdapter { function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient) external returns (uint256); }

/// @notice Finance R3: a user-owned smart account that owns one Aave V3 variable-debt position and can reduce its debt
/// atomically with a Morpho flash loan: repay → withdraw approved collateral → exact-route swap → repay flash → enforce bounds.
/// No arbitrary calls, delegatecall, bridge, standing approval or foreign collateral. Any failed condition reverts everything.
contract FinanceProtectionAccount is FlashCallbackCore {
    struct Protect {
        address debtAsset; uint256 flashAmount; address collateralAsset; uint256 withdrawAmount; uint256 minSwapOut;
        uint256 maxDebtAfter; uint256 minCollateralAfter; bytes32 nonce; uint256 deadline;
    }
    error NonceUsed(); error InsufficientRepay(); error PostconditionFailed(); error SwapShortfall();

    IFPAavePool public immutable pool;
    IFPSwapAdapter public immutable swapAdapter;
    address public immutable flashLender;
    address public immutable debtAsset;
    address public immutable collateralAsset;
    address public immutable variableDebtToken;
    address public immutable collateralAToken;
    mapping(bytes32 => bool) public usedNonce;

    event Protected(bytes32 indexed nonce, uint256 flashAmount, uint256 withdrawn, uint256 swapOut, uint256 debtAfter, uint256 collateralAfter);

    constructor(IFPAavePool pool_, IFPSwapAdapter swap_, address lender_, address debtAsset_, address collateralAsset_, address debtToken_, address aToken_) {
        pool = pool_; swapAdapter = swap_; flashLender = lender_; debtAsset = debtAsset_; collateralAsset = collateralAsset_; variableDebtToken = debtToken_; collateralAToken = aToken_;
    }

    // Ordinary owner management of the account's own position (no arbitrary calls).
    function supplyCollateral(uint256 amount) external onlyOwner onlyIdle { _safeApprove(collateralAsset, address(pool), amount); pool.supply(collateralAsset, amount, address(this), 0); _safeApprove(collateralAsset, address(pool), 0); }
    function borrowDebt(uint256 amount) external onlyOwner onlyIdle { pool.borrow(debtAsset, amount, 2, 0, address(this)); }
    function sweep(address token, uint256 amount) external onlyOwner onlyIdle { _safeTransfer(token, owner, amount); }

    function protect(Protect calldata p) external onlyOwner onlyIdle {
        if (block.timestamp > p.deadline) revert Expired();
        if (usedNonce[p.nonce]) revert NonceUsed();
        if (p.debtAsset != debtAsset || p.collateralAsset != collateralAsset || p.flashAmount == 0) revert InvalidRoute();
        usedNonce[p.nonce] = true;
        _borrow(MORPHO, flashLender, debtAsset, p.flashAmount, abi.encode(p));
        uint256 debtAfter = IFCToken(variableDebtToken).balanceOf(address(this));
        uint256 collateralAfter = IFCToken(collateralAToken).balanceOf(address(this));
        if (debtAfter > p.maxDebtAfter || collateralAfter < p.minCollateralAfter) revert PostconditionFailed();
        emit Protected(p.nonce, p.flashAmount, p.withdrawAmount, 0, debtAfter, collateralAfter);
    }

    function _onLoan(bytes calldata data, uint256 fee) internal override returns (address asset, uint256 amount) {
        Protect memory p = abi.decode(data, (Protect));
        _safeApprove(debtAsset, address(pool), p.flashAmount);
        pool.repay(debtAsset, p.flashAmount, 2, address(this));
        _safeApprove(debtAsset, address(pool), 0);
        if (p.withdrawAmount > 0) {
            pool.withdraw(collateralAsset, p.withdrawAmount, address(this));
            _safeApprove(collateralAsset, address(swapAdapter), p.withdrawAmount);
            uint256 before = IFCToken(debtAsset).balanceOf(address(this));
            swapAdapter.swapExactIn(collateralAsset, debtAsset, p.withdrawAmount, p.minSwapOut, address(this));
            _safeApprove(collateralAsset, address(swapAdapter), 0);
            if (IFCToken(debtAsset).balanceOf(address(this)) - before < p.minSwapOut) revert SwapShortfall();
        }
        if (IFCToken(debtAsset).balanceOf(address(this)) < p.flashAmount + fee) revert InsufficientRepay();
        return (debtAsset, p.flashAmount);
    }
}
