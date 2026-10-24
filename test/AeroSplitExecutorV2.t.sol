// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {AeroSplitFlashExecutorV2,AeroV4PoolKey,AeroV4SwapParams} from "../contracts/AeroSplitFlashExecutorV2.sol";
import {AeroSplitFlashExecutor} from "../contracts/AeroSplitFlashExecutor.sol";
import {TestToken} from "./ImmutableArbitrageExecutor.t.sol";
import {TestMorphoLender,TestBalancerLender} from "./MultiVenueArbitrageExecutor.t.sol";
import {TestAeroFactory,TestAeroPool,TestAeroCLPool} from "./AeroSplitExecutor.t.sol";

/// Strict PoolManager mock: per-caller currency deltas must net to zero when unlock returns,
/// constant-product pools keyed by PoolId, exact-input only (negative amountSpecified).
contract TestStrictV4Manager {
    mapping(address=>int256) public delta;
    address[] private touched;
    mapping(bytes32=>uint256[2]) public reserves;
    address private synced;uint256 private syncedBalance;
    bool public unlocked;
    uint8 public attack;
    function setAttack(uint8 value) external {attack=value;}
    function setPool(AeroV4PoolKey memory key,uint256 r0,uint256 r1) external {reserves[keccak256(abi.encode(key))]=[r0,r1];}
    function unlock(bytes calldata data) external returns(bytes memory result) {
        require(!unlocked,"nested");unlocked=true;
        result=AeroSplitFlashExecutorV2(msg.sender).unlockCallback(data);
        if(attack==1)AeroSplitFlashExecutorV2(msg.sender).unlockCallback(data);
        for(uint256 i;i<touched.length;i++)require(delta[touched[i]]==0,"currency not settled");
        delete touched;unlocked=false;
    }
    function _account(address c,int256 value) private {if(delta[c]==0)touched.push(c);delta[c]+=value;}
    function swap(AeroV4PoolKey memory key,AeroV4SwapParams memory params,bytes calldata) external returns(int256) {
        require(unlocked&&params.amountSpecified<0&&params.sqrtPriceLimitX96!=0);
        uint256[2] storage r=reserves[keccak256(abi.encode(key))];require(r[0]>0&&r[1]>0,"pool");
        uint256 input=uint256(-params.amountSpecified);if(attack==2)input/=2;
        uint256 net=input*(1000000-key.fee)/1000000;
        (uint256 rin,uint256 rout)=params.zeroForOne?(r[0],r[1]):(r[1],r[0]);
        uint256 out=net*rout/(rin+net);
        if(params.zeroForOne){r[0]+=input;r[1]-=out;}else{r[1]+=input;r[0]-=out;}
        (address cin,address cout)=params.zeroForOne?(key.currency0,key.currency1):(key.currency1,key.currency0);
        _account(cin,-int256(input));_account(cout,int256(out));
        int128 a0=params.zeroForOne?-int128(int256(input)):int128(int256(out));
        int128 a1=params.zeroForOne?int128(int256(out)):-int128(int256(input));
        return (int256(a0)<<128)|int256(uint256(uint128(a1)));
    }
    function sync(address c) external {synced=c;syncedBalance=TestToken(c).balanceOf(address(this));}
    function settle() external payable returns(uint256 paid) {
        require(unlocked);paid=TestToken(synced).balanceOf(address(this))-syncedBalance;_account(synced,int256(paid));synced=address(0);
    }
    function take(address c,address to,uint256 amount) external {require(unlocked);_account(c,-int256(amount));require(TestToken(c).transfer(to,amount));}
}

