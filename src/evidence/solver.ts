import {serialCpmmCurve,stationaryInput,allocateCpmm,searchAllocation} from '../liquidity/price-gap.js';
import {digest,uint} from '../liquidity/state.js';
import {parsePoolState,projectPool,type PoolStateEnvelope,type ProjectionResult} from '../liquidity/projection.js';
import {verifyPlan} from './economics.js';
import {recordHash,sameAsset,validateRecord,type Asset,type Cost,type EvidenceRef,type Identity,type Plan,type Policy,type Ratio,type RunRequest,type Search} from './contracts.js';
export interface CapturedMarket {identity:Identity;pools:PoolStateEnvelope[];asset:Asset;lender:{capacityRaw:string;feeNumerator:string;feeDenominator:string;evidence:EvidenceRef};networkCost:Cost;valuation:{price:Ratio;ref:EvidenceRef};observedAtNs:string;quantumRaw:string;fundingOption?:import('./gap-runtime.js').FundingOption;openingBalances?:{operatorPrefundRaw:string;executorOpeningBalanceRaw:string;evidence:EvidenceRef}}
function routesFor(pools:PoolStateEnvelope[],borrow:string,hops:number,limit:number,deadline:number):{routes:Array<Array<{poolId:string;tokenIn:string}>>;complete:boolean}{
  const routes:Array<Array<{poolId:string;tokenIn:string}>>=[];let complete=true,expansions=0;
  const visit=(asset:string,path:Array<{poolId:string;tokenIn:string}>,visited:Set<string>)=>{
    if(routes.length>=limit||++expansions>limit*6||performance.now()>=deadline){complete=false;return;}
    if(path.length>=hops)return;
    for(const p of pools){if(path.some(l=>l.poolId===p.poolId)||![p.token0,p.token1].includes(asset))continue;
      const next=asset===p.token0?p.token1:p.token0,legs=[...path,{poolId:p.poolId,tokenIn:asset}];
      if(next===borrow&&legs.length>=2){if(routes.length>=limit){complete=false;return;}routes.push(legs);}
      else if(!visited.has(next))visit(next,legs,new Set([...visited,next]));
    }
  };visit(borrow,[],new Set([borrow]));return {routes,complete};
}
/** Per-route evaluation facts (v6 review D4). `evaluated` counts only schedules that passed dedupe and budget guards. */
export interface RouteStat {routeId:string;poolPath:string[];tokenIds:string[];evaluated:number;rejectedByCode:Record<string,number>}
export interface ExactPoolSolve {plan:Plan|null;search:Search;status:'CANDIDATE_FOUND'|'CERTIFIED_NO_OPPORTUNITY'|'INCONCLUSIVE';quotes:ProjectionResult[];routeStats:RouteStat[]}
/** Bounded closed-cycle and two-branch allocation search, with one ordered state for shared pools. */
export function solvePoolGraph(request:RunRequest,policy:Policy,market:CapturedMarket,stateDigest:string,domainRef:EvidenceRef,solveBudget?:number,solveDeadlineMs?:number):ExactPoolSolve {
  if(market.networkCost.amountRaw.value===null||market.networkCost.basis==='research-assumption'||market.networkCost.includedInSwapOutput||!sameAsset(market.networkCost.asset,policy.borrowAsset))throw new Error('MISSING_COST_EVIDENCE');
  if(policy.maxHopsPerBranch>6||policy.maxBranches>8)throw new Error('POLICY_UNSUPPORTED');
  if(solveBudget!==undefined&&(!Number.isSafeInteger(solveBudget)||solveBudget<1))throw new Error('INVALID_SOLVE_BUDGET');
  const maxAttempts=Math.min(policy.maxAttempts,solveBudget??policy.maxAttempts);
  if(solveDeadlineMs!==undefined&&(!Number.isFinite(solveDeadlineMs)||solveDeadlineMs<=0))throw new Error('SOLVE_DEADLINE');
  const start=performance.now(),deadline=start+Math.min(policy.deadlineMs,solveDeadlineMs??policy.deadlineMs);
  const pools=market.pools.map(parsePoolState),byId=new Map(pools.map(p=>[p.poolId,p])),borrow=policy.borrowAsset.assetId;
  const graph=routesFor(pools,borrow,policy.maxHopsPerBranch,maxAttempts,deadline);
  const quantum=uint(market.quantumRaw);if(!quantum)throw new Error('INVALID_QUANTUM');
  const minimum=((uint(policy.minimumPrincipalRaw)>0n?uint(policy.minimumPrincipalRaw):1n)+quantum-1n)/quantum*quantum;
  const maximum=(uint(policy.principalCapRaw)<uint(market.lender.capacityRaw)?uint(policy.principalCapRaw):uint(market.lender.capacityRaw))/quantum*quantum;
  if(maximum<minimum)throw new Error('NO_FEASIBLE_SIZING_DOMAIN');
  const count=(maximum-minimum)/quantum+1n,amountLimit=Math.min(maxAttempts,count>BigInt(maxAttempts)?maxAttempts:Number(count));
  const attempts:Array<{amount:string;routes:string[][];net:string|null}>=[],rejections:Record<string,number>={},unique=new Set<string>();
  let best:{amount:bigint;outputs:bigint;fee:bigint;net:bigint;allocations:Array<{route:typeof graph.routes[number];amount:bigint}>;quotes:ProjectionResult[]}|undefined;
  let attempted=0,accepted=0;const schedules=new Map<string,bigint|null>();
  const routeIndex=new Map(graph.routes.map((r,i)=>[r,i]));
  const routeStats:RouteStat[]=graph.routes.map(r=>({routeId:digest(r.map(l=>l.poolId)),poolPath:r.map(l=>l.poolId),tokenIds:[...r.map(l=>l.tokenIn),borrow],evaluated:0,rejectedByCode:{}}));
  /** Returns net (null on reject, budget or deadline); a repeated 5.2 schedule returns its cached net without counting. */
  const evaluate=(amount:bigint,allocations:Array<{route:typeof graph.routes[number];amount:bigint}>):bigint|null=>{
    if(attempted>=maxAttempts||performance.now()>=deadline)return null;
    let key:string|undefined;
    if(request.schemaVersion==='5.2'){key=digest({amount:amount.toString(),allocations:allocations.map(b=>({route:b.route,amount:b.amount.toString()}))});if(schedules.has(key))return schedules.get(key)!;schedules.set(key,null);}
    attempted++;unique.add(amount.toString());
    for(const b of allocations)routeStats[routeIndex.get(b.route)!].evaluated++;
    const mutated=new Map([...byId].map(([id,p])=>[id,structuredClone(p)]));let outputs=0n;const quotes:ProjectionResult[]=[];
    try{
      if(allocations.reduce((n,b)=>n+b.route.length,0)>policy.maxTotalSwaps||allocations.some(b=>b.amount<uint(policy.minimumBranchRaw)||b.amount*10000n<amount*BigInt(policy.minBranchWeightBps)))throw new Error('BRANCH_POLICY_REJECTED');
      for(const branch of allocations){let output=branch.amount;
        for(const leg of branch.route){if(performance.now()>=deadline)throw new Error('SOLVE_DEADLINE');const pool=mutated.get(leg.poolId)!;const q=projectPool(pool,{schemaVersion:'4.0',snapshotDigest:digest(pool),operationId:`solve:${attempted}:${quotes.length}`,operationClass:'hypothetical',tokenIn:leg.tokenIn,amountIn:output.toString()});if(uint(q.unspentInput))throw new Error('NON_BASE_ROUTE_REMAINDER');
          const before=q.priceBefore,after=q.priceAfter,n=BigInt(after.numerator)*BigInt(before.denominator)-BigInt(before.numerator)*BigInt(after.denominator),abs=n<0n?-n:n;
          if(abs*10000n>BigInt(policy.maxPriceImpactBps)*BigInt(before.numerator)*BigInt(after.denominator))throw new Error('PRICE_IMPACT_EXCEEDED');
          output=uint(q.amountOut);mutated.set(pool.poolId,q.projectedState);quotes.push(q);
        }outputs+=output;
      }
      const fee=(amount*uint(market.lender.feeNumerator)+uint(market.lender.feeDenominator)-1n)/uint(market.lender.feeDenominator),net=outputs-amount-fee-uint(market.networkCost.amountRaw.value!);
      accepted++;attempts.push({amount:amount.toString(),routes:allocations.map(b=>b.route.map(l=>l.poolId)),net:net.toString()});
      if(net>uint(policy.minProfitRaw)&&(!best||net>best.net||net===best.net&&amount<best.amount))best={amount,outputs,fee,net,allocations,quotes};
      if(key)schedules.set(key,net);return net;
    }catch(e){const code=e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'QUOTE_REJECTED';rejections[code]=(rejections[code]??0)+1;attempts.push({amount:amount.toString(),routes:allocations.map(b=>b.route.map(l=>l.poolId)),net:null});
      for(const b of allocations){const r=routeStats[routeIndex.get(b.route)!].rejectedByCode;r[code]=(r[code]??0)+1;}return null;}
  };
  if(request.schemaVersion==='5.2') {
    // Fair per-route seeding: marginal CPMM roots or quote-driven CLMM bracketing.
    const curves=graph.routes.map(route=>serialCpmmCurve(pools,route));
    const seedCache=new Map<string,string|null>();
    const single=(index:number,amount:bigint)=>{
      amount=amount/quantum*quantum;if(amount<minimum||amount>maximum)return null;
      const key=`${index}:${amount}`;if(seedCache.has(key))return seedCache.get(key)!;
      const before=attempts.length;evaluate(amount,[{route:graph.routes[index],amount}]);
      const result=attempts.length>before?attempts.at(-1)!.net:null;seedCache.set(key,result);return result;
    };
    const perRoute=Math.max(1,Math.floor(maxAttempts/Math.max(1,graph.routes.length)/2));
    for(let index=0;index<graph.routes.length&&attempted<maxAttempts;index++){
      const curve=curves[index],startAttempts=attempted;
      if(curve){const seed=stationaryInput(curve,uint(market.lender.feeNumerator),uint(market.lender.feeDenominator));
        const q=seed<minimum?minimum:seed>maximum?maximum:seed;for(const delta of [0n,-quantum,quantum])if(attempted-startAttempts<perRoute)single(index,q+delta);
      } else {
        // Binary-search the exponent first: depth may be many token-decimal orders below the cap.
        let lo=minimum/quantum,hi=maximum/quantum,feasible=lo;
        let lowerExponent=lo.toString(2).length-1,upperExponent=hi.toString(2).length-1;
        while(lowerExponent<=upperExponent&&attempted-startAttempts<Math.max(1,Math.floor(perRoute/2))&&performance.now()<deadline){
          const exponent=Math.floor((lowerExponent+upperExponent)/2),probe=1n<<BigInt(exponent);
          if(probe<lo){lowerExponent=exponent+1;continue;}
          const net=single(index,probe*quantum);
          if(net!==null){feasible=probe;lowerExponent=exponent+1;}else upperExponent=exponent-1;
        }
        hi=feasible*2n<hi?feasible*2n:hi;
        while(lo<hi&&attempted-startAttempts+2<=perRoute&&attempted+2<=maxAttempts&&performance.now()<deadline){
          const left=lo+(hi-lo)/3n,right=hi-(hi-lo)/3n;
          const a=single(index,left*quantum),b=single(index,right*quantum);
          if(a===null||b===null){hi=left>lo?left:lo;continue;}
          if(BigInt(a)<BigInt(b))lo=left+1n;else hi=right>lo?right-1n:lo;
        }
        if(attempted-startAttempts<perRoute)single(index,(lo+hi)/2n*quantum);
      }
      for(const q of [minimum,maximum])if(attempted-startAttempts<perRoute)single(index,q);
    }
    // Enumerate active subsets, including deeper lower-rate routes. Shared pools always replay in order.
    const subsets:number[][]=[];let expansions=0;
    const visit=(next:number,chosen:number[])=>{if(++expansions>maxAttempts*8||performance.now()>=deadline)return;
      if(chosen.length>=2)subsets.push([...chosen]);if(chosen.length>=policy.maxBranches)return;
      for(let i=next;i<graph.routes.length;i++)visit(i+1,[...chosen,i]);
    };visit(0,[]);
    const totals=new Set<bigint>([minimum,maximum,...(best?[best.amount]:[])]);
    for(const subset of subsets){if(performance.now()>=deadline)break;const selected=subset.map(i=>curves[i]);if(selected.every(c=>c!==null)){const sum=selected.reduce((q,c)=>q+stationaryInput(c!,uint(market.lender.feeNumerator),uint(market.lender.feeDenominator)),0n);totals.add((sum<minimum?minimum:sum>maximum?maximum:sum)/quantum*quantum);}}
    // v6 two-stage budget (review D5): when any subset needs refinement (shared pools or a non-CPMM leg),
    // the coarse equal-split pass may use at most 40% of the remaining budget; the rest refines the top 3.
    const disjointOf=(subset:number[])=>new Set(subset.flatMap(i=>graph.routes[i].map(l=>l.poolId))).size===subset.reduce((n,i)=>n+graph.routes[i].length,0);
    const refinable=subsets.filter(subset=>!(disjointOf(subset)&&subset.every(i=>curves[i]!==null)));
    const coarseLimit=refinable.length?attempted+Math.floor((maxAttempts-attempted)*2/5):maxAttempts;
    const incumbents:Array<{subset:number[];total:bigint;net:bigint}>=[];
    for(const total of totals)for(const subset of subsets){if(attempted>=coarseLimit||performance.now()>=deadline)break;
      if(total<quantum*BigInt(subset.length))continue;
      const cs=subset.map(i=>curves[i]);let allocation:bigint[];
      if(disjointOf(subset)&&cs.every(c=>c!==null))allocation=allocateCpmm(cs.map(c=>c!),total,quantum,deadline);
      else {allocation=subset.map(()=>total/BigInt(subset.length)/quantum*quantum);allocation[0]+=total-allocation.reduce((a,b)=>a+b,0n);}
      const net=evaluate(total,subset.map((i,j)=>({route:graph.routes[i],amount:allocation[j]})).filter(b=>b.amount>0n));
      if(net!==null&&refinable.includes(subset))incumbents.push({subset,total,net});
    }
    incumbents.sort((a,b)=>a.net===b.net?0:a.net>b.net?-1:1);
    for(const {subset,total} of incumbents.slice(0,3)){if(attempted>=maxAttempts||performance.now()>=deadline)break;
      searchAllocation({k:subset.length,total,quantum,overlap:!disjointOf(subset),deadline,remaining:()=>maxAttempts-attempted,
        evaluate:(order,amounts)=>evaluate(total,order.filter(j=>amounts[j]>0n).map(j=>({route:graph.routes[subset[j]],amount:amounts[j]})))});
    }
  }
  for(let i=0;i<amountLimit;i++){
    const amount=minimum+(count<=BigInt(amountLimit)?BigInt(i):BigInt(i)*(count-1n)/BigInt(Math.max(1,amountLimit-1)))*quantum;
    for(const route of graph.routes)evaluate(amount,[{route,amount}]);
    if(request.schemaVersion!=='5.2'&&policy.maxBranches>=2)for(let a=0;a<graph.routes.length;a++)for(let b=a+1;b<graph.routes.length;b++){
      // Allocation grid is in raw quanta. No prescribed weights are injected.
      for(let left=quantum;left<amount&&attempted<maxAttempts&&performance.now()<deadline;left+=quantum)evaluate(amount,[{route:graph.routes[a],amount:left},{route:graph.routes[b],amount:amount-left}]);
    }
    if(attempted>=maxAttempts||performance.now()>=deadline)break;
  }
  const rejected=attempted-accepted;
  const complete=graph.complete&&graph.routes.length>0&&policy.maxBranches===1&&count*BigInt(graph.routes.length)===BigInt(attempted)&&rejected===0;
  const domain:Search={attempted,accepted,rejected,uniqueAmounts:unique.size,retries:0,maxAttempts:maxAttempts,elapsedMs:Math.floor(performance.now()-start),deadlineMs:policy.deadlineMs,domainMinimumRaw:minimum.toString(),domainMaximumRaw:maximum.toString(),quantumRaw:quantum.toString(),evaluatedDomainHash:digest(attempts),coverageComplete:complete,termination:complete?'domain-certified':performance.now()>=deadline?'time-budget':'attempt-budget',optimality:complete?'domain-certified':'best-found',rejections:Object.entries(rejections).map(([code,count])=>({code,count})),inflight:0,domainEvidenceRef:domainRef,certificateRef:null,gridPointCount:null};
  validateRecord('Search',domain);
  if(!best)return {plan:null,search:domain,status:complete?'CERTIFIED_NO_OPPORTUNITY':'INCONCLUSIVE',quotes:[],routeStats};
  const asset=(id:string):Asset=>{const p=pools.find(p=>p.token0===id||p.token1===id)!;return {namespace:market.identity.namespace,networkId:market.identity.networkId,assetId:id,decimals:p.token0===id?p.decimals0:p.decimals1};};
  const plan:Plan={schemaVersion:request.schemaVersion,recordType:'route-plan',runId:request.runId,planHash:'0'.repeat(64),stateDigest,policyHash:policy.policyHash,borrowAsset:policy.borrowAsset,principalRaw:best.amount.toString(),unusedPrincipalRaw:'0',branches:best.allocations.map((b,index)=>({branchId:`branch-${index}`,allocatedRaw:b.amount.toString(),weightBps:Number(b.amount*10000n/best!.amount),tokenPath:[asset(b.route[0].tokenIn),...b.route.map(l=>{const p=byId.get(l.poolId)!;return asset(l.tokenIn===p.token0?p.token1:p.token0);})],poolPath:b.route.map(l=>l.poolId),hopCount:b.route.length,stateMutationOrder:b.route.map(l=>l.poolId)})),outputAfterEmbeddedFeesRaw:best.outputs.toString(),flashFeeRaw:best.fee.toString(),costs:[market.networkCost],netProfitRaw:{value:best.net.toString(),reason:null},search:domain,evidence:[domainRef,market.lender.evidence,...(request.fundingOptionRef?[request.fundingOptionRef]:[])],executionContextHash:digest({namespace:market.identity.namespace,network:market.identity.networkId,caller:request.caller,executor:request.executor,executorMode:request.executorMode,nativeValue:'0',...(request.schemaVersion==='5.2'&&request.fundingOptionRef?{fundingOptionHash:request.fundingOptionRef.contentHash}:{})}),unsignedPayloadRef:null};
  plan.planHash=recordHash(plan,'planHash');verifyPlan(plan,policy);return {plan,search:domain,status:'CANDIDATE_FOUND',quotes:best.quotes,routeStats};
}
