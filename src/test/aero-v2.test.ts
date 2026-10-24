import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, keccak256, encodeAbiParameters, encodeEventTopics, zeroAddress, type Address, type Hex } from 'viem';
import { optimizeAeroSplit, evaluateAeroSchedule, type AeroSolverHost } from '../aero/solver.js';
import { quotedSchedule } from '../aero/evm-host.js';
import { aeroPriorityFee, aeroRoute, buildAeroSplitCalldata, encodeAeroCall, AERO_V2_EXECUTOR_ABI, AERO_V2_SELECTOR } from '../aero/execution.js';
import { aeroCycles, aeroRouteCodec, aeroSubmissionUrl, parseAeroLiveConfig } from '../aero/live.js';
import { quoteAeroExactInput } from '../aero/math.js';
import { sqrtRatioAtTick } from '../liquidity/clmm.js';
import { MULTI_VENUE_ROUTE_CODEC } from '../liquidity/arbitrum-execution.js';
import { MULTI_LENDER_ROUTE_ABI } from '../liquidity/arbitrum.js';
import { parseAeroRequest, type AeroPool } from '../aero/types.js';
import { aeroFixture } from './aero-fixture.js';

const artifact={address:'0x0000000000000000000000000000000000000099' as const,runtimeCodeHash:`0x${'1'.repeat(64)}` as Hex,artifactHash:'1'.repeat(64),selector:AERO_V2_SELECTOR,chainId:8453 as const,version:2 as const};
const v4Pool=(r=aeroFixture()):AeroPool=>{
  const back=r.pools.find(p=>p.poolId==='back')!;
  return {poolId:'v4',address:'0x00000000000000000000000000000000000000b4',factory:'0x00000000000000000000000000000000000000b4',generation:'external-v4',token0:back.token0,token1:back.token1,decimals0:18,decimals1:18,
    implementation:'0x00000000000000000000000000000000000000b4',implementationCodeHash:`0x${'1'.repeat(64)}`,
    state:{protocol:'uniswap-v4',sqrtPriceX96:'79228162514264337593543950336',tick:0,liquidity:'1000000',tickSpacing:60,feePips:3000,unlocked:true,lowerTick:-15360,upperTick:15359,
      bitmapWords:[{wordPosition:-1,bitmap:'0'},{wordPosition:0,bitmap:'0'}],initializedTicks:[],feeProfile:'fixed-proven',feeEvidenceDigest:'2'.repeat(64),hooks:zeroAddress,poolKeyId:`0x${'3'.repeat(64)}`}};
};

