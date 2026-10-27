import {digest,uint} from '../liquidity/state.js';
import {parsePoolState,projectPool,type PoolStateEnvelope,type ProjectionResult} from '../liquidity/projection.js';
import {verifyPlan} from './economics.js';
import {recordHash,sameAsset,validateRecord,type Asset,type Cost,type EvidenceRef,type Identity,type Plan,type Policy,type Ratio,type RunRequest,type Search} from './contracts.js';
export interface CapturedMarket {identity:Identity;pools:PoolStateEnvelope[];asset:Asset;lender:{capacityRaw:string;feeNumerator:string;feeDenominator:string;evidence:EvidenceRef};networkCost:Cost;valuation:{price:Ratio;ref:EvidenceRef};observedAtNs:string;quantumRaw:string;openingBalances?:{operatorPrefundRaw:string;executorOpeningBalanceRaw:string;evidence:EvidenceRef}}
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
export interface ExactPoolSolve {plan:Plan|null;search:Search;status:'CANDIDATE_FOUND'|'CERTIFIED_NO_OPPORTUNITY'|'INCONCLUSIVE';quotes:ProjectionResult[]}
/** Bounded closed-cycle and two-branch allocation search, with one ordered state for shared pools. */
export function solvePoolGraph(request:RunRequest,policy:Policy,market:CapturedMarket,stateDigest:string,domainRef:EvidenceRef):ExactPoolSolve {
  if(market.networkCost.amountRaw.value===null||market.networkCost.basis==='research-assumption'||market.networkCost.includedInSwapOutput||!sameAsset(market.networkCost.asset,policy.borrowAsset))throw new Error('MISSING_COST_EVIDENCE');
  if(policy.maxHopsPerBranch>6)throw new Error('POLICY_UNSUPPORTED');
  const start=performance.now(),deadline=start+policy.deadlineMs;
  const pools=market.pools.map(parsePoolState),byId=new Map(pools.map(p=>[p.poolId,p])),borrow=policy.borrowAsset.assetId;
  const graph=routesFor(pools,borrow,policy.maxHopsPerBranch,policy.maxAttempts,deadline);
  const quantum=uint(market.quantumRaw);if(!quantum)throw new Error('INVALID_QUANTUM');
  const minimum=((uint(policy.minimumPrincipalRaw)>0n?uint(policy.minimumPrincipalRaw):1n)+quantum-1n)/quantum*quantum;
  const maximum=(uint(policy.principalCapRaw)<uint(market.lender.capacityRaw)?uint(policy.principalCapRaw):uint(market.lender.capacityRaw))/quantum*quantum;
  if(maximum<minimum)throw new Error('NO_FEASIBLE_SIZING_DOMAIN');
  const count=(maximum-minimum)/quantum+1n,amountLimit=Math.min(policy.maxAttempts,count>BigInt(policy.maxAttempts)?policy.maxAttempts:Number(count));
  const attempts:Array<{amount:string;routes:string[][];net:string|null}>=[],rejections:Record<string,number>={},unique=new Set<string>();
  let best:{amount:bigint;outputs:bigint;fee:bigint;net:bigint;allocations:Array<{route:typeof graph.routes[number];amount:bigint}>;quotes:ProjectionResult[]}|undefined;
  let attempted=0,accepted=0;
  const evaluate=(amount:bigint,allocations:Array<{route:typeof graph.routes[number];amount:bigint}>)=>{
    if(attempted>=policy.maxAttempts||performance.now()>=deadline)return;
    attempted++;unique.add(amount.toString());
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
    }catch(e){const code=e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'QUOTE_REJECTED';rejections[code]=(rejections[code]??0)+1;attempts.push({amount:amount.toString(),routes:allocations.map(b=>b.route.map(l=>l.poolId)),net:null});}
  };
  for(let i=0;i<amountLimit;i++){
    const amount=minimum+(count<=BigInt(amountLimit)?BigInt(i):BigInt(i)*(count-1n)/BigInt(Math.max(1,amountLimit-1)))*quantum;
    for(const route of graph.routes)evaluate(amount,[{route,amount}]);
    if(policy.maxBranches>=2)for(let a=0;a<graph.routes.length;a++)for(let b=a+1;b<graph.routes.length;b++){
      // Allocation grid is in raw quanta. No prescribed weights are injected.
      for(let left=quantum;left<amount&&attempted<policy.maxAttempts&&performance.now()<deadline;left+=quantum)evaluate(amount,[{route:graph.routes[a],amount:left},{route:graph.routes[b],amount:amount-left}]);
    }
    if(attempted>=policy.maxAttempts||performance.now()>=deadline)break;
  }
  const rejected=attempted-accepted;
  const complete=graph.complete&&graph.routes.length>0&&policy.maxBranches===1&&count*BigInt(graph.routes.length)===BigInt(attempted)&&rejected===0;
  const domain:Search={attempted,accepted,rejected,uniqueAmounts:unique.size,retries:0,maxAttempts:policy.maxAttempts,elapsedMs:Math.floor(performance.now()-start),deadlineMs:policy.deadlineMs,domainMinimumRaw:minimum.toString(),domainMaximumRaw:maximum.toString(),quantumRaw:quantum.toString(),evaluatedDomainHash:digest(attempts),coverageComplete:complete,termination:complete?'domain-certified':performance.now()>=deadline?'time-budget':'attempt-budget',optimality:complete?'domain-certified':'best-found',rejections:Object.entries(rejections).map(([code,count])=>({code,count})),inflight:0,domainEvidenceRef:domainRef,certificateRef:null,gridPointCount:null};
  validateRecord('Search',domain);
  if(!best)return {plan:null,search:domain,status:complete?'CERTIFIED_NO_OPPORTUNITY':'INCONCLUSIVE',quotes:[]};
  const asset=(id:string):Asset=>{const p=pools.find(p=>p.token0===id||p.token1===id)!;return {namespace:market.identity.namespace,networkId:market.identity.networkId,assetId:id,decimals:p.token0===id?p.decimals0:p.decimals1};};
  const plan:Plan={schemaVersion:request.schemaVersion,recordType:'route-plan',runId:request.runId,planHash:'0'.repeat(64),stateDigest,policyHash:policy.policyHash,borrowAsset:policy.borrowAsset,principalRaw:best.amount.toString(),unusedPrincipalRaw:'0',branches:best.allocations.map((b,index)=>({branchId:`branch-${index}`,allocatedRaw:b.amount.toString(),weightBps:Number(b.amount*10000n/best!.amount),tokenPath:[asset(b.route[0].tokenIn),...b.route.map(l=>{const p=byId.get(l.poolId)!;return asset(l.tokenIn===p.token0?p.token1:p.token0);})],poolPath:b.route.map(l=>l.poolId),hopCount:b.route.length,stateMutationOrder:b.route.map(l=>l.poolId)})),outputAfterEmbeddedFeesRaw:best.outputs.toString(),flashFeeRaw:best.fee.toString(),costs:[market.networkCost],netProfitRaw:{value:best.net.toString(),reason:null},search:domain,evidence:[domainRef,market.lender.evidence],executionContextHash:digest({namespace:market.identity.namespace,network:market.identity.networkId,caller:request.caller,executor:request.executor,executorMode:request.executorMode,nativeValue:'0'}),unsignedPayloadRef:null};
  plan.planHash=recordHash(plan,'planHash');verifyPlan(plan,policy);return {plan,search:domain,status:'CANDIDATE_FOUND',quotes:best.quotes};
}
