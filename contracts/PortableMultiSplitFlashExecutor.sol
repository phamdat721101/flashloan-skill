// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {MultiVenueArbitrageExecutor, IMVToken, IMVMorpho, IMVBalancer} from "./MultiVenueArbitrageExecutor.sol";

/// @notice Chain-configured split routes using the reviewed authenticated swap engine.
/// Profits remain in executor custody; only the owner can withdraw while idle.
contract PortableMultiSplitFlashExecutor is MultiVenueArbitrageExecutor {
    struct Branch { uint256 amountIn; Leg[] legs; }
    struct SplitRoute {
        uint8 kind; address lender; address flashAsset; uint256 flashAmount;
        Branch[] branches; uint256 minProfit; uint256 deadline;
    }
    bool private splitActive;
    bool private splitCompleted;
    bytes32 private splitHash;
    uint256 private splitOpening;
    address private splitLender;
    uint8 private splitKind;
    event SplitArbitrageExecuted(bytes32 indexed routeHash, address indexed asset, uint256 principal, uint256 profit, uint256 branches);

    function executeSplitArbitrage(SplitRoute calldata route) external onlyOwner onlyIdle {
        if (route.kind < 1 || route.kind > 2 || route.minProfit == 0 || route.branches.length == 0 || route.branches.length > 8 || route.flashAmount > uint256(type(int256).max)) revert InvalidRoute();
        bytes32 pin = trustedLenderCodeHash[route.kind][route.lender];
        if (pin == bytes32(0) || route.lender.codehash != pin) revert UntrustedRoot();
        uint256 allocation;
        for (uint256 i; i < route.branches.length; ++i) {
            _validateLegs(route.flashAsset, route.branches[i].amountIn, route.branches[i].legs, route.deadline);
            allocation += route.branches[i].amountIn;
        }
        if (allocation != route.flashAmount) revert InvalidRoute();
        bytes memory data = abi.encode(route);
        splitActive = true; splitCompleted = false; splitHash = keccak256(data);
        splitOpening = IMVToken(route.flashAsset).balanceOf(address(this));
        splitLender = route.lender; splitKind = route.kind; phase = Phase.AwaitingFlash;
        if (route.kind == 1) IMVMorpho(route.lender).flashLoan(route.flashAsset, route.flashAmount, data);
        else {
            address[] memory tokens = new address[](1); tokens[0] = route.flashAsset;
            uint256[] memory amounts = new uint256[](1); amounts[0] = route.flashAmount;
            IMVBalancer(route.lender).flashLoan(address(this), tokens, amounts, data);
        }
        if (!splitCompleted || phase != Phase.AwaitingFlash || IMVToken(route.flashAsset).balanceOf(address(this)) < splitOpening + route.minProfit) revert Unprofitable();
        splitActive = false; splitCompleted = false; splitHash = bytes32(0);
        splitOpening = 0; splitLender = address(0); splitKind = 0; phase = Phase.Idle;
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) public override {
        if (!splitActive) { super.onMorphoFlashLoan(assets, data); return; }
        SplitRoute memory route = _authenticateSplit(1, data);
        if (assets != route.flashAmount) revert InvalidRoute();
        _executeSplit(route, 0);
        _safeApprove(route.flashAsset, msg.sender, assets);
    }

    function receiveFlashLoan(address[] calldata tokens, uint256[] calldata amounts, uint256[] calldata fees, bytes calldata data) public override {
        if (!splitActive) { super.receiveFlashLoan(tokens, amounts, fees, data); return; }
        SplitRoute memory route = _authenticateSplit(2, data);
        if (tokens.length != 1 || amounts.length != 1 || fees.length != 1 || tokens[0] != route.flashAsset || amounts[0] != route.flashAmount) revert InvalidRoute();
        _executeSplit(route, fees[0]);
        _safeTransfer(route.flashAsset, msg.sender, amounts[0] + fees[0]);
    }

    function _authenticateSplit(uint8 kind, bytes calldata data) private returns (SplitRoute memory route) {
        if (phase != Phase.AwaitingFlash || splitCompleted || kind != splitKind || msg.sender != splitLender || keccak256(data) != splitHash || msg.sender.codehash != trustedLenderCodeHash[kind][msg.sender]) revert CallbackOnly();
        route = abi.decode(data, (SplitRoute));
        if (route.kind != kind || route.lender != msg.sender) revert InvalidRoute();
        splitCompleted = true;
    }

    function _executeSplit(SplitRoute memory route, uint256 fee) private {
        if (IMVToken(route.flashAsset).balanceOf(address(this)) < splitOpening + route.flashAmount) revert InvalidRoute();
        for (uint256 i; i < route.branches.length; ++i) {
            uint256 amount = route.branches[i].amountIn;
            for (uint256 j; j < route.branches[i].legs.length; ++j) amount = _executeLeg(route.branches[i].legs[j], amount);
        }
        uint256 closing = IMVToken(route.flashAsset).balanceOf(address(this));
        if (closing < splitOpening + route.flashAmount + fee + route.minProfit) revert Unprofitable();
        emit SplitArbitrageExecuted(splitHash, route.flashAsset, route.flashAmount, closing - splitOpening - route.flashAmount - fee, route.branches.length);
    }
}
