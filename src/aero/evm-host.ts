import { BaseError, decodeErrorResult, decodeEventLog, encodeFunctionData, parseAbi, toFunctionSelector, toEventSelector, type Address, type Hex, type PublicClient } from 'viem';
import { digest, uint } from '../liquidity/state.js';
import { quoteAeroExactInput } from './math.js';
import { evaluateAeroSchedule, type AeroSolverHost } from './solver.js';
import { aeroRoute, encodeAeroCall, AERO_EXECUTOR_ABI, AERO_V2_EXECUTOR_ABI, type AeroArtifact } from './execution.js';
import type { AeroAllocation, AeroPool, ConcentratedState } from './types.js';

interface Frame {to?:string;input?:Hex;output?:Hex;error?:string;calls?:Frame[];logs?:Array<{address:Address;topics:[Hex,...Hex[]];data:Hex}>}
const clSwap=toFunctionSelector('swap(address,bool,int256,uint160,bytes)'),getSwapFee=toFunctionSelector('getSwapFee(address)');
const callbacks=[toFunctionSelector('onMorphoFlashLoan(uint256,bytes)'),toFunctionSelector('receiveFlashLoan(address[],uint256[],uint256[],bytes)')];
const swapAbi=parseAbi(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)']);
function flatten(frame:Frame):Frame[]{return [frame,...(frame.calls??[]).flatMap(flatten)];}
/** Read-only ordered EVM adapter. Call tracing is deliberately restricted to
 * explicitly selected localhost forks; it never signs, mines, or broadcasts.
 */
export function createAeroEvmHost(client:PublicClient,rpc:string,executor:Address,signal?:AbortSignal):AeroSolverHost {
  const endpoint=new URL(rpc);if(endpoint.protocol!=='http:'||!['localhost','127.0.0.1'].includes(endpoint.hostname))throw new Error('LOCAL_FORK_REQUIRED');
  return {signal,exactCosts:false,async evaluateSchedule(request,lender,amounts){
    signal?.throwIfAborted();
    if(await client.getChainId()!==8453||(await client.getBlock({blockNumber:uint(request.identity.blockNumber)})).hash!==request.identity.blockHash)throw new Error('STATE_CHANGED');
    // Hints construct initial V2 requested outputs only. Every dynamic quote,
    // actual amount, fee and state transition is then independently checked
    // against the trace; these hints cannot grant execution admission.
    const hint=structuredClone(request);for(const p of hint.pools)if('feeProfile'in p.state)p.state.feeProfile='fixed-proven';
    const reference=evaluateAeroSchedule(hint,amounts),route=aeroRoute(request,lender.lenderId,reference.allocations,1n);
    for(const b of route.branches)for(const l of b.legs)l.minAmountOut=1n;
    const data=encodeFunctionData({abi:AERO_EXECUTOR_ABI,functionName:'executeAeroSplitArbitrage',args:[route]});
    const call=client.request as unknown as (args:{method:string;params:unknown[]})=>Promise<Frame>;
    const frame=await call({method:'debug_traceCall',params:[{from:request.sender,to:executor,data},`0x${uint(request.identity.blockNumber).toString(16)}`,{tracer:'callTracer',tracerConfig:{withLog:true}}]});
    signal?.throwIfAborted();if(frame.error)throw new Error('QUOTE_FAILED_TRACE_REVERT');
    const callback=flatten(frame).find(f=>f.to?.toLowerCase()===executor.toLowerCase()&&callbacks.some(s=>f.input?.startsWith(s)));
    if(!callback?.logs)throw new Error('ORDERED_EVM_TRACE_REQUIRED');
    const events=callback.logs.filter(l=>l.address.toLowerCase()===executor.toLowerCase()).flatMap(l=>{try{const event=decodeEventLog({abi:AERO_EXECUTOR_ABI,...l});return event.eventName==='AeroLegExecuted'?[event.args]:[];}catch{return [];}});
    const swaps=(callback.calls??[]).filter(c=>c.input?.startsWith(clSwap));
    const pools=new Map(request.pools.map(p=>[p.poolId,structuredClone(p)])),allocations:AeroAllocation[]=[];
    let index=0,swapIndex=0,terminal=0n;
    for(const entry of [...amounts].sort((a,b)=>a.branchId.localeCompare(b.branchId))) {
      if(!uint(entry.amountIn))continue;
      const branch=request.branches.find(b=>b.branchId===entry.branchId)!;let amount=entry.amountIn;const legs=[];
      for(let j=0;j<branch.legs.length;j++) {
        const leg=branch.legs[j],pool=pools.get(leg.poolId)!;const event=events[index++];
        if(!event||event.branchIndex!==BigInt(allocations.length)||event.legIndex!==BigInt(j)||event.pool.toLowerCase()!==pool.address||event.amountIn!==uint(amount))throw new Error('QUOTE_FAILED_LEG_EVENT');
        const original=structuredClone(pool.state);let swapped:Frame|undefined;
        if(pool.state.protocol==='aero-slipstream'||pool.state.protocol==='uniswap-v3') {
          swapped=swaps[swapIndex++];if(!swapped||swapped.to?.toLowerCase()!==pool.address)throw new Error('QUOTE_FAILED_SWAP_FRAME');
          const cl=pool.state as ConcentratedState;
          if(cl.protocol==='aero-slipstream') {
            const fee=flatten(swapped).find(f=>f.to?.toLowerCase()===pool.factory&&f.input?.startsWith(getSwapFee));
            if(!fee?.output||fee.error)throw new Error('UNSUPPORTED_FEE_PROFILE');cl.feePips=Number(BigInt(fee.output));
          }
          cl.feeProfile='fixed-proven';
        }
        const projected=quoteAeroExactInput(pool,leg,amount,request.limits.maxQuoteSteps);
        // V2 requests a fixed encoded output; it can conservatively leave value
        // in the pool when a preceding dynamic quote improved the actual input.
        if(pool.state.protocol==='uniswap-v2'&&event.amountOut<=uint(projected.quote.amountOut)) {
          const s=projected.projectedState.state as Extract<AeroPool['state'],{protocol:'uniswap-v2'}>,difference=uint(projected.quote.amountOut)-event.amountOut;
          if(leg.tokenIn===pool.token0)s.reserve1=(uint(s.reserve1)+difference).toString();else s.reserve0=(uint(s.reserve0)+difference).toString();
          projected.quote.amountOut=event.amountOut.toString();projected.quote.minAmountOut=(event.amountOut*BigInt(leg.minOutBps)/10000n).toString();
        }else if(event.amountOut!==uint(projected.quote.amountOut))throw new Error('QUOTE_FAILED_OUTPUT');
        if(swapped) {
          const swap=flatten(swapped).flatMap(f=>f.logs??[]).find(l=>l.address.toLowerCase()===pool.address&&l.topics[0]===toEventSelector(swapAbi[0]));
          if(!swap)throw new Error('QUOTE_FAILED_SWAP_EVENT');
          const state=decodeEventLog({abi:swapAbi,...swap}).args,expected=projected.projectedState.state as ConcentratedState;
          if(state.sqrtPriceX96.toString()!==expected.sqrtPriceX96||state.liquidity.toString()!==expected.liquidity||state.tick!==expected.tick)throw new Error('QUOTE_FAILED_STATE');
          expected.feeProfile=(original as ConcentratedState).feeProfile;
        }
        projected.quote.stateBeforeDigest=digest(original);projected.quote.stateAfterDigest=digest(projected.projectedState.state);
        pools.set(pool.poolId,projected.projectedState);legs.push(projected.quote);amount=event.amountOut.toString();
      }
      terminal+=uint(amount);allocations.push({branchId:entry.branchId,amountIn:entry.amountIn,ratioBps:0,amountOut:amount,legs});
    }
    if(index!==events.length)throw new Error('QUOTE_FAILED');
    return {allocations,terminalReturn:terminal.toString(),costInBorrowAsset:request.cost.costInBorrowAsset};
  }};
}

