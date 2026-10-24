import { digest, uint } from '../liquidity/state.js';
import { ceilDiv } from '../liquidity/v2.js';
import { quoteAeroExactInput } from './math.js';
import { aeroSnapshotDigest, parseAeroRequest, type AeroAllocation, type AeroLender, type AeroRequest, type AeroResult, type AeroSelected } from './types.js';

export interface ScheduleResult {allocations: AeroAllocation[]; terminalReturn: string; costInBorrowAsset: string}
/** An explicit host may evaluate dynamic module dependencies in an ordered EVM.
 * exactCosts must be true only if every returned cost is exact for that schedule.
 */
export interface AeroSolverHost {evaluateSchedule?(request: AeroRequest,lender: AeroLender,amounts: ReadonlyArray<{branchId:string;amountIn:string}>): Promise<ScheduleResult>; exactCosts?: boolean; signal?: AbortSignal;
  /** verifyOnly hosts are not used during search; they re-quote the model's top-K (limits.quoteTopK, default 3). */
  verifyOnly?: boolean}
export function evaluateAeroSchedule(r:AeroRequest,amounts:ReadonlyArray<{branchId:string;amountIn:string}>):ScheduleResult {
  const pools=new Map(r.pools.map(p=>[p.poolId,structuredClone(p)]));
  const allocations:AeroAllocation[]=[];let terminal=0n;
  for(const entry of [...amounts].sort((a,b)=>a.branchId.localeCompare(b.branchId))) {
    if(uint(entry.amountIn)===0n)continue;
    const branch=r.branches.find(b=>b.branchId===entry.branchId);if(!branch)throw new Error('INVALID_INPUT');
    let amount=entry.amountIn;const legs=[];
    for(const leg of branch.legs) {
      const result=quoteAeroExactInput(pools.get(leg.poolId)!,leg,amount,r.limits.maxQuoteSteps);
      pools.set(leg.poolId,result.projectedState);legs.push(result.quote);amount=result.quote.amountOut;
    }
    terminal+=uint(amount);allocations.push({branchId:entry.branchId,amountIn:entry.amountIn,ratioBps:0,amountOut:amount,legs});
  }
  return {allocations,terminalReturn:terminal.toString(),costInBorrowAsset:r.cost.costInBorrowAsset};
}
export function allocationRatios(allocations:AeroAllocation[],principal:bigint):void {
  let assigned=0;const remainder=allocations.map(a=>{a.ratioBps=Number(uint(a.amountIn)*10000n/principal);assigned+=a.ratioBps;return {a,remainder:uint(a.amountIn)*10000n%principal};});
  remainder.sort((a,b)=>a.remainder===b.remainder?a.a.branchId.localeCompare(b.a.branchId):a.remainder>b.remainder?-1:1);
  for(let i=0;i<10000-assigned;i++)remainder[i].a.ratioBps++;
}
export function flashFee(l:AeroLender,amount:bigint):bigint {
  const n=amount*uint(l.feeNumerator),d=uint(l.feeDenominator);
  return l.feeRounding==='zero'?0n:l.feeRounding==='ceil'?ceilDiv(n,d):n/d;
}
function combinations(n:bigint,k:number,cap:bigint):bigint {
  let result=1n;for(let i=1;i<=k;i++){result=result*(n+BigInt(i))/BigInt(i);if(result>cap)return cap+1n;}return result;
}
function* vectors(total:bigint,count:number,prefix:bigint[]=[]):Generator<bigint[]> {
  if(count===1){yield [...prefix,total];return;}
  for(let n=0n;n<=total;n++)yield* vectors(total-n,count-1,[...prefix,n]);
}
const boundedCodes=new Set(['INVALID_INPUT','INCOMPLETE_TICK_COVERAGE','UNSUPPORTED_FEE_PROFILE','QUOTE_FAILED','COST_EVIDENCE_INVALID','INCOHERENT_SNAPSHOT','NO_FEASIBLE_DOMAIN','UNSUPPORTED_GENERATION','UNSUPPORTED_LENDER_CAPABILITY']);
export async function optimizeAeroSplit(input:unknown,host:AeroSolverHost={}):Promise<AeroResult> {
  let r:AeroRequest;
  try{r=parseAeroRequest(input);}catch(e){return {schemaVersion:'aero-split/1.0',status:'rejected',executable:false,reason:e instanceof Error&&boundedCodes.has(e.message)?e.message:'INVALID_INPUT',evaluations:0,budgetExhausted:false};}
  const branches=[...r.branches].sort((a,b)=>a.branchId.localeCompare(b.branchId)),lenders=[...r.lenders].sort((a,b)=>a.lenderId.localeCompare(b.lenderId));
  const quantum=uint(r.bounds.quantum),minimum=uint(r.bounds.minimum),maximum=uint(r.bounds.maximum),limit=r.limits.maxEvaluations;
  let evaluations=0,budgetExhausted=false,incompleteEvaluation=false,best:AeroSelected|undefined,lastReason='NO_PROFITABLE_PLAN';
  const top:AeroSelected[]=[],topK=r.limits.quoteTopK??3;
  const better=(a:AeroSelected,b:AeroSelected)=>{
    if(uint(a.netProfit)!==uint(b.netProfit))return uint(a.netProfit)>uint(b.netProfit);
    if(uint(a.principal)!==uint(b.principal))return uint(a.principal)<uint(b.principal);
    if(a.allocations.length!==b.allocations.length)return a.allocations.length<b.allocations.length;
    return a.lenderId!==b.lenderId?a.lenderId<b.lenderId:JSON.stringify(a.allocations.map(x=>[x.branchId,x.amountIn]))<JSON.stringify(b.allocations.map(x=>[x.branchId,x.amountIn]));
  };
  const evaluate=async(l:AeroLender,amounts:bigint[],complete:boolean):Promise<bigint|undefined>=>{
    host.signal?.throwIfAborted();
    if(evaluations>=limit){budgetExhausted=true;return;}
    evaluations++;const principal=amounts.reduce((a,b)=>a+b,0n);
    if(!principal||principal>uint(l.available))return;
    try {
      const selected=amounts.map((a,i)=>({branchId:branches[i].branchId,amountIn:a.toString()}));
      const schedule=host.evaluateSchedule&&!host.verifyOnly?await host.evaluateSchedule(r,l,selected):evaluateAeroSchedule(r,selected);
      host.signal?.throwIfAborted();
      const returned=uint(schedule.terminalReturn),cost=uint(schedule.costInBorrowAsset),fee=flashFee(l,principal),repayment=principal+fee;
      if(complete&&returned>=repayment+cost+uint(r.bounds.minNetProfit)) {
        if(schedule.allocations.reduce((a,b)=>a+uint(b.amountIn),0n)!==principal||schedule.allocations.reduce((a,b)=>a+uint(b.amountOut),0n)!==returned)throw new Error('INVALID_INPUT');
        allocationRatios(schedule.allocations,principal);
        const candidate:AeroSelected={schemaVersion:'aero-split/1.0',status:'selected',executable:false,requestDigest:digest(r),snapshotDigest:aeroSnapshotDigest(r),lenderId:l.lenderId,borrowAsset:r.borrowAsset,principal:principal.toString(),flashFee:fee.toString(),repayment:repayment.toString(),terminalReturn:returned.toString(),minProfit:(cost+uint(r.bounds.minNetProfit)).toString(),costInBorrowAsset:cost.toString(),netProfit:(returned-repayment-cost).toString(),allocations:schedule.allocations,optimality:'best-found',evaluations,budgetExhausted:false,admissionRequired:true};
        if(!best||better(candidate,best))best=candidate;
        if(host.verifyOnly){top.push(candidate);top.sort((x,y)=>better(x,y)?-1:better(y,x)?1:0);top.length=Math.min(top.length,topK);}
      }
      return returned;
    }catch(e){if(host.signal?.aborted)throw e;incompleteEvaluation=true;const code=e instanceof Error?e.message:'QUOTE_FAILED';lastReason=boundedCodes.has(code)?code:code.startsWith('CLMM_')?'INCOMPLETE_TICK_COVERAGE':'QUOTE_FAILED';return;}
  };
  // Golden-section search on principal, keeping the best plan's branch proportions (G8).
  // Profit of a fixed cycle set is unimodal in size for constant-product and CL legs.
  const refinePrincipal=async(seed:AeroSelected)=>{
    const l=lenders.find(x=>x.lenderId===seed.lenderId)!,cap=uint(l.available)<maximum?uint(l.available):maximum;
    const weights=branches.map(b=>uint(seed.allocations.find(a=>a.branchId===b.branchId)?.amountIn??'0')),total=weights.reduce((a,b)=>a+b,0n);
    const split=(p:bigint)=>{const v=weights.map(w=>w*p/total/quantum*quantum);const i=weights.indexOf(weights.reduce((a,b)=>b>a?b:a));v[i]+=p-v.reduce((a,b)=>a+b,0n);return v;};
    // Score = terminal return minus repayment; a failed quote scores below any feasible plan.
    const score=async(p:bigint)=>{const returned=await evaluate(l,split(p),true);return returned===undefined?-(1n<<256n):returned-p-flashFee(l,p);};
    let lo=minimum/quantum,hi=cap/quantum;
    while(hi-lo>2n&&!budgetExhausted){const m1=lo+(hi-lo)/3n,m2=hi-(hi-lo)/3n;const [s1,s2]=[await score(m1*quantum),await score(m2*quantum)];if(s1<s2)lo=m1;else hi=m2;}
    for(let q=lo;q<=hi&&!budgetExhausted;q++)await evaluate(l,split(q*quantum),true);
  };
  const verifyTop=async():Promise<AeroSelected|undefined>=>{
    let verified:AeroSelected|undefined;
    for(const c of top) {
      host.signal?.throwIfAborted();const l=lenders.find(x=>x.lenderId===c.lenderId)!;
      try {
        const s=await host.evaluateSchedule!(r,l,c.allocations.map(a=>({branchId:a.branchId,amountIn:a.amountIn})));
        const returned=uint(s.terminalReturn),cost=uint(s.costInBorrowAsset),repayment=uint(c.repayment);
        if(returned<repayment+cost+uint(r.bounds.minNetProfit))continue;
        allocationRatios(s.allocations,uint(c.principal));
        const v:AeroSelected={...c,terminalReturn:returned.toString(),netProfit:(returned-repayment-cost).toString(),allocations:s.allocations,quoteSource:'evm-quoter'};
        if(!verified||better(v,verified))verified=v;
      }catch(e){if(host.signal?.aborted)throw e;incompleteEvaluation=true;lastReason='QUOTE_FAILED';}
    }
    return verified;
  };
  // Count the entire feasible integer domain before selecting exhaustive mode.
  let domain=0n;const cap=BigInt(limit),sizes=(maximum-minimum)/quantum+1n;
  if(sizes<=cap)for(const l of lenders)for(let a=minimum;a<=maximum&&a<=uint(l.available);a+=quantum){domain+=combinations(a/quantum,branches.length-1,cap);if(domain>cap)break;}
  else domain=cap+1n;
  const exhaustive=domain>0n&&domain<=cap;
  if(exhaustive) {
    for(const l of lenders)for(let a=minimum;a<=maximum&&a<=uint(l.available);a+=quantum)for(const v of vectors(a/quantum,branches.length))await evaluate(l,v.map(n=>n*quantum),true);
  } else {
    const samples:bigint[]=[];for(let i=0;i<r.limits.borrowSamples;i++){const a=minimum+((maximum-minimum)/quantum*BigInt(i)/BigInt(r.limits.borrowSamples-1))*quantum;if(!samples.includes(a))samples.push(a);}
    for(const l of lenders)for(const a of samples)for(let i=0;i<branches.length&&!budgetExhausted;i++){const v=branches.map(()=>0n);v[i]=a;await evaluate(l,v,true);}
    const subsets=Array.from({length:(1<<branches.length)-1},(_,i)=>i+1).sort((a,b)=>a.toString(2).replaceAll('0','').length-b.toString(2).replaceAll('0','').length||a-b);
    for(const l of lenders)for(const a of samples)for(const subset of subsets) {
      if(budgetExhausted)break;
      if(a>uint(l.available))continue;
      const chunk=ceilDiv(a,BigInt(r.limits.allocationChunks)*quantum)*quantum,v=branches.map(()=>0n);let remaining=a;
      while(remaining&&!budgetExhausted){const addition=remaining<chunk?remaining:chunk;let winner=-1,score=-1n;
        for(let i=0;i<branches.length&&!budgetExhausted;i++)if(subset&(1<<i)){const next=[...v];next[i]+=addition;const q=await evaluate(l,next,addition===remaining);if(q!==undefined&&q>score){winner=i;score=q;}}
        if(winner<0)break;v[winner]+=addition;remaining-=addition;
      }
    }
  }
  if(best&&r.limits.refine&&!exhaustive)await refinePrincipal(best);
  if(best&&host.verifyOnly)best=await verifyTop();
  if(best){best.evaluations=evaluations;best.budgetExhausted=budgetExhausted;best.optimality=exhaustive&&host.exactCosts&&!budgetExhausted&&!incompleteEvaluation?'certified':'best-found';return best;}
  return {schemaVersion:'aero-split/1.0',status:'no-profitable-plan',executable:false,reason:budgetExhausted?'BUDGET_EXHAUSTED':lastReason,evaluations,budgetExhausted};
}
