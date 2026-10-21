// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;
import {PortableMultiSplitFlashExecutor} from "../contracts/PortableMultiSplitFlashExecutor.sol";
import {MultiVenueArbitrageExecutor} from "../contracts/MultiVenueArbitrageExecutor.sol";
import {TestMorphoLender, TestBalancerLender} from "./MultiVenueArbitrageExecutor.t.sol";
import {TestToken, TestV4PoolManager} from "./ImmutableArbitrageExecutor.t.sol";

contract PortableMultiSplitFlashExecutorTest {
    function fixture(uint8 kind) private returns (PortableMultiSplitFlashExecutor e, TestToken token, address lender, PortableMultiSplitFlashExecutor.SplitRoute memory route) {
        TestToken a = new TestToken(); TestToken b = new TestToken();
        (TestToken t0, TestToken t1) = address(a) < address(b) ? (a,b) : (b,a);
        e = new PortableMultiSplitFlashExecutor(); token = t0;
        lender = kind == 1 ? address(new TestMorphoLender()) : address(new TestBalancerLender());
        t0.mint(lender,1000); t0.mint(address(e),7);
        e.configureLender(kind,lender,lender.codehash,true);
        PortableMultiSplitFlashExecutor.Branch[] memory branches = new PortableMultiSplitFlashExecutor.Branch[](2);
        for (uint256 i; i < 2; ++i) {
            TestV4PoolManager manager = new TestV4PoolManager(t0,t1);
            t0.mint(address(manager),1000); t1.mint(address(manager),1000);
            e.configureRoot(4,address(manager),address(manager).codehash,true,false);
            MultiVenueArbitrageExecutor.Leg[] memory legs = new MultiVenueArbitrageExecutor.Leg[](2);
            legs[0] = MultiVenueArbitrageExecutor.Leg(4,address(manager),address(0),address(t0),address(t1),60,500,0,10,address(0),bytes(""));
            legs[1] = MultiVenueArbitrageExecutor.Leg(4,address(manager),address(0),address(t1),address(t0),70,500,0,10,address(0),bytes(""));
            branches[i] = PortableMultiSplitFlashExecutor.Branch(50,legs);
        }
        route = PortableMultiSplitFlashExecutor.SplitRoute(kind,lender,address(t0),100,branches,kind == 1 ? 40 : 37,block.timestamp+1);
    }
    function testMorphoSplitRepaysPrincipalAndPreservesOpeningCustody() external {
        (PortableMultiSplitFlashExecutor e,TestToken token,address lender,PortableMultiSplitFlashExecutor.SplitRoute memory route) = fixture(1);
        e.executeSplitArbitrage(route);
        require(token.balanceOf(lender)==1000 && token.balanceOf(address(e))==47,"split custody");
    }
    function testBalancerSplitRepaysActualFee() external {
        (PortableMultiSplitFlashExecutor e,TestToken token,address lender,PortableMultiSplitFlashExecutor.SplitRoute memory route) = fixture(2);
        e.executeSplitArbitrage(route);
        require(token.balanceOf(lender)==1003 && token.balanceOf(address(e))==44,"fee custody");
    }
    function testOpeningBalanceCannotSubsidizeProfit() external {
        (PortableMultiSplitFlashExecutor e,TestToken token,address lender,PortableMultiSplitFlashExecutor.SplitRoute memory route) = fixture(1);
        route.minProfit=41;
        (bool ok,) = address(e).call(abi.encodeCall(e.executeSplitArbitrage,route));
        require(!ok && token.balanceOf(address(e))==7 && token.balanceOf(lender)==1000,"opening funds spent");
    }
    function testWrongAllocationExpiredRouteAndZeroMinimumRevert() external {
        (PortableMultiSplitFlashExecutor e,,,PortableMultiSplitFlashExecutor.SplitRoute memory route) = fixture(1);
        route.branches[0].amountIn=49;
        (bool ok,) = address(e).call(abi.encodeCall(e.executeSplitArbitrage,route)); require(!ok,"allocation");
        route.branches[0].amountIn=50; route.deadline=0;
        (ok,) = address(e).call(abi.encodeCall(e.executeSplitArbitrage,route)); require(!ok,"deadline");
        route.deadline=block.timestamp+1; route.branches[0].legs[0].minAmountOut=0;
        (ok,) = address(e).call(abi.encodeCall(e.executeSplitArbitrage,route)); require(!ok,"slippage");
    }
    function testDirectDuplicateAndUntrustedCallbacksRevertAtomically() external {
        (PortableMultiSplitFlashExecutor e,TestToken token,address lender,PortableMultiSplitFlashExecutor.SplitRoute memory route) = fixture(1);
        (bool ok,) = address(e).call(abi.encodeCall(e.onMorphoFlashLoan,(100,abi.encode(route)))); require(!ok,"direct callback");
        TestMorphoLender(lender).setDuplicate();
        (ok,) = address(e).call(abi.encodeCall(e.executeSplitArbitrage,route)); require(!ok && token.balanceOf(address(e))==7,"duplicate callback");
        e.configureLender(1,lender,bytes32(0),false);
        (ok,) = address(e).call(abi.encodeCall(e.executeSplitArbitrage,route)); require(!ok,"revoked lender");
    }
}