test('AERO_V2_EDGE_01 schema 1.1 admits hookless static V4 pools and 1.0 requests still parse',()=>{
  const r=aeroFixture();assert.equal(r.schemaVersion,'aero-split/1.0');
  const next=structuredClone(r) as unknown as Record<string,unknown>&typeof r;next.schemaVersion='aero-split/1.1';next.bounds.maxBlockLag=2;next.limits.quoteTopK=2;next.limits.refine=true;
  next.pools.push(v4Pool(r));assert.equal(parseAeroRequest(next).pools.length,3);
  const hooked=structuredClone(next);(hooked.pools[2].state as {hooks:Address}).hooks='0x00000000000000000000000000000000000000ff';assert.throws(()=>parseAeroRequest(hooked),/UNSUPPORTED_GENERATION/);
  const keyless=structuredClone(next);delete (keyless.pools[2].state as {poolKeyId?:Hex}).poolKeyId;assert.throws(()=>parseAeroRequest(keyless),/UNSUPPORTED_GENERATION/);
  const lag=structuredClone(next);lag.bounds.maxBlockLag=6;assert.throws(()=>parseAeroRequest(lag),/INVALID_INPUT/);
  const v4Lender=structuredClone(next);v4Lender.lenders[0]={...v4Lender.lenders[0],kind:'uniswap-v4',feeRounding:'ceil',feeNumerator:'1'};assert.throws(()=>parseAeroRequest(v4Lender),/UNSUPPORTED_LENDER_CAPABILITY/);
  console.log('AERO_V2_EDGE_01');
});
test('AERO_V2_EDGE_02 V4 legs quote through the shared CLMM traversal and need the V2 artifact',()=>{
  const r=aeroFixture(),pool=v4Pool(r),s=pool.state as {lowerTick:number};
  const leg={poolId:'v4',tokenIn:pool.token0,minOutBps:9900,sqrtPriceLimitX96:'0'};
  assert.throws(()=>quoteAeroExactInput(pool,leg,'100'),/INVALID_INPUT/,'limit must be the captured horizon');
  const horizon={...leg,sqrtPriceLimitX96:sqrtRatioAtTick(s.lowerTick).toString()};
  const v4=quoteAeroExactInput(pool,horizon,'100').quote;
  const v3=quoteAeroExactInput({...pool,generation:'external-v3',state:{...pool.state,protocol:'uniswap-v3'}} as AeroPool,horizon,'100').quote;
  assert.equal(v4.amountOut,v3.amountOut,'V4 static-fee quote equals the V3 traversal');assert.ok(BigInt(v4.amountOut)>0n);
  // Identical pools cannot form a profitable cycle once fees are paid twice.
  assert.deepEqual(aeroCycles([pool,{...pool,poolId:'v4b',state:{...pool.state,poolKeyId:`0x${'4'.repeat(64)}`}} as AeroPool],pool.token0,10n,9900),[]);
  console.log('AERO_V2_EDGE_02');
});
test('AERO_V2_EDGE_03 golden-section refinement never does worse than sampled search and stays deterministic',async()=>{
  // 100 sizes > 40 evaluations forces sampled (non-exhaustive) search; samples 1,25,50,75,100 miss the optimum.
  const grid=aeroFixture();grid.bounds.maximum='100';grid.limits.maxEvaluations=40;grid.limits.borrowSamples=5;
  const refined=structuredClone(grid);refined.limits.refine=true;refined.limits.maxEvaluations=120;
  const a=await optimizeAeroSplit(grid),b=await optimizeAeroSplit(refined),c=await optimizeAeroSplit(structuredClone(refined));
  assert.equal(a.status,'selected');assert.equal(b.status,'selected');
  if(a.status==='selected'&&b.status==='selected'&&c.status==='selected'){assert.ok(BigInt(b.netProfit)>BigInt(a.netProfit),'refinement finds the unsampled optimum');assert.equal(b.netProfit,c.netProfit);assert.equal(b.principal,c.principal);}
  console.log('AERO_V2_EDGE_03');
});
test('quoter top-K re-quotes model candidates; only verified plans are selected',async()=>{
  const r=aeroFixture();r.limits.quoteTopK=2;
  let calls=0;
  const lower:AeroSolverHost={verifyOnly:true,exactCosts:true,async evaluateSchedule(req,_l,amounts){calls++;const m=evaluateAeroSchedule(req,amounts);return quotedSchedule(req,m.allocations,m.allocations.flatMap(a=>a.legs.map(q=>BigInt(q.amountOut)-1n)));}};
  const model=await optimizeAeroSplit(aeroFixture()),verified=await optimizeAeroSplit(r,lower);
  assert.ok(calls>=1&&calls<=2,'only top-K are re-quoted');
  assert.equal(verified.status,'selected');if(verified.status==='selected'&&model.status==='selected'){assert.equal(verified.quoteSource,'evm-quoter');assert.ok(BigInt(verified.netProfit)<=BigInt(model.netProfit));}
  const failing:AeroSolverHost={verifyOnly:true,async evaluateSchedule(){throw new Error('QUOTE_FAILED');}};
  const none=await optimizeAeroSplit(aeroFixture(),failing);assert.notEqual(none.status,'selected');
  assert.throws(()=>quotedSchedule(r,evaluateAeroSchedule(r,[{branchId:'cycle-a',amountIn:'10'}]).allocations,[1n]),/QUOTE_FAILED/);
});
test('V2 calldata encodes on-chain V2 output, zero hooks, and the codec proves the exact route event',async()=>{
  const r=aeroFixture();const result=await optimizeAeroSplit(r);assert.equal(result.status,'selected');if(result.status!=='selected')return;
  const payload=buildAeroSplitCalldata(r,result,artifact);assert.equal(payload.data.slice(0,10),AERO_V2_SELECTOR);
  const legs=payload.route.branches[0].legs as Array<{hooks:Address;quotedAmountOut?:bigint}>;assert.ok(legs.every(l=>l.hooks===zeroAddress&&l.quotedAmountOut===undefined));
  const codec=aeroRouteCodec(2),view=codec.decode(payload.data);
  assert.equal(view.flashAmount,BigInt(result.principal));assert.equal(view.kind,1);assert.ok(view.supportedKind&&!view.unsupportedLeg);
  const routeHash=keccak256(encodeAbiParameters(AERO_V2_EXECUTOR_ABI[0].inputs,[payload.route as never]));
  const event=AERO_V2_EXECUTOR_ABI.find(i=>i.type==='event'&&i.name==='AeroArbitrageExecuted')!;
  const log=(profit:bigint,hash:Hex)=>({address:artifact.address,topics:encodeEventTopics({abi:[event],eventName:'AeroArbitrageExecuted',args:{routeHash:hash,asset:r.borrowAsset}}) as Hex[],data:encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[view.flashAmount,0n,profit,1n])});
  assert.equal(codec.prove([log(view.minProfit,routeHash)],artifact.address,payload.data,view).proven,true);
  assert.equal(codec.prove([log(view.minProfit-1n,routeHash)],artifact.address,payload.data,view).proven,false);
  assert.equal(codec.prove([log(view.minProfit,`0x${'9'.repeat(64)}`)],artifact.address,payload.data,view).proven,false);
  assert.throws(()=>encodeAeroCall({},'quoteAeroSplit',aeroRoute(r,result.lenderId,result.allocations,1n)),/CAPABILITY_MISMATCH/);
});
test('CRITICAL regression: multi-venue codec decodes exactly the guards the adapter enforced before the refactor',()=>{
  const route={kind:1,lender:'0x0000000000000000000000000000000000000004' as Address,flashAsset:'0x0000000000000000000000000000000000000002' as Address,flashAmount:100n,
    legs:[{venueVersion:4,root:'0x0000000000000000000000000000000000000044' as Address,pool:'0x0000000000000000000000000000000000000045' as Address,tokenIn:'0x0000000000000000000000000000000000000002' as Address,tokenOut:'0x0000000000000000000000000000000000000003' as Address,amountIn:100n,minAmountOut:1n,fee:3000,tickSpacing:60,sqrtPriceLimitX96:0n,hooks:zeroAddress,hookData:'0x' as Hex}],minProfit:5n,deadline:10n};
  const data=encodeFunctionData({abi:MULTI_LENDER_ROUTE_ABI,functionName:MULTI_LENDER_ROUTE_ABI[0].name,args:[route as never]});
  const view=MULTI_VENUE_ROUTE_CODEC.decode(data);
  assert.deepEqual(view.pinned,[route.lender,route.legs[0].root]);
  assert.equal(view.supportedKind,true);assert.equal(view.unsupportedLeg,false);assert.equal(view.size,1);
  const hooked=encodeFunctionData({abi:MULTI_LENDER_ROUTE_ABI,functionName:MULTI_LENDER_ROUTE_ABI[0].name,args:[{...route,legs:[{...route.legs[0],hookData:'0x01'}]} as never]});
  assert.equal(MULTI_VENUE_ROUTE_CODEC.decode(hooked).unsupportedLeg,true);
});
test('AERO_V2_EDGE_07 live policy: explicit submission URL, clamped bids, validated config',()=>{
  assert.throws(()=>aeroSubmissionUrl({}),/SUBMISSION_URL_REQUIRED/);
  assert.equal(aeroSubmissionUrl({BASE_SUBMISSION_URL:'https://mainnet.base.org'}),'https://mainnet.base.org');
  assert.throws(()=>aeroSubmissionUrl({BASE_SUBMISSION_URL:'http://relay.example'}),/INSECURE_EVM_ENDPOINT/);
  const policy={bidShareBps:2000,maxPriorityFeePerGas:1000n};
  assert.equal(aeroPriorityFee(policy,10n**15n,1n,1n,500000n),1000n,'clamped to cap');
  assert.equal(aeroPriorityFee(policy,10n**8n,1n,1n,500000n),40n);
  assert.equal(aeroPriorityFee(policy,0n,1n,1n,500000n),0n);
  assert.throws(()=>aeroPriorityFee({...policy,bidShareBps:9000},1n,1n,1n,1n),/INVALID_INPUT/);
  const config={schemaVersion:'aero-live-config/1.0',registryPath:'r',artifactPath:'a',manifestPath:'m',lenders:[{kind:'morpho',address:'0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'}],
    bounds:{minimum:'1',maximum:'2',quantum:'1',minNetProfit:'1',deadlineSeconds:12,maxBlockLag:2},limits:{maxEvaluations:10,borrowSamples:2,allocationChunks:1,maxQuoteSteps:10},bid:{bidShareBps:1000,maxPriorityFeePerGas:'1'},minOutBps:9900,maxRounds:1,pollIntervalMs:0};
  assert.equal(parseAeroLiveConfig(config).bounds.maxBlockLag,2);
  assert.throws(()=>parseAeroLiveConfig({...config,bounds:{...config.bounds,maxBlockLag:9}}),/INVALID_LIVE_CONFIG/);
  console.log('AERO_V2_EDGE_07');
});
