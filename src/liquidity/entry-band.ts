import { executableDepth } from './l2-metrics.js';
import { digest, uint } from './state.js';
import { parsePoolState, poolPrice, projectPool, type PoolStateEnvelope } from './projection.js';
import { sizeConditionalCycle, type ConditionalSizingResult, type ConditionalVenue, type SizingRequest } from './sizing.js';
import { rational } from './v2.js';
import { validateRecord, type Asset, type EvidenceRef, type Identity, type Policy, type Ratio } from '../evidence/contracts.js';
export const DEPTH_BANDS = [10,25,50,100,200,500] as const;
export interface LiquidityPattern {
  schemaVersion:'5.1';recordType:'liquidity-pattern';runId:string;state:Identity;stateDigest:string;pairAssets:Asset[];
  pools:Array<{poolId:string;feePips:number;spotPrice:Ratio;activeLiquidityRaw:string;depth:Array<{bps:number;side:'bid'|'ask';inputRaw:string|null;reason:string|null}>;coverage:{lowerTick:number;upperTick:number;complete:boolean}}>;
  referenceBandBps:number;deepPoolId:string|null;thinPoolId:string|null;depthRatio:Ratio|null;
  pattern:'DEEP_LOW_FEE'|'DEEP_HIGH_FEE'|'BALANCED'|'UNRESOLVED';restingGap:{spotGapBps:Ratio;roundTripFeeBps:Ratio;netAtRestBps:Ratio};evidence:EvidenceRef[];
}
export function evidenceIdentity(pool:PoolStateEnvelope):Identity {const i=pool.identity;return {namespace:i.chain==='sui'?'sui':'eip155',networkId:i.network,height:i.height,stateHashOrDigest:i.chain==='sui'?i.checkpointDigest:i.blockHash,finality:i.chain==='sui'?'checkpoint-certified':'node-confirmed'};}
export function poolFeePips(pool:PoolStateEnvelope):number {
  const s=pool.state;if(s.protocol==='uniswap-v2'){const n=(uint(s.feeDenominator)-uint(s.feeNumerator))*1000000n,d=uint(s.feeDenominator);if(n%d)throw new Error('UNSUPPORTED_FEE_PRECISION');return Number(n/d);}
  if(s.protocol==='uniswap-v4'){if(s.key.fee&0x800000||!/^0x0{40}$/i.test(s.key.hooks))throw new Error('UNSUPPORTED_V4_PROJECTION');const protocol=Math.max(s.protocolFeePips&4095,s.protocolFeePips>>12);return protocol+s.lpFeePips-Math.floor(protocol*s.lpFeePips/1000000);}
  return s.feePips;
}
export function classifyLiquidityPattern(raw:PoolStateEnvelope[],referenceBandBps:number,runId:string,evidence:EvidenceRef[]):LiquidityPattern {
  if(!DEPTH_BANDS.includes(referenceBandBps as typeof DEPTH_BANDS[number])||raw.length<2||raw.length>16||new Set(raw.map(p=>p.poolId)).size!==raw.length)throw new Error('INVALID_PATTERN_INPUT');
  const pools=raw.map(parsePoolState),first=pools[0],identity=digest(first.identity);
  const base=first.token0,quote=first.token1,forward=(p:PoolStateEnvelope)=>p.token0===base;
  if(pools.some(p=>p.stateClass!=='canonical'||digest(p.identity)!==identity||!((p.token0===base&&p.token1===quote&&p.decimals0===first.decimals0&&p.decimals1===first.decimals1)||(p.token1===base&&p.token0===quote&&p.decimals1===first.decimals0&&p.decimals0===first.decimals1))))throw new Error('INCOHERENT_PATTERN_STATE');
  const rows=pools.map(p=>{const s=p.state,normal=forward(p),price=poolPrice(p);return {poolId:p.poolId,feePips:poolFeePips(p),spotPrice:normal?price:{numerator:price.denominator,denominator:price.numerator},activeLiquidityRaw:s.protocol==='uniswap-v2'?'0':s.liquidity,depth:DEPTH_BANDS.flatMap(bps=>(['bid','ask'] as const).map(side=>{const point=executableDepth(p,bps,normal?side:side==='bid'?'ask':'bid');return {bps,side,inputRaw:point.inputAtoms.value,reason:point.inputAtoms.reason};})),coverage:{lowerTick:s.protocol==='uniswap-v2'?0:s.lowerTick,upperTick:s.protocol==='uniswap-v2'?0:s.upperTick,complete:s.protocol==='uniswap-v2'}};});
  const comparable=rows.map(p=>({p,depth:p.depth.find(d=>d.bps===referenceBandBps&&d.side==='ask')!.inputRaw}));
  const resolved=comparable.every(p=>p.depth!==null&&BigInt(p.depth)>0n);
  const ordered=[...comparable].sort((a,b)=>a.depth!==null&&b.depth!==null?(BigInt(a.depth)<BigInt(b.depth)?-1:BigInt(a.depth)>BigInt(b.depth)?1:a.p.poolId.localeCompare(b.p.poolId)):a.p.poolId.localeCompare(b.p.poolId));
  const deep=resolved?ordered.at(-1)!:null,thin=resolved?ordered[0]:null;
  const ratio=deep&&thin?rational(BigInt(deep.depth!),BigInt(thin.depth!)):null;
  const prices=[...rows].sort((a,b)=>BigInt(a.spotPrice.numerator)*BigInt(b.spotPrice.denominator)<BigInt(b.spotPrice.numerator)*BigInt(a.spotPrice.denominator)?-1:1);
  const lo=prices[0].spotPrice,hi=prices.at(-1)!.spotPrice,gap=rational((BigInt(hi.numerator)*BigInt(lo.denominator)-BigInt(lo.numerator)*BigInt(hi.denominator))*10000n,BigInt(hi.denominator)*BigInt(lo.numerator));
  const fee=rational(BigInt(prices[0].feePips+prices.at(-1)!.feePips),100n);
  const net=rational(BigInt(gap.numerator)*BigInt(fee.denominator)-BigInt(fee.numerator)*BigInt(gap.denominator),BigInt(gap.denominator)*BigInt(fee.denominator));
  const state=evidenceIdentity(first),pairAssets=[{namespace:state.namespace,networkId:state.networkId,assetId:base,decimals:first.decimals0},{namespace:state.namespace,networkId:state.networkId,assetId:quote,decimals:first.decimals1}];
  return validateRecord<LiquidityPattern>('LiquidityPattern',{schemaVersion:'5.1',recordType:'liquidity-pattern',runId,state,stateDigest:digest(pools),pairAssets,pools:rows,referenceBandBps,deepPoolId:deep?.p.poolId??null,thinPoolId:thin?.p.poolId??null,depthRatio:ratio,pattern:!ratio?'UNRESOLVED':BigInt(ratio.numerator)<2n*BigInt(ratio.denominator)?'BALANCED':deep!.p.feePips<=thin!.p.feePips?'DEEP_LOW_FEE':'DEEP_HIGH_FEE',restingGap:{spotGapBps:gap,roundTripFeeBps:fee,netAtRestBps:net},evidence});
}
export interface BandSolve {status:'selected'|'no-profitable-size'|'incomplete-evidence';optimality:'best-found'|'grid-complete'|'certified';sizeRaw:string|null;grossRaw:string|null;lenderFeeRaw:string|null;networkCostRaw:string|null;netRaw:string|null;evaluations:number;reason:string|null}
export interface BandRow {triggerPoolId:string;exitPoolId:string;triggerDirection:'sell-base'|'buy-base';triggerAsset:Asset;triggerRaw:string;projectedStateDigest:string|null;gapAfterBps:Ratio|null;solve:BandSolve}
export interface SMin {triggerPoolId:string;triggerDirection:BandRow['triggerDirection'];minimumTriggerRaw:string|null;bracketLowRaw:string|null;bracketHighRaw:string|null;method:'bisection'|'grid-first-positive'|'none-positive-in-grid'|'incomplete-evidence';evaluations:number;reason:string|null}
export interface EntryBand {schemaVersion:'5.1';recordType:'entry-band';runId:string;counterfactual:true;stateDigest:string;policyHash:string;patternRef:string;lender:{provider:string;feePips:number;capacityRaw:string;callbackAdmitted:boolean};costEvidenceRef:string|null;rows:BandRow[];sMin:SMin[];validThroughHeight:string;incompleteRows:number}
export interface BandInputs {pools:PoolStateEnvelope[];pattern:LiquidityPattern;policy:Policy;lender:EntryBand['lender'];networkCostRaw:string|null;minimumRaw:string;quantumRaw:string;triggerGridRaw?:string[]}
function solveBandRow(input:BandInputs,victim:PoolStateEnvelope,exit:PoolStateEnvelope,direction:BandRow['triggerDirection'],amount:bigint,remaining:number):BandRow {
  const asset=input.pattern.pairAssets[direction==='sell-base'?0:1],policy=input.policy;
  const row:BandRow={triggerPoolId:victim.poolId,exitPoolId:exit.poolId,triggerDirection:direction,triggerAsset:asset,triggerRaw:amount.toString(),projectedStateDigest:null,gapAfterBps:null,solve:{status:'incomplete-evidence',optimality:'best-found',sizeRaw:null,grossRaw:null,lenderFeeRaw:null,networkCostRaw:input.networkCostRaw,netRaw:null,evaluations:0,reason:'BAND_BUDGET_EXHAUSTED'}};
  if(remaining<2)return row;
  try{
    const projection=projectPool(victim,{schemaVersion:'4.0',snapshotDigest:digest(victim),operationId:`band:${direction}:${amount}`,operationClass:'hypothetical',tokenIn:asset.assetId,amountIn:amount.toString()});
    row.projectedStateDigest=projection.projectedStateDigest;
    const base=input.pattern.pairAssets[0].assetId;
    const normalized=(p:PoolStateEnvelope)=>{const price=poolPrice(p);return p.token0===base?price:{numerator:price.denominator,denominator:price.numerator};};
    const a=normalized(projection.projectedState),b=normalized(exit);
    row.gapAfterBps=rational((BigInt(b.numerator)*BigInt(a.denominator)-BigInt(a.numerator)*BigInt(b.denominator))*10000n,BigInt(b.denominator)*BigInt(a.numerator));
    if(input.networkCostRaw===null){row.solve.reason='MISSING_COST_EVIDENCE';return row;}
    const pair:ConditionalVenue[]=[projection.projectedState,exit].map(state=>({kind:'pool',poolId:state.poolId,identity:state.identity,token0:state.token0,token1:state.token1,state,feeResolutions:[]}));
    const borrow=policy.borrowAsset.assetId,other=borrow===victim.token0?victim.token1:victim.token0;
    if(![victim.token0,victim.token1].includes(borrow))throw new Error('BORROW_ASSET_MISMATCH');
    const request:SizingRequest={schemaVersion:'4.0',snapshotDigest:digest(pair),borrowAsset:borrow,route:[{poolId:victim.poolId,tokenIn:borrow},{poolId:exit.poolId,tokenIn:other}],minimum:input.minimumRaw,maximum:policy.principalCapRaw,quantum:input.quantumRaw,lenderAvailable:input.lender.capacityRaw,flashFeeNumerator:String(input.lender.feePips),flashFeeDenominator:'1000000',costInBorrowAsset:input.networkCostRaw,costEvidenceDigest:policy.networkCostEvidenceRef.contentHash,minProfit:(uint(policy.minProfitRaw)+1n).toString(),maxEvaluations:Math.min(512,Math.floor(Math.min(policy.bandMaxEvaluationsPerRow!,remaining)/2))};
    const solve=sizeConditionalCycle(pair,request);
    row.solve={status:solve.status,optimality:solve.optimality,sizeRaw:solve.status==='selected'?solve.amountIn:null,grossRaw:solve.status==='selected'?(uint(solve.amountOut)-uint(solve.amountIn)).toString():null,lenderFeeRaw:solve.status==='selected'?(uint(solve.repayment)-uint(solve.amountIn)).toString():null,networkCostRaw:input.networkCostRaw,netRaw:solve.status==='selected'?solve.netProfit:null,evaluations:solve.evaluations,reason:solve.status==='selected'?null:solve.optimality==='best-found'?'INCOMPLETE_SEARCH':'NO_POSITIVE_SIZE_IN_DOMAIN'};
  }catch(e){row.solve.reason=e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'PROJECTION_UNAVAILABLE';}
  return row;
}
export function buildEntryBand(input:BandInputs):EntryBand {
  const {pattern,policy}=input,pools=input.pools.map(parsePoolState),total=policy.bandMaxEvaluationsTotal;
  if(policy.watchMode!=='band'||policy.bandMaxEvaluationsPerRow===undefined||total===undefined||policy.bandTtlBlocks===undefined)throw new Error('INPUT_BLOCKED');
  validateRecord<Policy>('Policy',policy,policy.schemaVersion);
  if(pattern.stateDigest!==digest(pools)||pattern.runId!==policy.runId||pattern.pattern==='UNRESOLVED')throw new Error('PATTERN_UNRESOLVED');
  if(input.networkCostRaw!==null)uint(input.networkCostRaw);
  const rows:BandRow[]=[],sMin:SMin[]=[];let used=0,incompleteRows=0;
  const thin=pattern.pools.find(p=>p.poolId===pattern.thinPoolId)!;
  for(const victim of pools)for(const direction of ['sell-base','buy-base'] as const){
    const grid=input.triggerGridRaw?.length?input.triggerGridRaw:thin.depth.filter(d=>[25,50,100,200].includes(d.bps)&&d.side===(direction==='sell-base'?'bid':'ask')&&d.inputRaw!==null).map(d=>d.inputRaw!);
    if(grid.length>256)throw new Error('BAND_GRID_TOO_LARGE');
    const amounts=[...new Set(grid)].map(v=>uint(v)).filter(v=>v>0n).sort((a,b)=>a<b?-1:a>b?1:0);
    let low:string|null=null,firstPositive:string|null=null,complete=true,laterNegative=false;
    const evaluate=(amount:bigint):boolean|null=>{
      let positive=false,allComplete=true;
      for(const exit of pools.filter(p=>p.poolId!==victim.poolId)){
        if(rows.length>=256){incompleteRows++;allComplete=false;continue;}
        const row=solveBandRow(input,victim,exit,direction,amount,total-used);rows.push(row);used+=row.solve.evaluations;
        if(row.solve.status==='selected')positive=true;
        else if(row.solve.status==='incomplete-evidence'||row.solve.optimality!=='certified')allComplete=false;
      }
      return positive?true:allComplete?false:null;
    };
    for(const amount of amounts){const positive=evaluate(amount);
      if(positive===true){if(firstPositive===null)firstPositive=amount.toString();}
      else if(positive===false){if(firstPositive!==null)laterNegative=true;else low=amount.toString();}
      else complete=false;
    }
    const beforeProbe=used;
    let bracket:{low:string;high:string;method:'bisection'|'grid-first-positive';evaluations:number}|undefined;
    if(low!==null&&firstPositive!==null&&!laterNegative&&complete&&total-used>=2)bracket=bracketSMin(BigInt(low),BigInt(firstPositive),Math.floor((total-used)/2),evaluate);
    const high=bracket?.high??firstPositive;
    sMin.push({triggerPoolId:victim.poolId,triggerDirection:direction,minimumTriggerRaw:high,bracketLowRaw:bracket?.low??low,bracketHighRaw:high,method:laterNegative?'grid-first-positive':bracket?.method??(firstPositive!==null?'grid-first-positive':complete&&amounts.length?'none-positive-in-grid':'incomplete-evidence'),evaluations:used-beforeProbe,reason:laterNegative?'NON_MONOTONE_GRID':!complete?'INCOMPLETE_SEARCH':!amounts.length?'EMPTY_TRIGGER_GRID':bracket?.method==='bisection'?'LOCAL_BRACKET_ONLY':null});
  }
  return validateRecord<EntryBand>('EntryBand',{schemaVersion:'5.1',recordType:'entry-band',runId:policy.runId,counterfactual:true,stateDigest:pattern.stateDigest,policyHash:policy.policyHash,patternRef:digest(pattern),lender:input.lender,costEvidenceRef:input.networkCostRaw===null?null:policy.networkCostEvidenceRef.contentHash,rows,sMin,validThroughHeight:(BigInt(pattern.state.height)+BigInt(policy.bandTtlBlocks)).toString(),incompleteRows});
}
export class EntryBandCache {
  private cached:{input:BandInputs;band:EntryBand;fingerprint:string}|undefined;
  private builds=0;private readonly processedEvents=new Set<string>();
  get rebuildCount(){return this.builds;}
  clear(){this.cached=undefined;this.processedEvents.clear();}
  get(input:BandInputs,liquidityEvents:readonly string[]=[]):EntryBand {
    const fingerprint=digest({triggerGridRaw:input.triggerGridRaw??null,minimumRaw:input.minimumRaw,quantumRaw:input.quantumRaw,networkCostRaw:input.networkCostRaw,pattern:{pairAssets:input.pattern.pairAssets,referenceBandBps:input.pattern.referenceBandBps},pools:input.pools.map(p=>({poolId:p.poolId,revision:p.adapterRevision,code:p.revisionHash,state:p.state.protocol==='uniswap-v2'?p.state:{...p.state,...(p.state.protocol==='cetus'?{sqrtPriceX64:null}:{sqrtPriceX96:null}),tick:null}})),lender:input.lender,cost:input.policy.networkCostEvidenceRef,valuation:input.policy.valuationEvidenceRef,policyHash:input.policy.policyHash});
    const newEvents=liquidityEvents.filter(id=>!this.processedEvents.has(id));for(const id of newEvents)this.processedEvents.add(id);while(this.processedEvents.size>10000)this.processedEvents.delete(this.processedEvents.values().next().value!);
    const old=this.cached,threshold=input.policy.bandRebuildTicks;if(threshold===undefined)throw new Error('INPUT_BLOCKED');
    const moved=old&&input.pools.some(p=>{const before=old.input.pools.find(b=>b.poolId===p.poolId);return !before||p.state.protocol!=='uniswap-v2'&&before.state.protocol!=='uniswap-v2'&&Math.abs(p.state.tick-before.state.tick)>=threshold;});
    if(old&&!newEvents.length&&!moved&&old.fingerprint===fingerprint&&BigInt(input.pattern.state.height)<=BigInt(old.band.validThroughHeight))return structuredClone(old.band);
    const band=buildEntryBand(input);this.builds++;this.cached={input:structuredClone(input),band,fingerprint};return structuredClone(band);
  }
}
/** Bisection reports a bracket only. Finite probes never establish global monotonicity. */
export function bracketSMin(low:bigint,high:bigint,maxEvaluations:number,probe:(amount:bigint)=>boolean|null):{low:string;high:string;method:'bisection'|'grid-first-positive';evaluations:number}{
  if(low<0n||high<=low||!Number.isSafeInteger(maxEvaluations)||maxEvaluations<0)throw new Error('INVALID_TRIGGER_BRACKET');
  let evaluations=0,complete=true;while(high-low>1n&&evaluations<maxEvaluations){const mid=(low+high)/2n,value=probe(mid);evaluations++;if(value===null){complete=false;break;}if(value)high=mid;else low=mid;}
  return {low:low.toString(),high:high.toString(),method:complete&&high-low===1n?'bisection':'grid-first-positive',evaluations};
}