contract AeroSplitExecutorV2Test {
    event Proof(string marker);
    struct Fixture {AeroSplitFlashExecutorV2 e;TestToken a;TestToken b;address lender;TestAeroPool first;TestAeroPool back;TestAeroCLPool cl;TestAeroFactory root;TestAeroFactory counter;TestStrictV4Manager v4;}
    function _tokens(Fixture memory f) private {TestToken a=new TestToken();TestToken b=new TestToken();(f.a,f.b)=address(a)<address(b)?(a,b):(b,a);}
    function _key(Fixture memory f,uint24 fee) private pure returns(AeroV4PoolKey memory){return AeroV4PoolKey(address(f.a),address(f.b),fee,int24(60),address(0));}
    /// first leg venue: 6 classic, 7 CL, 8 V4; second leg: Uniswap V2 counter-pool (fee 0, on-chain output).
    function setup(uint8 kind,uint8 venue,bool stable) private returns(Fixture memory f,AeroSplitFlashExecutorV2.AeroSplitRoute memory route) {
        _tokens(f);f.e=new AeroSplitFlashExecutorV2();f.root=new TestAeroFactory();f.counter=new TestAeroFactory();f.counter.setFee(0);
        f.first=new TestAeroPool(address(f.root),address(f.a),address(f.b),stable);
        f.back=new TestAeroPool(address(f.counter),address(f.a),address(f.b),false);
        f.cl=new TestAeroCLPool(address(f.root),address(f.a),address(f.b));
        f.v4=new TestStrictV4Manager();
        f.counter.setPool(address(f.a),address(f.b),false,address(f.back));
        f.a.mint(address(f.back),3000000);f.b.mint(address(f.back),1000000);f.back.sync();
        address first=venue==7?address(f.cl):address(f.first);
        if(venue!=8){
            f.root.setPool(address(f.a),address(f.b),stable,first);f.a.mint(first,1000000);f.b.mint(first,venue==7?1000000:2000000);if(venue==6)f.first.sync();
            f.e.configureFactory(venue==7?2:1,address(f.root),address(f.root).codehash);f.e.configurePool(first,first.codehash,first,first.codehash);
        } else {
            f.v4.setPool(_key(f,0),1000000,2000000);f.a.mint(address(f.v4),1000000);f.b.mint(address(f.v4),2000000);
            f.e.configureFactory(7,address(f.v4),address(f.v4).codehash);f.e.configureV4Pool(keccak256(abi.encode(_key(f,0))),true);
        }
        f.e.configureFactory(5,address(f.counter),address(f.counter).codehash);f.e.configureV2Fee(address(f.counter),0,true);
        f.e.configurePool(address(f.back),address(f.back).codehash,address(f.back),address(f.back).codehash);
        if(kind==3){f.lender=address(f.v4);f.a.mint(address(f.v4),1000000);if(venue!=8)f.e.configureFactory(7,address(f.v4),address(f.v4).codehash);}
        else {f.lender=kind==1?address(new TestMorphoLender()):address(new TestBalancerLender());f.a.mint(f.lender,1000000);}
        f.a.mint(address(f.e),7);
        f.e.configureLender(kind,f.lender,f.lender.codehash,kind==2?3:0);
        AeroSplitFlashExecutorV2.AeroLeg[] memory legs=new AeroSplitFlashExecutorV2.AeroLeg[](2);
        if(venue==8)legs[0]=AeroSplitFlashExecutorV2.AeroLeg(8,address(f.v4),address(0),address(f.a),address(f.b),1,0,4295128740,int24(60),false,0,address(0));
        else legs[0]=AeroSplitFlashExecutorV2.AeroLeg(venue,address(f.root),first,address(f.a),address(f.b),1,0,venue==7?uint160(4295128740):0,venue==7?int24(1):int24(0),stable,venue==7?2:1,address(0));
        legs[1]=AeroSplitFlashExecutorV2.AeroLeg(2,address(f.counter),address(f.back),address(f.b),address(f.a),1,0,0,0,false,0,address(0));
        AeroSplitFlashExecutorV2.AeroBranch[] memory branches=new AeroSplitFlashExecutorV2.AeroBranch[](1);branches[0]=AeroSplitFlashExecutorV2.AeroBranch(100,legs);
        route=AeroSplitFlashExecutorV2.AeroSplitRoute(kind,f.lender,address(f.a),100,branches,1,block.timestamp+100);
    }
    function _ok(Fixture memory f,AeroSplitFlashExecutorV2.AeroSplitRoute memory route) private returns(bool ok){(ok,)=address(f.e).call(abi.encodeCall(f.e.executeAeroSplitArbitrage,route));}
    function _v2Out(uint256 input,uint256 rin,uint256 rout) private pure returns(uint256){return input*1000000*rout/(rin*1000000+input*1000000);}

    function testAllLendersClassicAndStableWithOnChainV2Output() external {
        for(uint8 kind=1;kind<=3;kind++)for(uint8 stable=0;stable<2;stable++){
            (Fixture memory f,AeroSplitFlashExecutorV2.AeroSplitRoute memory route)=setup(kind,6,stable==1);
            uint256 lenderBefore=f.a.balanceOf(f.lender);
            uint256 mid=f.first.getAmountOut(100,address(f.a));uint256 back=_v2Out(mid,1000000,3000000);
            uint256 profit=f.e.executeAeroSplitArbitrage(route);
            uint256 fee=kind==2?3:0;
            require(f.a.balanceOf(f.lender)==lenderBefore+fee,"lender repaid");
            require(profit==back-100-fee&&f.a.balanceOf(address(f.e))==7+back-100-fee,"custody");
        }
        emit Proof("AERO_V2_EDGE_04");
    }
    function testV2OutputUsesActualReservesNotAnEncodedQuote() external {
        (Fixture memory f,AeroSplitFlashExecutorV2.AeroSplitRoute memory route)=setup(1,6,false);
        f.b.mint(address(f.back),0);uint256 mid=f.first.getAmountOut(100,address(f.a));
        route.branches[0].legs[1].minAmountOut=_v2Out(mid,1000000,3000000)+1;require(!_ok(f,route),"min above on-chain output must revert");
        route.branches[0].legs[1].minAmountOut=_v2Out(mid,1000000,3000000);require(_ok(f,route));
    }
    function testUnconfiguredV2FeeAndForeignHooksReject() external {
        (Fixture memory f,AeroSplitFlashExecutorV2.AeroSplitRoute memory route)=setup(1,6,false);
        f.e.configureV2Fee(address(f.counter),0,false);require(!_ok(f,route));
        (f,route)=setup(1,6,false);route.branches[0].legs[1].hooks=address(1);require(!_ok(f,route));
        require(f.a.balanceOf(address(f.e))==7);
    }
    function testCLLegAndForgedCLCallbacksRevert() external {
        (Fixture memory f,AeroSplitFlashExecutorV2.AeroSplitRoute memory route)=setup(1,7,false);f.e.executeAeroSplitArbitrage(route);require(f.a.balanceOf(address(f.e))>7);
        for(uint8 attack=1;attack<=3;attack++){(f,route)=setup(1,7,false);f.cl.setAttack(attack);require(!_ok(f,route)&&f.a.balanceOf(address(f.e))==7);}
        (bool ok,)=address(f.e).call(abi.encodeCall(f.e.uniswapV3SwapCallback,(int256(1),int256(-1),bytes(""))));require(!ok);
    }
    function testV4SwapLegUnderMorphoAndInlineUnderV4Lender() external {
        for(uint8 kind=1;kind<=3;kind+=2){
            (Fixture memory f,AeroSplitFlashExecutorV2.AeroSplitRoute memory route)=setup(kind,8,false);
            uint256 hundred=100;uint256 mid=hundred*2000000/(1000000+hundred);uint256 back=_v2Out(mid,1000000,3000000);
            uint256 profit=f.e.executeAeroSplitArbitrage(route);
            require(profit==back-100&&f.a.balanceOf(address(f.e))==7+back-100,"v4 custody");
            require(f.v4.delta(address(f.a))==0&&f.v4.delta(address(f.b))==0&&!f.v4.unlocked(),"v4 settled");
        }
    }
    function testV4RejectsDynamicFeeHooksUntrustedPoolPartialFillAndForgedCallbacks() external {
        (Fixture memory f,AeroSplitFlashExecutorV2.AeroSplitRoute memory route)=setup(1,8,false);
        route.branches[0].legs[0].fee=0x800000;require(!_ok(f,route));
        (f,route)=setup(1,8,false);route.branches[0].legs[0].hooks=address(0xbeef);require(!_ok(f,route));
        (f,route)=setup(1,8,false);f.e.configureV4Pool(keccak256(abi.encode(_key(f,0))),false);require(!_ok(f,route));
        (f,route)=setup(1,8,false);route.branches[0].legs[0].sqrtPriceLimitX96=0;require(!_ok(f,route));
        (f,route)=setup(1,8,false);f.v4.setAttack(2);require(!_ok(f,route),"partial fill");
        (f,route)=setup(3,8,false);f.v4.setAttack(1);require(!_ok(f,route),"duplicate unlock callback");
        (f,route)=setup(1,8,false);
        (bool ok,)=address(f.e).call(abi.encodeCall(f.e.unlockCallback,(abi.encode(route))));require(!ok,"direct callback");
        require(f.a.balanceOf(address(f.e))==7);
    }
    function testQuoteAlwaysRevertsWithOrderedOutputsAndMovesNoFunds() external {
        for(uint8 venue=6;venue<=8;venue++){
            (Fixture memory f,AeroSplitFlashExecutorV2.AeroSplitRoute memory route)=setup(1,venue,false);
            route.minProfit=1;
            (bool ok,bytes memory data)=address(f.e).call(abi.encodeCall(f.e.quoteAeroSplit,route));
            require(!ok&&bytes4(data)==AeroSplitFlashExecutorV2.AeroQuote.selector,"AeroQuote");
            bytes memory body=new bytes(data.length-4);for(uint256 i;i<body.length;i++)body[i]=data[i+4];
            (uint256[] memory outs,uint24[] memory fees)=abi.decode(body,(uint256[],uint24[]));
            require(outs.length==2&&fees.length==2&&outs[0]>0&&outs[1]>0,"two legs");
            require(f.a.balanceOf(address(f.e))==7,"no funds moved");
            uint256 profit=f.e.executeAeroSplitArbitrage(route);require(profit==outs[1]-100,"quote matches execution");
        }
    }
    function testOwnerIdleDeadlineAndLossGuards() external {
        (Fixture memory f,AeroSplitFlashExecutorV2.AeroSplitRoute memory route)=setup(1,6,false);
        route.minProfit=10**9;require(!_ok(f,route)&&f.a.balanceOf(address(f.e))==7);
        route.minProfit=1;route.branches[0].amountIn=99;require(!_ok(f,route));
        route.branches[0].amountIn=100;route.deadline=0;require(!_ok(f,route));
        route.deadline=block.timestamp+1;route.kind=4;require(!_ok(f,route));
        Stranger s=new Stranger();require(!s.tryQuote(f.e,route));
        TestMorphoLender(f.lender).setDuplicate();route.kind=1;require(!_ok(f,route));
    }
    struct V1Fix {AeroSplitFlashExecutor v1;TestAeroFactory root;TestAeroFactory counter;TestAeroPool first;TestAeroPool back;TestMorphoLender lender;}
    function _v1(TestToken a,TestToken b) private returns(V1Fix memory x) {
        x.v1=new AeroSplitFlashExecutor();x.root=new TestAeroFactory();x.counter=new TestAeroFactory();x.counter.setFee(0);
        x.first=new TestAeroPool(address(x.root),address(a),address(b),false);x.back=new TestAeroPool(address(x.counter),address(a),address(b),false);
        x.root.setPool(address(a),address(b),false,address(x.first));x.counter.setPool(address(a),address(b),false,address(x.back));
        a.mint(address(x.first),1000000);b.mint(address(x.first),2000000);x.first.sync();a.mint(address(x.back),3000000);b.mint(address(x.back),1000000);x.back.sync();
        x.lender=new TestMorphoLender();a.mint(address(x.lender),1000000);a.mint(address(x.v1),7);
        x.v1.configureLender(1,address(x.lender),address(x.lender).codehash,0);x.v1.configureFactory(1,address(x.root),address(x.root).codehash);x.v1.configureFactory(5,address(x.counter),address(x.counter).codehash);
        x.v1.configurePool(address(x.first),address(x.first).codehash,address(x.first),address(x.first).codehash);x.v1.configurePool(address(x.back),address(x.back).codehash,address(x.back),address(x.back).codehash);
    }
    function _v1Route(V1Fix memory x,TestToken a,TestToken b) private view returns(AeroSplitFlashExecutor.AeroSplitRoute memory) {
        uint256 quoted=_v2Out(x.first.getAmountOut(100,address(a)),1000000,3000000);
        AeroSplitFlashExecutor.AeroLeg[] memory legs=new AeroSplitFlashExecutor.AeroLeg[](2);
        legs[0]=AeroSplitFlashExecutor.AeroLeg(6,address(x.root),address(x.first),address(a),address(b),1,0,0,0,0,false,1);
        legs[1]=AeroSplitFlashExecutor.AeroLeg(2,address(x.counter),address(x.back),address(b),address(a),1,quoted,0,0,0,false,0);
        AeroSplitFlashExecutor.AeroBranch[] memory branches=new AeroSplitFlashExecutor.AeroBranch[](1);branches[0]=AeroSplitFlashExecutor.AeroBranch(100,legs);
        return AeroSplitFlashExecutor.AeroSplitRoute(1,address(x.lender),address(a),100,branches,1,block.timestamp+100);
    }
    function testSingleValidationUsesLessGasThanV1() external {
        (Fixture memory f,AeroSplitFlashExecutorV2.AeroSplitRoute memory route)=setup(1,6,false);
        uint256 g=gasleft();f.e.executeAeroSplitArbitrage(route);uint256 v2Gas=g-gasleft();
        V1Fix memory x=_v1(f.a,f.b);AeroSplitFlashExecutor.AeroSplitRoute memory old=_v1Route(x,f.a,f.b);
        g=gasleft();x.v1.executeAeroSplitArbitrage(old);uint256 v1Gas=g-gasleft();
        require(v2Gas<v1Gas,"single validation must be cheaper");
    }
}
contract Stranger {
    function tryQuote(AeroSplitFlashExecutorV2 e,AeroSplitFlashExecutorV2.AeroSplitRoute memory route) external returns(bool ok) {
        bytes memory data;(ok,data)=address(e).call(abi.encodeCall(e.quoteAeroSplit,route));
        ok=!ok&&bytes4(data)==AeroSplitFlashExecutorV2.Unauthorized.selector?false:true;
    }
}
