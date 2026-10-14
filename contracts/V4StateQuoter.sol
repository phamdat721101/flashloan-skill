// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {MVPoolKey, MVSwapParams, MVBalanceDelta} from "./MultiVenueArbitrageExecutor.sol";

interface IV4QuoteManager {
    function unlock(bytes calldata) external returns (bytes memory);
    function swap(MVPoolKey calldata, MVSwapParams calldata, bytes calldata) external returns (MVBalanceDelta);
    function extsload(bytes32) external view returns (bytes32);
}

/// @notice Read-only via eth_call. Capture post-hook state before reverting the entire unlock.
/// @dev Hook behavior is conditional on this quoter as sender; exact executor simulation remains mandatory.
contract V4StateQuoter {
    error Busy(); error CallbackOnly(); error ExpectedQuoteRevert();
    error QuoteOutcome(bytes result);
    struct QuoteResult {
        int256 delta; uint160 price; int24 tick; uint128 liquidity; uint24 protocolFee; uint24 lpFee;
        uint256[] bitmap; int24[] tickIndices; uint128[] liquidityGross; int128[] liquidityNet;
    }
    address private activeManager;
    bytes32 private activeRequest;

    function quoteExactInput(address manager, MVPoolKey calldata key, bool zeroForOne, uint256 amount, uint160 limit, bytes calldata hookData, int16[] calldata words)
        external returns (QuoteResult memory result)
    {
        if (activeManager != address(0)) revert Busy();
        if (manager.code.length == 0 || amount == 0 || amount > uint256(type(int256).max) || words.length == 0 || words.length > 256 || key.tickSpacing <= 0) revert ExpectedQuoteRevert();
        bytes memory data = abi.encode(key, zeroForOne, amount, limit, hookData, words);
        activeManager = manager; activeRequest = keccak256(data);
        try IV4QuoteManager(manager).unlock(data) { revert ExpectedQuoteRevert(); }
        catch (bytes memory reason) {
            bytes4 selector;
            assembly { selector := mload(add(reason, 32)) }
            if (reason.length < 68 || selector != QuoteOutcome.selector) {
                assembly { revert(add(reason, 32), mload(reason)) }
            }
            bytes memory body = new bytes(reason.length - 4);
            for (uint256 i; i < body.length; ++i) body[i] = reason[i + 4];
            result = abi.decode(abi.decode(body, (bytes)), (QuoteResult));
        }
        activeManager = address(0); activeRequest = bytes32(0);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != activeManager || activeManager == address(0) || keccak256(data) != activeRequest) revert CallbackOnly();
        (MVPoolKey memory key, bool zeroForOne, uint256 amount, uint160 limit, bytes memory hookData, int16[] memory words) = abi.decode(data, (MVPoolKey, bool, uint256, uint160, bytes, int16[]));
        QuoteResult memory result;
        result.delta = MVBalanceDelta.unwrap(IV4QuoteManager(msg.sender).swap(key, MVSwapParams(zeroForOne, -int256(amount), limit), hookData));
        bytes32 stateSlot = keccak256(abi.encode(keccak256(abi.encode(key)), uint256(6)));
        uint256 slot0 = uint256(IV4QuoteManager(msg.sender).extsload(stateSlot));
        result.liquidity = uint128(uint256(IV4QuoteManager(msg.sender).extsload(bytes32(uint256(stateSlot) + 3))));
        result.price = uint160(slot0); result.tick = int24(uint24(slot0 >> 160)); result.protocolFee = uint24(slot0 >> 184); result.lpFee = uint24(slot0 >> 208);
        result.bitmap = new uint256[](words.length);
        uint256 count;
        for (uint256 i; i < words.length; ++i) {
            uint256 word = uint256(IV4QuoteManager(msg.sender).extsload(keccak256(abi.encode(words[i], bytes32(uint256(stateSlot) + 5)))));
            result.bitmap[i] = word;
            while (word != 0) { word &= word - 1; if (++count > 10000) revert ExpectedQuoteRevert(); }
        }
        result.tickIndices = new int24[](count); result.liquidityGross = new uint128[](count); result.liquidityNet = new int128[](count);
        uint256 index;
        for (uint256 i; i < words.length; ++i) for (uint256 bit; bit < 256; ++bit) {
            if (result.bitmap[i] & (uint256(1) << bit) == 0) continue;
            int256 tick = (int256(words[i]) * 256 + int256(bit)) * int256(key.tickSpacing);
            if (tick < -887272 || tick > 887272) revert ExpectedQuoteRevert();
            uint256 packed = uint256(IV4QuoteManager(msg.sender).extsload(keccak256(abi.encode(int24(tick), bytes32(uint256(stateSlot) + 4)))));
            result.tickIndices[index] = int24(tick); result.liquidityGross[index] = uint128(packed); result.liquidityNet[index] = int128(uint128(packed >> 128)); ++index;
        }
        revert QuoteOutcome(abi.encode(result));
    }
}