/** Exact ordered quote on any RPC through AeroSplitFlashExecutorV2.quoteAeroSplit, which
 * borrows, runs every leg and always reverts AeroQuote. It is a verify-only host: the solver
 * searches with the static/snapshot model and re-quotes only its best candidates here.
 */
export function createAeroQuoterHost(client:PublicClient,artifact:AeroArtifact,signal?:AbortSignal):AeroSolverHost {
  if(artifact.version!==2)throw new Error('CAPABILITY_MISMATCH');
  return {signal,exactCosts:true,verifyOnly:true,async evaluateSchedule(request,lender,amounts){
    signal?.throwIfAborted();
    const reference=evaluateAeroSchedule(request,amounts),route=aeroRoute(request,lender.lenderId,reference.allocations,1n,2);
    for(const b of route.branches)for(const l of b.legs)l.minAmountOut=1n;
    const lagged=(request.bounds.maxBlockLag??0)>0;
    let revert:Hex|undefined;
    try{await client.call({to:artifact.address,data:encodeAeroCall(artifact,'quoteAeroSplit',route),account:request.sender,...(lagged?{}:{blockNumber:uint(request.identity.blockNumber)})});}
    catch(e){const raw=e instanceof BaseError?e.walk(x=>typeof (x as {data?:unknown}).data==='string'):undefined;revert=(raw as {data?:Hex}|undefined)?.data;}
    signal?.throwIfAborted();
    if(!revert)throw new Error('QUOTE_FAILED');
    let outputs:readonly bigint[];
    try{const decoded=decodeErrorResult({abi:AERO_V2_EXECUTOR_ABI,data:revert});if(decoded.errorName!=='AeroQuote')throw new Error('QUOTE_FAILED');outputs=decoded.args[0];}
    catch{throw new Error('QUOTE_FAILED');}
    return quotedSchedule(request,reference.allocations,outputs);
  }};
}
/** Replace model outputs with quoter outputs, re-chaining each leg's input from the prior output. */
export function quotedSchedule(request:Parameters<typeof evaluateAeroSchedule>[0],model:AeroAllocation[],outputs:readonly bigint[]) {
  if(outputs.length!==model.reduce((n,a)=>n+a.legs.length,0)||outputs.some(o=>o<=0n))throw new Error('QUOTE_FAILED');
  let index=0,terminal=0n;
  const allocations=[...model].sort((a,b)=>a.branchId.localeCompare(b.branchId)).map(a=>{
    const branch=request.branches.find(b=>b.branchId===a.branchId)!;let amount=uint(a.amountIn);
    const legs=a.legs.map((q,j)=>{const out=outputs[index++];const leg={...q,amountIn:amount.toString(),consumedInput:amount.toString(),amountOut:out.toString(),minAmountOut:(out*BigInt(branch.legs[j].minOutBps)/10000n).toString()};amount=out;return leg;});
    if(legs.some(l=>uint(l.minAmountOut)===0n))throw new Error('QUOTE_FAILED');
    terminal+=amount;return {...a,amountOut:amount.toString(),legs};
  });
  return {allocations,terminalReturn:terminal.toString(),costInBorrowAsset:request.cost.costInBorrowAsset};
}
