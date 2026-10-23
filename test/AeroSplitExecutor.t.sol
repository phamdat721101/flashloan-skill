// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {AeroSplitFlashExecutor} from "../contracts/AeroSplitFlashExecutor.sol";
import {TestToken} from "./ImmutableArbitrageExecutor.t.sol";
import {TestMorphoLender,TestBalancerLender} from "./MultiVenueArbitrageExecutor.t.sol";

contract TestAeroFactory {
    mapping(bytes32=>address) private pools;
    address public swapFeeModule;
    uint256 public feeBps=30;
    function setPool(address a,address b,bool stable,address pool) external {pools[keccak256(abi.encode(a,b,stable))]=pool;pools[keccak256(abi.encode(b,a,stable))]=pool;}
    function getPool(address a,address b,bool stable) external view returns(address){return pools[keccak256(abi.encode(a,b,stable))];}
    function getPool(address a,address b,int24) external view returns(address){return pools[keccak256(abi.encode(a,b,false))];}
    function getPool(address a,address b,uint24) external view returns(address){return pools[keccak256(abi.encode(a,b,false))];}
    function getPair(address a,address b) external view returns(address){return pools[keccak256(abi.encode(a,b,false))];}
    function getFee(address,bool) external view returns(uint256){return feeBps;}
    function setFee(uint256 value) external {feeBps=value;}
    function getSwapFee(address) external pure returns(uint24){return 3000;}
}
contract TestAeroPool {
    address public factory;address public token0;address public token1;bool public stable;
    uint256 private reserve0;uint256 private reserve1;
    constructor(address root,address a,address b,bool kind){factory=root;token0=a;token1=b;stable=kind;}
    function sync() external {reserve0=TestToken(token0).balanceOf(address(this));reserve1=TestToken(token1).balanceOf(address(this));}
    function getReserves() external view returns(uint256,uint256,uint256){return(reserve0,reserve1,0);}
    function getAmountOut(uint256 input,address asset) external view returns(uint256){input-=input*TestAeroFactory(factory).feeBps()/10000;return asset==token0?reserve1*input/(reserve0+input):reserve0*input/(reserve1+input);}
    function swap(uint256 a,uint256 b,address to,bytes calldata) external {
        require((a==0)!=(b==0),"one output");
        if(a>0)require(TestToken(token0).transfer(to,a));if(b>0)require(TestToken(token1).transfer(to,b));
        uint256 x=TestToken(token0).balanceOf(address(this));uint256 y=TestToken(token1).balanceOf(address(this));
        uint256 input0=x>reserve0-a?x-(reserve0-a):0;uint256 input1=y>reserve1-b?y-(reserve1-b):0;
        uint256 fee0=input0*TestAeroFactory(factory).feeBps()/10000;uint256 fee1=input1*TestAeroFactory(factory).feeBps()/10000;
        if(fee0>0){require(TestToken(token0).transfer(factory,fee0));x-=fee0;}
        if(fee1>0){require(TestToken(token1).transfer(factory,fee1));y-=fee1;}
        require(x*y>=reserve0*reserve1,"invariant");reserve0=x;reserve1=y;
    }
}
contract TestAeroCLPool {
    address public factory;address public token0;address public token1;int24 public tickSpacing=1;
    uint160 public price=79228162514264337593543950336;uint128 public liquidity=1000000000000;
    uint8 public attack;
    event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick);
    constructor(address root,address a,address b){factory=root;token0=a;token1=b;}
    function _quote(bool zero,uint256 consumed) private view returns(uint160 next,uint256 out) {
        uint256 net=consumed*997000/1000000;uint256 q=1<<96;uint256 L=uint256(liquidity);uint256 value;
        if(zero){uint256 n=L<<96;value=(n*price+n+net*price-1)/(n+net*price);out=L*(uint256(price)-value)/q;}
        else{value=uint256(price)+net*q/L;out=(L<<96)*(value-price)/value/price;}
        next=uint160(value);
    }
    function _emitSwap(address recipient,int256 a,int256 b) private {emit Swap(msg.sender,recipient,a,b,price,liquidity,a>0?int24(-1):int24(0));}
    function setAttack(uint8 value) external {attack=value;}
    function fee() external pure returns(uint24){return 3000;}
    function swap(address recipient,bool zero,int256 input,uint160,bytes calldata data) external returns(int256 a,int256 b){
        require(input>0);uint256 consumed=attack==3?uint256(input)/2:uint256(input);
        (uint160 next,uint256 out)=_quote(zero,consumed);
        require(TestToken(zero?token1:token0).transfer(recipient,out));
        a=zero?int256(consumed):-int256(out);b=zero?-int256(out):int256(consumed);
        AeroSplitFlashExecutor(msg.sender).uniswapV3SwapCallback(attack==2?int256(consumed):a,attack==2?int256(consumed):b,data);
        if(attack==1)AeroSplitFlashExecutor(msg.sender).uniswapV3SwapCallback(a,b,data);
        price=next;_emitSwap(recipient,a,b);
    }
}
contract AeroSplitExecutorTest {
    struct Fixture {AeroSplitFlashExecutor e;TestToken a;TestToken b;address lender;TestAeroPool first;TestAeroPool back;TestAeroCLPool cl;TestAeroFactory root;TestAeroFactory counter;}
    function setup(uint8 kind,bool stable,bool cl) private returns(Fixture memory f,AeroSplitFlashExecutor.AeroSplitRoute memory route) {
        TestToken a=new TestToken();TestToken b=new TestToken();(f.a,f.b)=address(a)<address(b)?(a,b):(b,a);
        f.e=new AeroSplitFlashExecutor();f.root=new TestAeroFactory();f.counter=new TestAeroFactory();f.counter.setFee(0);
        f.first=new TestAeroPool(address(f.root),address(f.a),address(f.b),stable);
        f.back=new TestAeroPool(address(f.counter),address(f.a),address(f.b),false);
        f.cl=new TestAeroCLPool(address(f.root),address(f.a),address(f.b));
        address first=cl?address(f.cl):address(f.first);
        f.root.setPool(address(f.a),address(f.b),stable,first);f.counter.setPool(address(f.a),address(f.b),false,address(f.back));
        f.a.mint(first,1000000);f.b.mint(first,cl?1000000:2000000);if(!cl)f.first.sync();
        f.a.mint(address(f.back),3000000);f.b.mint(address(f.back),1000000);f.back.sync();
        f.lender=kind==1?address(new TestMorphoLender()):address(new TestBalancerLender());f.a.mint(f.lender,1000000);f.a.mint(address(f.e),7);
        f.e.configureLender(kind,f.lender,f.lender.codehash,kind==1?0:3);
        f.e.configureFactory(cl?2:1,address(f.root),address(f.root).codehash);f.e.configureFactory(5,address(f.counter),address(f.counter).codehash);
        f.e.configurePool(first,first.codehash,first,first.codehash);f.e.configurePool(address(f.back),address(f.back).codehash,address(f.back),address(f.back).codehash);
        AeroSplitFlashExecutor.AeroLeg[] memory legs=new AeroSplitFlashExecutor.AeroLeg[](2);
        legs[0]=AeroSplitFlashExecutor.AeroLeg(cl?7:6,address(f.root),first,address(f.a),address(f.b),1,0,0,cl?uint160(4295128740):0,cl?int24(1):int24(0),stable,cl?2:1);
        legs[1]=AeroSplitFlashExecutor.AeroLeg(2,address(f.counter),address(f.back),address(f.b),address(f.a),1,cl?250:500,0,0,0,false,0);
        AeroSplitFlashExecutor.AeroBranch[] memory branches=new AeroSplitFlashExecutor.AeroBranch[](1);branches[0]=AeroSplitFlashExecutor.AeroBranch(100,legs);
        route=AeroSplitFlashExecutor.AeroSplitRoute(kind,f.lender,address(f.a),100,branches,1,block.timestamp+100);
    }
    function testBothLendersClassicAndStableIdentityPreserveOpeningFunds() external {
        for(uint8 kind=1;kind<=2;kind++)for(uint8 stable=0;stable<2;stable++){
            (Fixture memory f,AeroSplitFlashExecutor.AeroSplitRoute memory route)=setup(kind,stable==1,false);
            f.e.executeAeroSplitArbitrage(route);
            require(f.a.balanceOf(f.lender)==1000000+(kind==1?0:3));require(f.a.balanceOf(address(f.e))==7+500-100-(kind==1?0:3));
        }
        emit Proof("AERO_IMPL_EDGE_04");
    }
    event Proof(string marker);
    function testCLExactInputAndCanonicalCallback() external {
        (Fixture memory f,AeroSplitFlashExecutor.AeroSplitRoute memory route)=setup(1,false,true);f.e.executeAeroSplitArbitrage(route);require(f.a.balanceOf(address(f.e))==157);
    }
    function testV2RequestedOutputIsSeparateFromItsMinimum() external {
        (Fixture memory f,AeroSplitFlashExecutor.AeroSplitRoute memory route)=setup(1,false,false);route.branches[0].legs[1].minAmountOut=2;f.e.executeAeroSplitArbitrage(route);require(f.a.balanceOf(address(f.e))==407);
    }
    function testForgedDuplicateWrongDeltaAndPartialCLCallbacksRevert() external {
        for(uint8 attack=1;attack<=3;attack++){
            (Fixture memory f,AeroSplitFlashExecutor.AeroSplitRoute memory route)=setup(1,false,true);f.cl.setAttack(attack);(bool ok,)=address(f.e).call(abi.encodeCall(f.e.executeAeroSplitArbitrage,route));require(!ok&&f.a.balanceOf(address(f.e))==7&&f.a.balanceOf(f.lender)==1000000);
        }
        (Fixture memory f,)=setup(1,false,true);(bool ok,)=address(f.e).call(abi.encodeCall(f.e.uniswapV3SwapCallback,(int256(1),int256(-1),bytes(""))));require(!ok);
    }
    function testDuplicateLenderCallbackAndRevokedFactoryRollback() external {
        (Fixture memory f,AeroSplitFlashExecutor.AeroSplitRoute memory route)=setup(1,false,false);TestMorphoLender(f.lender).setDuplicate();(bool ok,)=address(f.e).call(abi.encodeCall(f.e.executeAeroSplitArbitrage,route));require(!ok);
        (f,route)=setup(1,false,false);f.e.configureFactory(1,address(f.root),0);(ok,)=address(f.e).call(abi.encodeCall(f.e.executeAeroSplitArbitrage,route));require(!ok&&f.a.balanceOf(address(f.e))==7);
    }
    function testOpeningBalancesAndAllocationCannotMaskLoss() external {
        (Fixture memory f,AeroSplitFlashExecutor.AeroSplitRoute memory route)=setup(1,false,false);route.minProfit=401;(bool ok,)=address(f.e).call(abi.encodeCall(f.e.executeAeroSplitArbitrage,route));require(!ok&&f.a.balanceOf(address(f.e))==7);
        route.minProfit=1;route.branches[0].amountIn=99;(ok,)=address(f.e).call(abi.encodeCall(f.e.executeAeroSplitArbitrage,route));require(!ok);
        route.branches[0].amountIn=100;route.deadline=0;(ok,)=address(f.e).call(abi.encodeCall(f.e.executeAeroSplitArbitrage,route));require(!ok);
    }
}

