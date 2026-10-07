// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;

import {MultiVenueArbitrageExecutor} from "../contracts/MultiVenueArbitrageExecutor.sol";

contract MultiVenueArbitrageExecutorTest {
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
