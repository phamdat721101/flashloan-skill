// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;
import {V4StateQuoter} from "../contracts/V4StateQuoter.sol";
import {MVPoolKey, MVSwapParams, MVBalanceDelta} from "../contracts/MultiVenueArbitrageExecutor.sol";

contract TestStateQuoteManager {
    bool public changed;
    bytes32 private stateSlot;
    bytes32 private bitmapSlot;
    bytes32 private tickSlot;
    constructor(MVPoolKey memory key) {
        stateSlot = keccak256(abi.encode(keccak256(abi.encode(key)), uint256(6)));
        bitmapSlot = keccak256(abi.encode(int16(0), bytes32(uint256(stateSlot) + 5)));
        tickSlot = keccak256(abi.encode(int24(60), bytes32(uint256(stateSlot) + 4)));
    }
    function unlock(bytes calldata data) external returns (bytes memory) { return V4StateQuoter(msg.sender).unlockCallback(data); }
    function swap(MVPoolKey calldata, MVSwapParams calldata params, bytes calldata) external returns (MVBalanceDelta) {
        changed = true;
        uint128 amount = uint128(uint256(-params.amountSpecified));
        return MVBalanceDelta.wrap(params.zeroForOne ? (int256(-int128(amount)) << 128) | int256(uint256(amount - 4)) : (int256(uint256(amount - 4)) << 128) | int256(uint256(uint128(-int128(amount)))));
    }
    function extsload(bytes32 slot) external view returns (bytes32) {
        require(changed, "state captured before swap");
        if (slot == stateSlot) return bytes32(((uint256(1) << 96) - 1) | (uint256(uint24(int24(-1))) << 160) | (uint256(3000) << 208));
        if (slot == bytes32(uint256(stateSlot) + 3)) return bytes32(uint256(1500000));
        if (slot == bitmapSlot) return bytes32(uint256(1) << 60);
        if (slot == tickSlot) return bytes32(uint256(500000) | (uint256(500000) << 128));
        return bytes32(0);
    }
}
contract V4StateQuoterTest {
    function testQuoteCapturesPostHookBitmapTickAndFeeStateThenRevertsAllManagerChanges() external {
        V4StateQuoter quoter = new V4StateQuoter();
        MVPoolKey memory key = MVPoolKey(address(1), address(2), 0x800000, 1, address(3));
        TestStateQuoteManager manager = new TestStateQuoteManager(key);
        int16[] memory words = new int16[](2); words[0] = -1; words[1] = 0;
        for (uint256 i; i < 2; ++i) {
            V4StateQuoter.QuoteResult memory result = quoter.quoteExactInput(address(manager), key, true, 1000, 4295128740, bytes(""), words);
            require(int128(result.delta >> 128) == -1000 && int128(result.delta) == 996, "delta mismatch");
            require(result.tick == -1 && result.liquidity == 1500000 && result.lpFee == 3000, "post hook state not captured");
            require(result.bitmap[0] == 0 && result.bitmap[1] == uint256(1) << 60, "post hook bitmap missing");
            require(result.tickIndices.length == 1 && result.tickIndices[0] == 60 && result.liquidityGross[0] == 500000 && result.liquidityNet[0] == 500000, "post hook tick missing");
            require(!manager.changed(), "quote mutated manager state");
        }
    }
    function testQuoteRejectsUnauthorizedCallbackAndInvalidAmountBeforeCallingManager() external {
        V4StateQuoter quoter = new V4StateQuoter();
        (bool ok,) = address(quoter).call(abi.encodeCall(quoter.unlockCallback, bytes(""))); require(!ok, "direct callback accepted");
        MVPoolKey memory key = MVPoolKey(address(1), address(2), 3000, 1, address(0));
        int16[] memory words = new int16[](1);
        (ok,) = address(quoter).call(abi.encodeCall(quoter.quoteExactInput, (address(1), key, true, 0, uint160(1), bytes(""), words))); require(!ok, "zero amount accepted");
    }
}
