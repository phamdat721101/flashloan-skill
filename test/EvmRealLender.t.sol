// SPDX-License-Identifier: MIT
pragma solidity >=0.8.25 <0.9.0;
interface EvmForkVm { function envOr(string calldata,bool) external returns(bool); function skip(bool) external; }
interface ForkToken { function balanceOf(address) external view returns(uint256); function approve(address,uint256) external returns(bool); }
interface ForkMorpho { function flashLoan(address,uint256,bytes calldata) external; }
contract ExactRepayBorrower {
    address private lender;
    address private token;
    bool public completed;
    function borrow(address l,address t) external {
        require(lender==address(0)); lender=l;token=t;
        ForkMorpho(l).flashLoan(t,1,abi.encode(l,t));
        require(completed && ForkToken(t).balanceOf(address(this))==0,"repayment missing");
    }
    function onMorphoFlashLoan(uint256 assets,bytes calldata data) external {
        require(msg.sender==lender && !completed && assets==1 && keccak256(data)==keccak256(abi.encode(lender,token)),"callback mismatch");
        require(ForkToken(token).balanceOf(address(this))==1,"principal missing");
        completed=true;require(ForkToken(token).approve(lender,1));
    }
}
/// Run with EVM_FORK_REQUIRED=true and an explicit Base/Robinhood --fork-url.
/// This proves the real lender callback and pull repayment, never a profitable AMM route.
contract EvmRealLenderForkProof {
    EvmForkVm private constant vm=EvmForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function testRequiredRealMorphoBorrowAndExactRepayment() external {
        if(!vm.envOr("EVM_FORK_REQUIRED",false)){vm.skip(true);return;}
        require(block.chainid==8453 || block.chainid==4663,"EVM_TARGET_FORK_REQUIRED");
        address lender=block.chainid==8453?address(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb):address(0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010);
        address token=block.chainid==8453?address(0x4200000000000000000000000000000000000006):address(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
        require(lender.code.length>0 && token.code.length>0,"fork code missing");
        uint256 opening=ForkToken(token).balanceOf(lender);require(opening>0,"lender empty");
        ExactRepayBorrower b=new ExactRepayBorrower();b.borrow(lender,token);
        require(b.completed() && ForkToken(token).balanceOf(lender)==opening,"lender balance changed");
    }
}

import {MultiVenueArbitrageExecutor, MVPoolKey, IMVToken} from "../contracts/MultiVenueArbitrageExecutor.sol";
import {PortableMultiSplitFlashExecutor} from "../contracts/PortableMultiSplitFlashExecutor.sol";
import {V4StateQuoter} from "../contracts/V4StateQuoter.sol";
import {ImmutableArbitrageExecutor, PoolKey} from "../contracts/ImmutableArbitrageExecutor.sol";

/// Real target AMM/lender negative proof: both swaps must finish before profit rejection.
contract EvmTargetExecutorForkProof {
    EvmForkVm private constant vm=EvmForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint160 private constant HIGH=1461446703485210103287273052203988822378723970341;
    uint160 private constant LOW=4295128740;
    function target() private returns(address lender,address manager,address wrapped,address stable) {
        if(!vm.envOr("EVM_FORK_REQUIRED",false)){vm.skip(true);return(address(0),address(0),address(0),address(0));}
        require(block.chainid==8453 || block.chainid==4663,"EVM_TARGET_FORK_REQUIRED");
        if(block.chainid==8453)return(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb,0x498581fF718922c3f8e6A244956aF099B2652b2b,0x4200000000000000000000000000000000000006,0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
        return(0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010,0x8366a39CC670B4001A1121B8F6A443A643e40951,0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    }
    function legs(address manager,address wrapped,address stable) private pure returns(MultiVenueArbitrageExecutor.Leg[] memory r) {
        r=new MultiVenueArbitrageExecutor.Leg[](2);
        r[0]=MultiVenueArbitrageExecutor.Leg(4,manager,address(0),stable,wrapped,1,500,HIGH,10,address(0),"");
        r[1]=MultiVenueArbitrageExecutor.Leg(4,manager,address(0),wrapped,stable,1,3000,LOW,60,address(0),"");
    }
    function testTargetMultiVenueRealSwapsRejectUnfundedProfit() external {
        (address lender,address manager,address wrapped,address stable)=target();
        MultiVenueArbitrageExecutor e=new MultiVenueArbitrageExecutor();
        e.configureLender(1,lender,lender.codehash,true);e.configureRoot(4,manager,manager.codehash,true,false);
        uint256 opening=IMVToken(stable).balanceOf(lender);
        try e.executeLenderArbitrage(MultiVenueArbitrageExecutor.LenderRoute(1,lender,stable,1000000,legs(manager,wrapped,stable),1e30,block.timestamp+60)){revert("unfunded profit passed");}
        catch(bytes memory reason){require(bytes4(reason)==MultiVenueArbitrageExecutor.Unprofitable.selector,"failed before profit check");}
        require(IMVToken(stable).balanceOf(lender)==opening && IMVToken(stable).balanceOf(address(e))==0,"atomic rollback failed");
    }
    function testTargetPortableSplitRealSwapsRejectUnfundedProfit() external {
        (address lender,address manager,address wrapped,address stable)=target();
        PortableMultiSplitFlashExecutor e=new PortableMultiSplitFlashExecutor();
        e.configureLender(1,lender,lender.codehash,true);e.configureRoot(4,manager,manager.codehash,true,false);
        PortableMultiSplitFlashExecutor.Branch[] memory branches=new PortableMultiSplitFlashExecutor.Branch[](1);
        branches[0]=PortableMultiSplitFlashExecutor.Branch(1000000,legs(manager,wrapped,stable));
        uint256 opening=IMVToken(stable).balanceOf(lender);
        try e.executeSplitArbitrage(PortableMultiSplitFlashExecutor.SplitRoute(1,lender,stable,1000000,branches,1e30,block.timestamp+60)){revert("unfunded profit passed");}
        catch(bytes memory reason){require(bytes4(reason)==MultiVenueArbitrageExecutor.Unprofitable.selector,"failed before split profit check");}
        require(IMVToken(stable).balanceOf(lender)==opening && IMVToken(stable).balanceOf(address(e))==0,"split atomic rollback failed");
    }
    function testTargetQuoterRealSwapRevertsManagerState() external {
        (,address manager,address wrapped,address stable)=target();
        V4StateQuoter q=new V4StateQuoter();MVPoolKey memory key=MVPoolKey(wrapped,stable,500,10,address(0));
        bytes32 slot=keccak256(abi.encode(keccak256(abi.encode(key)),uint256(6)));
        (bool ok,bytes memory beforeState)=manager.staticcall(abi.encodeWithSignature("extsload(bytes32)",slot));require(ok);
        int16[] memory words=new int16[](1);words[0]=-78;
        V4StateQuoter.QuoteResult memory quoted=q.quoteExactInput(manager,key,false,1000000,HIGH,"",words);
        require(quoted.delta!=0,"no real swap");
        (,bytes memory afterState)=manager.staticcall(abi.encodeWithSignature("extsload(bytes32)",slot));require(keccak256(beforeState)==keccak256(afterState),"quote persisted state");
    }
    function testTargetImmutableAaveV4RealSwapsRejectUnfundedProfit() external {
        (,address manager,address wrapped,address stable)=target();
        if(block.chainid!=8453){vm.skip(true);return;}
        address provider=0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D;
        ImmutableArbitrageExecutor e=new ImmutableArbitrageExecutor();e.configureAaveProvider(provider,provider.codehash,true);e.configurePoolManager(manager,manager.codehash,true,false);
        ImmutableArbitrageExecutor.V4Hop[] memory hops=new ImmutableArbitrageExecutor.V4Hop[](2);
        PoolKey memory a=PoolKey(wrapped,stable,500,10,address(0));PoolKey memory b=PoolKey(wrapped,stable,3000,60,address(0));
        hops[0]=ImmutableArbitrageExecutor.V4Hop(a,keccak256(abi.encode(a)),false,HIGH,"");hops[1]=ImmutableArbitrageExecutor.V4Hop(b,keccak256(abi.encode(b)),true,LOW,"");
        try e.executeV4Arbitrage(ImmutableArbitrageExecutor.V4Route(provider,manager,stable,1000000,hops,1e30,block.timestamp+60)){revert("unfunded profit passed");}
        catch(bytes memory reason){require(bytes4(reason)==ImmutableArbitrageExecutor.Unprofitable.selector,"failed before Aave profit check");}
        require(IMVToken(stable).balanceOf(address(e))==0,"Aave atomic rollback failed");
    }
}
