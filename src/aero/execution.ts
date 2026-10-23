import { encodeFunctionData, parseAbi, keccak256, toFunctionSelector, type Address, type Hex, type PublicClient } from 'viem';
import { digest, uint } from '../liquidity/state.js';
import { estimateEvmFees, priceUsdE8, type GasValuation } from '../evm-fees.js';
import { parseAeroRequest, aeroSnapshotDigest, type AeroRequest, type AeroSelected, type AeroAllocation } from './types.js';
import { evaluateAeroSchedule, flashFee } from './solver.js';

export const AERO_EXECUTOR_ABI=parseAbi([
  'function executeAeroSplitArbitrage((uint8 kind,address lender,address flashAsset,uint256 flashAmount,(uint256 amountIn,(uint8 venueVersion,address root,address pool,address tokenIn,address tokenOut,uint256 minAmountOut,uint256 quotedAmountOut,uint24 fee,uint160 sqrtPriceLimitX96,int24 tickSpacing,bool stable,uint8 generation)[] legs)[] branches,uint256 minProfit,uint256 deadline) route) returns(uint256 profit)',
  'function owner() view returns(address)',
  'function configureFactory(uint8,address,bytes32)',
  'function configurePool(address,bytes32,address,bytes32)',
  'function configureLender(uint8,address,bytes32,uint256)',
  'function trustedFactory(uint8,address) view returns(bytes32)',
  'function trustedPool(address) view returns(bytes32 runtimeHash,address implementation,bytes32 implementationHash)',
  'function trustedLender(uint8,address) view returns(bytes32)',
  'function maxLenderFee(address) view returns(uint256)',
  'event AeroArbitrageExecuted(bytes32 indexed routeHash,address indexed asset,uint256 principal,uint256 fee,uint256 profit,uint256 branches)',
  'event AeroLegExecuted(bytes32 indexed routeHash,uint256 indexed branchIndex,uint256 indexed legIndex,address pool,uint256 amountIn,uint256 amountOut)'
]);
export const AERO_SELECTOR=toFunctionSelector(AERO_EXECUTOR_ABI[0]);
export interface AeroArtifact {address:Address;runtimeCodeHash:Hex;artifactHash:string;selector:Hex;chainId:8453}
const generations={classic:1,'cl-initial':2,'cl-gauge-caps':3,'cl-gauges-v3':4,'external-v2':0,'external-v3':0};
export function buildAeroSplitCalldata(input:unknown,selected:AeroSelected,artifact:AeroArtifact) {
  const r=parseAeroRequest(input),lender=r.lenders.find(l=>l.lenderId===selected.lenderId);
  if(artifact.chainId!==8453||artifact.selector!==AERO_SELECTOR||!/^0x[0-9a-f]{64}$/.test(artifact.runtimeCodeHash)||!/^([a-f0-9]{64})$/.test(artifact.artifactHash)||selected.requestDigest!==digest(r)||selected.snapshotDigest!==aeroSnapshotDigest(r)||selected.borrowAsset!==r.borrowAsset||!lender)throw new Error('CAPABILITY_MISMATCH');
  const principal=uint(selected.principal),q=uint(r.bounds.quantum);
  if(principal<uint(r.bounds.minimum)||principal>uint(r.bounds.maximum)||principal%q||principal>uint(lender.available)||uint(selected.flashFee)!==flashFee(lender,principal)||uint(selected.repayment)!==principal+uint(selected.flashFee))throw new Error('INVALID_INPUT');
  if(new Set(selected.allocations.map(a=>a.branchId)).size!==selected.allocations.length||selected.allocations.reduce((s,a)=>s+uint(a.amountIn),0n)!==principal)throw new Error('INVALID_INPUT');
  // Reproduce every static projection before converting it to authorization-bearing
  // calldata. Unknown/dynamic profiles require the EVM host path below instead.
  const dynamic=selected.allocations.some(a=>a.legs.some(l=>{const s=r.pools.find(p=>p.poolId===l.poolId)?.state;return s&&'feeProfile'in s&&s.feeProfile!=='fixed-proven';}));
  if(!dynamic){const replay=evaluateAeroSchedule(r,selected.allocations);if(digest(replay.allocations.map(a=>({...a,ratioBps:0})))!==digest(selected.allocations.map(a=>({...a,ratioBps:0})))||replay.terminalReturn!==selected.terminalReturn)throw new Error('INVALID_INPUT');}
  if(uint(selected.minProfit)<uint(selected.costInBorrowAsset)+uint(r.bounds.minNetProfit)||uint(selected.terminalReturn)<uint(selected.repayment)+uint(selected.minProfit)||uint(selected.netProfit)!==uint(selected.terminalReturn)-uint(selected.repayment)-uint(selected.costInBorrowAsset))throw new Error('INVALID_INPUT');
  const route=aeroRoute(r,selected.lenderId,selected.allocations,uint(selected.minProfit));
  const data=encodeFunctionData({abi:AERO_EXECUTOR_ABI,functionName:'executeAeroSplitArbitrage',args:[route]});
  return {to:artifact.address,data,value:'0x0' as const,selector:AERO_SELECTOR,artifactHash:artifact.artifactHash,requestDigest:digest(r),snapshotDigest:aeroSnapshotDigest(r),route};
}
export function aeroRoute(r:AeroRequest,lenderId:string,allocations:AeroAllocation[],minProfit:bigint) {
  const lender=r.lenders.find(l=>l.lenderId===lenderId);if(!lender)throw new Error('UNSUPPORTED_LENDER_CAPABILITY');
  const branches=[...allocations].sort((a,b)=>a.branchId.localeCompare(b.branchId)).map(a=>{
    const branch=r.branches.find(b=>b.branchId===a.branchId);if(!branch||branch.legs.length!==a.legs.length)throw new Error('INVALID_INPUT');
    let amount=uint(a.amountIn);
    const legs=a.legs.map((quote,i)=>{
      const spec=branch.legs[i],pool=r.pools.find(p=>p.poolId===spec.poolId);if(!pool||quote.poolId!==spec.poolId||quote.tokenIn!==spec.tokenIn||uint(quote.amountIn)!==amount||quote.consumedInput!==quote.amountIn||quote.tokenOut!==(spec.tokenIn===pool.token0?pool.token1:pool.token0)||quote.sqrtPriceLimitX96!==spec.sqrtPriceLimitX96||uint(quote.minAmountOut)!==uint(quote.amountOut)*BigInt(spec.minOutBps)/10000n||!uint(quote.minAmountOut))throw new Error('INVALID_INPUT');
      amount=uint(quote.amountOut);const protocol=pool.state.protocol;
      return {venueVersion:protocol==='uniswap-v2'?2:protocol==='uniswap-v3'?3:protocol==='aero-slipstream'?7:6,root:pool.factory,pool:pool.address,tokenIn:quote.tokenIn,tokenOut:quote.tokenOut,minAmountOut:uint(quote.minAmountOut),quotedAmountOut:protocol==='uniswap-v2'?uint(quote.amountOut):0n,fee:protocol==='uniswap-v3'&&( 'feePips' in pool.state)?pool.state.feePips:0,sqrtPriceLimitX96:uint(quote.sqrtPriceLimitX96,160),tickSpacing:protocol==='aero-slipstream'&&'tickSpacing'in pool.state?pool.state.tickSpacing:0,stable:protocol==='aero-stable',generation:generations[pool.generation]};
    });
    if(amount!==uint(a.amountOut))throw new Error('INVALID_INPUT');
    return {amountIn:uint(a.amountIn),legs};
  });
  const route={kind:lender.kind==='morpho'?1:2,lender:lender.address,flashAsset:r.borrowAsset,flashAmount:allocations.reduce((s,a)=>s+uint(a.amountIn),0n),branches,minProfit:minProfit,deadline:uint(r.bounds.deadline)};
  return route;
}
export interface AeroSimulationOptions {signal?:AbortSignal;requireLatest?:boolean;valuation?:GasValuation;syntheticLocalRpc?:string}
/** Verify the conversion against the same pinned request and its age bound. */
export async function verifyAeroValuation(client:PublicClient,r:AeroRequest,options:AeroSimulationOptions={}) {
  const number=uint(r.identity.blockNumber,64);
  const wrappedNative='0x4200000000000000000000000000000000000006';
  let valuationSource='wrapped-native';
  if(r.cost.nativeAsset!==wrappedNative)throw new Error('COST_EVIDENCE_INVALID');
  if(options.syntheticLocalRpc) {
    const url=new URL(options.syntheticLocalRpc);
    if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||client.transport.url!==options.syntheticLocalRpc)throw new Error('LOCAL_FORK_REQUIRED');
    valuationSource='synthetic-local';
  } else if(r.borrowAsset===wrappedNative) {
    if(uint(r.cost.conversionNumerator)!==uint(r.cost.conversionDenominator))throw new Error('COST_EVIDENCE_INVALID');
  } else {
    const v=options.valuation;if(!v||v.asset.toLowerCase()!==r.borrowAsset||!Number.isInteger(v.decimals)||v.decimals<0||v.decimals>18)throw new Error('COST_EVIDENCE_INVALID');
    for(const address of[v.nativeUsdFeed,v.assetUsdFeed])if(!r.pins.some(p=>p.address===address.toLowerCase()&&p.role==='price-feed'))throw new Error('COST_EVIDENCE_INVALID');
    if(!Number.isSafeInteger(v.maxAgeSeconds)||v.maxAgeSeconds<1)throw new Error('COST_EVIDENCE_INVALID');
    const age=Math.min(v.maxAgeSeconds,r.cost.maxAgeSeconds);
    const [native,asset]=await Promise.all([priceUsdE8(client,v.nativeUsdFeed,number,age),priceUsdE8(client,v.assetUsdFeed,number,age)]);
    if(asset<99000000n||asset>101000000n||uint(r.cost.conversionNumerator)*10n**18n*asset!==uint(r.cost.conversionDenominator)*native*10n**BigInt(v.decimals))throw new Error('COST_EVIDENCE_INVALID');
    if(r.cost.valuationEvidenceDigest!==digest({identity:r.identity,nativeUsdFeed:v.nativeUsdFeed.toLowerCase(),assetUsdFeed:v.assetUsdFeed.toLowerCase(),nativePriceUsdE8:native.toString(),assetPriceUsdE8:asset.toString(),decimals:v.decimals}))throw new Error('COST_EVIDENCE_INVALID');
    valuationSource='pinned-price-feeds';
  }
  return valuationSource;
}
export async function simulateAeroExecution(client:PublicClient,r:AeroRequest,selected:AeroSelected,artifact:AeroArtifact,options:AeroSimulationOptions={}) {
  const payload=buildAeroSplitCalldata(r,selected,artifact),number=uint(r.identity.blockNumber,64);
  const check=async()=>{
    options.signal?.throwIfAborted();if(await client.getChainId()!==8453)throw new Error('INCOHERENT_SNAPSHOT');
    if((await client.getBlock({blockNumber:number})).hash!==r.identity.blockHash)throw new Error('STATE_CHANGED');
    if(options.requireLatest!==false&&(await client.getBlock()).hash!==r.identity.blockHash)throw new Error('STATE_CHANGED');
    const pins=[...r.pins,{address:artifact.address,codeHash:artifact.runtimeCodeHash}];
    for(const pin of pins){const code=await client.getCode({address:pin.address,blockNumber:number});if(!code||keccak256(code)!==pin.codeHash)throw new Error('UNTRUSTED_ROOT');}
    const owner=await client.readContract({address:artifact.address,abi:AERO_EXECUTOR_ABI,functionName:'owner',blockNumber:number});
    if(owner.toLowerCase()!==r.sender)throw new Error('CAPABILITY_MISMATCH');
    options.signal?.throwIfAborted();
  };
  await check();
  const valuationSource=await verifyAeroValuation(client,r,options);
  const call=await client.simulateContract({address:artifact.address,abi:AERO_EXECUTOR_ABI,functionName:'executeAeroSplitArbitrage',args:[payload.route],account:r.sender,blockNumber:number});
  if(call.result<uint(selected.minProfit))throw new Error('SIMULATION_FAILED');
  const fees=await estimateEvmFees(client,8453,r.sender,artifact.address,payload.data);
  const cost=(fees.nativeCost*uint(r.cost.conversionNumerator)+uint(r.cost.conversionDenominator)-1n)/uint(r.cost.conversionDenominator);
  if(cost>uint(selected.costInBorrowAsset)||call.result<cost+uint(r.bounds.minNetProfit))throw new Error('COST_EVIDENCE_INVALID');
  await check(); // Includes cancellation after the final awaited verification.
  return {schemaVersion:'aero-split/1.0',status:'simulated' as const,broadcast:false,valuationSource,chainId:8453,blockHash:r.identity.blockHash,blockNumber:r.identity.blockNumber,payloadDigest:keccak256(payload.data),requestDigest:payload.requestDigest,artifactHash:artifact.artifactHash,selector:AERO_SELECTOR,profitAfterDebt:call.result.toString(),costInBorrowAsset:cost.toString(),netProfit:(call.result-cost).toString(),gas:fees.gas.toString(),maxFeePerGas:fees.fees.maxFeePerGas.toString(),maxPriorityFeePerGas:fees.fees.maxPriorityFeePerGas.toString(),publicationFee:fees.publicationFee.toString()};
}
