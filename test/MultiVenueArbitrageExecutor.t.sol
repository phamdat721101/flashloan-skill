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

/// @notice Read-only fork proof for the live deployment. Run with
/// `forge test --fork-url "$ARBITRUM_RPC_URL"`; it never broadcasts.
contract MultiVenueArbitrageExecutorArbitrumForkProof {
    address private constant EXECUTOR = 0xD130B45b7E7D08FB7DbB1c79FA5d9B95Ea8e27B2;
    address private constant OWNER = 0xc75aAeBD1F395cFc9e7c7f291Ea32d5C9d4c270a;
    address private constant AAVE_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    address private constant V2_FACTORY = 0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9;
    address private constant V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address private constant V4_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
    bytes32 private constant AAVE_HASH = 0x1a95f317ee56e0b9aedc4f4b7abd9e546dc45c26d1d77e95bcf62b789d9a5486;
    bytes32 private constant V2_HASH = 0xbab145d02e7005f0d84c6c1639d39b799b0ea16df99ebbdaf5a14d9da820b4e0;
    bytes32 private constant V3_HASH = 0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69;
    bytes32 private constant V4_HASH = 0xe4b2759e456c9c4ef763e3b4e257c5105e1ba283d7de8b131dd321197de794a4;

    function testForkDeploymentPinsExactRootsAndDisablesHooks() external view {
        if (block.chainid != 42161) return;
        MultiVenueArbitrageExecutor executor = MultiVenueArbitrageExecutor(EXECUTOR);
        require(executor.owner() == OWNER, "owner mismatch");
        require(EXECUTOR.codehash == 0xb9e2738a3643a2b8dc566f475df658f610a9f6d587d5d2ebea072104a4fccbed, "executor code drift");
        require(executor.trustedAaveProviderCodeHash(AAVE_PROVIDER) == AAVE_HASH, "aave pin mismatch");
        require(executor.trustedV2FactoryCodeHash(V2_FACTORY) == V2_HASH, "v2 pin mismatch");
        require(executor.trustedV3FactoryCodeHash(V3_FACTORY) == V3_HASH, "v3 pin mismatch");
        require(executor.trustedV4ManagerCodeHash(V4_MANAGER) == V4_HASH, "v4 pin mismatch");
        require(!executor.v4HooksAllowed(V4_MANAGER), "hooks unexpectedly enabled");
    }
}
