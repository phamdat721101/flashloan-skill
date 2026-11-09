// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {FinanceProtectionAccount, IFPAavePool, IFPSwapAdapter} from "../contracts/FinanceProtectionAccount.sol";
import {FlashCallbackCore} from "../contracts/core/FlashCallbackCore.sol";
import {FinMockToken, FinMockAavePool, FinMockMorphoFlash, FinMockSwapAdapter} from "./finance/FinanceMocks.sol";

contract FinanceAttacker { function call(address target, bytes calldata data) external returns (bool ok) { (ok, ) = target.call(data); } }

/// E2E-19: R3 flash debt reduction in a position-owning smart account; every bad case reverts atomically.
contract FinanceProtectionAccountTest {
    FinMockToken usdc; FinMockToken weth; FinMockAavePool pool; FinMockMorphoFlash lender; FinMockSwapAdapter swap; FinanceProtectionAccount account;
    uint8 constant MORPHO = 1;

    function setUp() public {
        usdc = new FinMockToken(); weth = new FinMockToken();
        pool = new FinMockAavePool(usdc, weth); lender = new FinMockMorphoFlash(); swap = new FinMockSwapAdapter();
        usdc.mint(address(pool), 1_000_000e6); usdc.mint(address(lender), 1_000_000e6); usdc.mint(address(swap), 1_000_000e6);
        account = new FinanceProtectionAccount(IFPAavePool(address(pool)), IFPSwapAdapter(address(swap)), address(lender), address(usdc), address(weth), address(pool.vDebt()), address(pool.aCollateral()));
        account.configureLender(MORPHO, address(lender), address(lender).codehash, true);
        weth.mint(address(account), 1_000e6);
        account.supplyCollateral(1_000e6);
        account.borrowDebt(700e6);
    }

    function _params(uint256 flash, uint256 withdraw_, uint256 minOut, uint256 maxDebt, uint256 minColl, bytes32 nonce) internal view returns (FinanceProtectionAccount.Protect memory) {
        return FinanceProtectionAccount.Protect(address(usdc), flash, address(weth), withdraw_, minOut, maxDebt, minColl, nonce, block.timestamp + 60);
    }
    function _expectRevert(bytes memory call, bytes4 selector, string memory label) internal {
        (bool ok, bytes memory reason) = address(account).call(call);
        require(!ok, string.concat(label, ": unexpectedly succeeded"));
        if (selector != bytes4(0)) { require(reason.length >= 4 && bytes4(reason) == selector, string.concat(label, ": wrong revert reason")); }
    }

    function testProtectRepaysDebtInOneTransaction() external {
        account.protect(_params(300e6, 300e6, 300e6, 400e6, 700e6, keccak256("n1")));
        require(pool.vDebt().balanceOf(address(account)) == 400e6, "debt after");
        require(pool.aCollateral().balanceOf(address(account)) == 700e6, "collateral after");
        require(usdc.balanceOf(address(lender)) == 1_000_000e6, "flash principal repaid");
        require(usdc.balanceOf(address(account)) == 700e6, "only pre-existing borrowed residue remains");
    }
    function testRejectsNonOwner() external {
        FinanceAttacker attacker = new FinanceAttacker();
        bool ok = attacker.call(address(account), abi.encodeCall(FinanceProtectionAccount.protect, (_params(1, 0, 0, 1e30, 0, keccak256("x")))));
        require(!ok, "non-owner protect");
    }
    function testRejectsReplayedNonce() external {
        account.protect(_params(100e6, 100e6, 100e6, 600e6, 900e6, keccak256("n2")));
        _expectRevert(abi.encodeCall(FinanceProtectionAccount.protect, (_params(100e6, 100e6, 100e6, 600e6, 0, keccak256("n2")))), FinanceProtectionAccount.NonceUsed.selector, "replay");
    }
    function testRejectsWrongAssetPair() external {
        FinanceProtectionAccount.Protect memory p = _params(100e6, 100e6, 100e6, 1e30, 0, keccak256("n3"));
        p.collateralAsset = address(usdc);
        _expectRevert(abi.encodeCall(FinanceProtectionAccount.protect, (p)), FlashCallbackCore.InvalidRoute.selector, "asset pair");
    }
    function testRejectsSwapShortfallAndInsufficientRepay() external {
        swap.setRate(9_000); // 10% worse execution than approved minimum
        _expectRevert(abi.encodeCall(FinanceProtectionAccount.protect, (_params(300e6, 300e6, 300e6, 1e30, 0, keccak256("n4")))), bytes4(0), "swap minOut");
        // minOut honoured but proceeds cannot repay the flash principal: account holds 700e6 USDC from the borrow, so drain it first.
        account.sweep(address(usdc), 700e6);
        _expectRevert(abi.encodeCall(FinanceProtectionAccount.protect, (_params(300e6, 300e6, 270e6, 1e30, 0, keccak256("n5")))), FinanceProtectionAccount.InsufficientRepay.selector, "repay");
        require(pool.vDebt().balanceOf(address(account)) == 700e6, "state unchanged after revert");
    }
    function testRejectsPostconditionBreach() external {
        _expectRevert(abi.encodeCall(FinanceProtectionAccount.protect, (_params(300e6, 300e6, 300e6, 399e6, 0, keccak256("n6")))), FinanceProtectionAccount.PostconditionFailed.selector, "max debt");
        _expectRevert(abi.encodeCall(FinanceProtectionAccount.protect, (_params(300e6, 300e6, 300e6, 1e30, 701e6, keccak256("n7")))), FinanceProtectionAccount.PostconditionFailed.selector, "min collateral");
    }
    function testRejectsExpiredDeadline() external {
        FinanceProtectionAccount.Protect memory p = _params(100e6, 0, 0, 1e30, 0, keccak256("n8")); p.deadline = block.timestamp - 1;
        _expectRevert(abi.encodeCall(FinanceProtectionAccount.protect, (p)), FlashCallbackCore.Expired.selector, "deadline");
    }
    function testRejectsUntrustedLenderAndSpoofedCallback() external {
        account.configureLender(MORPHO, address(lender), bytes32(0), false);
        _expectRevert(abi.encodeCall(FinanceProtectionAccount.protect, (_params(100e6, 0, 0, 1e30, 0, keccak256("n9")))), FlashCallbackCore.UntrustedRoot.selector, "untrusted lender");
        FinanceAttacker attacker = new FinanceAttacker();
        bool ok = attacker.call(address(account), abi.encodeCall(FlashCallbackCore.onMorphoFlashLoan, (100e6, abi.encode(_params(100e6, 0, 0, 1e30, 0, keccak256("n10"))))));
        require(!ok, "spoofed callback accepted");
    }
}