// Fork-only quote probe: read-only eth_call runs the real swap and callback.
interface IAeroProbePool {
    function swap(address,bool,int256,uint160,bytes calldata) external returns(int256,int256);
    function token0() external view returns(address);
    function token1() external view returns(address);
    function liquidity() external view returns(uint128);
}
contract AeroQuoteProbe {
    address private expected;
    function quote(address pool,bool zero,uint256 amount,uint160 limit) external returns(uint256 output,uint160 price,int24 tick,uint128 activeLiquidity) {
        require(expected==address(0));expected=pool;
        (int256 a,int256 b)=IAeroProbePool(pool).swap(address(this),zero,int256(amount),limit,"");
        require((zero?a:b)==int256(amount));output=uint256(-(zero?b:a));expected=address(0);
        (bool ok,bytes memory result)=pool.staticcall(abi.encodeWithSignature("slot0()"));require(ok);
        (price,tick)=abi.decode(result,(uint160,int24));activeLiquidity=IAeroProbePool(pool).liquidity();
    }
    function uniswapV3SwapCallback(int256 a,int256 b,bytes calldata) external {pay(a,b);}
    function pay(int256 a,int256 b) private {
        require(msg.sender==expected&&expected!=address(0));
        if(a>0)require(TestToken(IAeroProbePool(expected).token0()).transfer(expected,uint256(a)));
        if(b>0)require(TestToken(IAeroProbePool(expected).token1()).transfer(expected,uint256(b)));
    }
}
