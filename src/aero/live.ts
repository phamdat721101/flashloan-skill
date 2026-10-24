import { readFile } from 'node:fs/promises';
import { createPublicClient, decodeFunctionData, encodeAbiParameters, http, keccak256, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { digest, SnapshotStore, uint } from '../liquidity/state.js';
import { AttemptJournal } from '../liquidity/journal.js';
import { LiquidityRuntime, type Admission, type RouteCandidate } from '../liquidity/runtime.js';
import { decodeExecutorEvents, EvmLiquidityExecutionAdapter, type ExecutionRoute, type RouteCodec } from '../liquidity/arbitrum-execution.js';
import { ExecutionLock } from '../execution-lock.js';
import { EvmBudget, TRADE_SUBMISSION_CAP } from '../evm/budget.js';
import { loadSigner, parseManifest, secureEndpoint } from '../evm/deployment.js';
import { atomicJson } from '../evm/storage.js';
import { estimateEvmFees } from '../evm-fees.js';
import { aeroPublicClient, captureAeroLender, captureAeroSnapshot, type CapturePool } from './capture.js';
import { optimizeAeroSplit } from './solver.js';
import { quoteAeroExactInput } from './math.js';
import { sqrtRatioAtTick as sqrtAt } from '../liquidity/clmm.js';
import { createAeroQuoterHost } from './evm-host.js';
import { aeroPriorityFee, AERO_V2_EXECUTOR_ABI, buildAeroSplitCalldata, simulateAeroExecution, type AeroArtifact, type AeroBidPolicy } from './execution.js';
import { parseAeroRequest, type AeroBranch, type AeroLender, type AeroPool, type AeroRequest } from './types.js';

const WETH='0x4200000000000000000000000000000000000006' as const;
const LANE='base:8453',PROFIT_ASSET=`${LANE}:${WETH}`;
// Conservative pre-calldata bounds used only to price the plan; simulation re-checks the real fee.
const PLAN_GAS=900000n,PLAN_CALLDATA=`0x${'11'.repeat(3072)}` as Hex;

type V2Route={kind:number;lender:Address;flashAsset:Address;flashAmount:bigint;minProfit:bigint;deadline:bigint;branches:ReadonlyArray<{amountIn:bigint;legs:ReadonlyArray<{venueVersion:number;root:Address;pool:Address;hooks:Address}>}>};
/** Calldata/event codec for AeroSplitFlashExecutorV2 on the shared EVM execution adapter. */
export function aeroRouteCodec(maxBlockLag:number):RouteCodec {
  const decode=(calldata:Hex)=>{const call=decodeFunctionData({abi:AERO_V2_EXECUTOR_ABI,data:calldata});if(call.functionName!=='executeAeroSplitArbitrage')throw new Error('EXECUTOR_PROFIT_GUARD_MISMATCH');return call.args[0] as V2Route;};
  return {maxBlockLag,
    decode(calldata):ExecutionRoute {
      const route=decode(calldata),legs=route.branches.flatMap(b=>b.legs);
      return {kind:route.kind,supportedKind:[1,2,3].includes(route.kind)&&route.branches.length>0,unsupportedLeg:legs.some(l=>![2,3,6,7,8].includes(l.venueVersion)||l.hooks!==zeroAddress),
        lender:route.lender,flashAsset:route.flashAsset,flashAmount:route.flashAmount,minProfit:route.minProfit,deadline:route.deadline,
        pinned:[route.lender,...legs.flatMap(l=>[l.root,...(l.venueVersion===8?[]:[l.pool])])],size:route.branches.length};
    },
    prove(logs,executor,calldata,view) {
      const routeHash=keccak256(encodeAbiParameters(AERO_V2_EXECUTOR_ABI[0].inputs,[decode(calldata) as never]));
      const events=decodeExecutorEvents(logs,executor,AERO_V2_EXECUTOR_ABI,'AeroArbitrageExecuted');
      if(events.length!==1)return {proven:false,profit:0n};
      const e=events[0] as {routeHash:Hex;asset:Address;principal:bigint;profit:bigint;branches:bigint};
      return {proven:e.routeHash===routeHash&&e.asset.toLowerCase()===view.flashAsset.toLowerCase()&&e.principal===view.flashAmount&&e.branches===BigInt(view.size)&&e.profit>=view.minProfit,profit:e.profit};
    }};
}

/** Deterministic id within the schema's 128-char bound (joined V4 pool ids exceed it). */
export const aeroBranchId=(first:string,second:string)=>`cycle-${digest([first,second]).slice(0,24)}`;
/** The price limit the quote math requires for a leg: the captured bitmap window edge (0 for reserves pools). */
export function aeroLegLimit(p:AeroPool,tokenIn:Address):string {
  if(!('lowerTick'in p.state))return '0';
  const zero=tokenIn===p.token0,s=p.state;
  return (zero?sqrtAt(s.lowerTick)+(s.lowerTick===-887272?1n:0n):sqrtAt(s.upperTick)-(s.upperTick===887272?1n:0n)).toString();
}
/** Two-leg cycles borrow→X→borrow across distinct pools of one pair, kept only when the
 * model returns more than `probe` at that size; best `limit` by edge (executor max 8). */
export function aeroCycles(pools:readonly AeroPool[],borrowAsset:Address,probe:bigint,minOutBps:number,limit=8):AeroBranch[] {
  const edges:Array<{branch:AeroBranch;out:bigint}>=[],limitFor=aeroLegLimit;
  for(const a of pools)for(const b of pools) {
    if(a.poolId===b.poolId||a.token0!==b.token0||a.token1!==b.token1||![a.token0,a.token1].includes(borrowAsset))continue;
    const other=a.token0===borrowAsset?a.token1:a.token0;
    const branch:AeroBranch={branchId:aeroBranchId(a.poolId,b.poolId),legs:[{poolId:a.poolId,tokenIn:borrowAsset,minOutBps,sqrtPriceLimitX96:limitFor(a,borrowAsset)},{poolId:b.poolId,tokenIn:other,minOutBps,sqrtPriceLimitX96:limitFor(b,other)}]};
    try {
      const mid=quoteAeroExactInput(a,branch.legs[0],probe.toString()).quote.amountOut,out=uint(quoteAeroExactInput(b,branch.legs[1],mid).quote.amountOut);
      if(out>probe)edges.push({branch,out});
    } catch { /* unquotable at probe size: not a candidate */ }
  }
  return edges.sort((x,y)=>x.out===y.out?x.branch.branchId.localeCompare(y.branch.branchId):x.out>y.out?-1:1).slice(0,limit).map(e=>e.branch);
}

export interface AeroLiveConfig {
  schemaVersion:'aero-live-config/1.0'; registryPath:string; artifactPath:string; manifestPath:string;
  lenders:Array<{kind:AeroLender['kind'];address:Address}>;
  bounds:{minimum:string;maximum:string;quantum:string;minNetProfit:string;deadlineSeconds:number;maxBlockLag:number};
  limits:AeroRequest['limits']; bid:{bidShareBps:number;maxPriorityFeePerGas:string}; minOutBps:number; maxRounds:number; pollIntervalMs:number;
}
export interface AeroLiveResult {
  schemaVersion:'aero-live/1.0'; status:'submitted'|'reconciled'|'halted'|'skipped'|'no-opportunity'; reason?:string; chainId:8453; blockNumber:string;
  payloadDigest?:string; requestDigest?:string; txHash?:Hex; priorityFeePerGas?:string; profitAfterDebt?:string; gasCostInProfitAsset?:string;
  budget:{remainingWei:string;tradeCount:number};
}
interface LiveState {schemaVersion:'1.0';owner:Address;status:'scanning'|'halted'|'pending';reason?:string;pending?:{hash:Hex;candidate:RouteCandidate;calldata:Hex;submissionStarted:boolean};results:AeroLiveResult[]}

export function parseAeroLiveConfig(value:unknown):AeroLiveConfig {
  const c=value as AeroLiveConfig;
  if(c?.schemaVersion!=='aero-live-config/1.0'||!c.lenders?.length||c.lenders.some(l=>!['morpho','balancer-v2','uniswap-v4'].includes(l.kind)||!/^0x[0-9a-fA-F]{40}$/.test(l.address)))throw new Error('INVALID_LIVE_CONFIG');
  for(const k of ['minimum','maximum','quantum','minNetProfit'] as const)uint(c.bounds?.[k]);
  if(!Number.isInteger(c.bounds.maxBlockLag)||c.bounds.maxBlockLag<0||c.bounds.maxBlockLag>5||!Number.isInteger(c.bounds.deadlineSeconds)||c.bounds.deadlineSeconds<4||c.bounds.deadlineSeconds>60)throw new Error('INVALID_LIVE_CONFIG');
  if(!Number.isInteger(c.maxRounds)||c.maxRounds<1||c.maxRounds>100000||!Number.isInteger(c.pollIntervalMs)||c.pollIntervalMs<0||!Number.isInteger(c.minOutBps)||c.minOutBps<1||c.minOutBps>10000)throw new Error('INVALID_LIVE_CONFIG');
  uint(c.bid?.maxPriorityFeePerGas);return structuredClone(c);
}
/** Explicit transport policy (review decision 1A): no silent fallback to the read RPC. */
export function aeroSubmissionUrl(env:NodeJS.ProcessEnv=process.env):string {
  const url=env.BASE_SUBMISSION_URL;if(!url)throw new Error('SUBMISSION_URL_REQUIRED');return secureEndpoint(url);
}

/** Capture → plan (model search, quoter top-K) → final simulation → shared runtime send.
 * The first reverted receipt halts the lane (review decision 3A) until `resume`. */
export async function runAeroLive(configPath:string,envFile:string|undefined,options:{resume?:boolean;signal?:AbortSignal}={}):Promise<LiveState> {
  const config=parseAeroLiveConfig(JSON.parse(await readFile(configPath,'utf8')));
  if(!envFile)throw new Error('EXPLICIT_SIGNER_ENV_FILE_REQUIRED');
  const submissionUrl=aeroSubmissionUrl(),rpc=process.env.BASE_RPC_URL??'https://mainnet.base.org';
  const account=await loadSigner(envFile);
  const artifact:AeroArtifact=JSON.parse(await readFile(config.artifactPath,'utf8'));
  if(artifact.version!==2||artifact.chainId!==8453)throw new Error('CAPABILITY_MISMATCH');
  const manifest=parseManifest(JSON.parse(await readFile(config.manifestPath,'utf8')));
  const registry:CapturePool[]=JSON.parse(await readFile(config.registryPath,'utf8'));
  const client=aeroPublicClient(rpc),plain=createPublicClient({chain:base,transport:http(secureEndpoint(rpc),{timeout:15000,retryCount:0})}) as PublicClient;
  const codePins:Record<string,Hex>={};for(const root of manifest.roots)codePins[root.address.toLowerCase()]=root.codeHash;
  const signer=account.address.toLowerCase();
  return new ExecutionLock(`.nim/signing/8453-${signer}.lock`).runExclusive(async()=>{
    const statePath=`.nim/aero-live/8453-${signer}.json`,journal=new AttemptJournal(`${statePath}.attempts.jsonl`);
    const budget=new EvmBudget(8453,account.address);await budget.load();
    let state:LiveState;
    try{state=JSON.parse(await readFile(statePath,'utf8'));}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={schemaVersion:'1.0',owner:account.address,status:'scanning',results:[]};}
    if(state.owner.toLowerCase()!==signer)throw new Error('LIVE_STATE_BINDING_MISMATCH');
    const save=()=>atomicJson(statePath,state);
    const record=async(result:Omit<AeroLiveResult,'schemaVersion'|'chainId'|'budget'>)=>{state.results.push({schemaVersion:'aero-live/1.0',chainId:8453,...result,budget:{remainingWei:budget.remaining('trade').toString(),tradeCount:budget.tradeCount()}});await save();};
    const halt=async(reason:string,blockNumber:string)=>{state.status='halted';state.reason=reason;await record({status:'halted',reason,blockNumber});};
    // A crash after submissionStarted is reconciled from the chain, never re-sent.
    if(state.pending){
      const pending=state.pending;
      if(!pending.submissionStarted){if(budget.has(pending.hash))await budget.cancelUnsent(pending.hash);delete state.pending;state.status='scanning';await save();}
      else {
        const receipt=await plain.getTransactionReceipt({hash:pending.hash}).catch(()=>undefined);
        if(!receipt){await halt('PENDING_RECEIPT_UNKNOWN',pending.candidate.identity.height);return state;}
        await budget.settle(pending.hash,receipt.gasUsed*receipt.effectiveGasPrice);delete state.pending;
        if(receipt.status!=='success'){await halt('LIVE_REVERT',receipt.blockNumber.toString());return state;}
        state.status='scanning';await record({status:'reconciled',blockNumber:receipt.blockNumber.toString(),txHash:pending.hash});
      }
    }
    if(state.status==='halted'){if(!options.resume)throw new Error('LIVE_HALTED');state.status='scanning';delete state.reason;await save();}
    if(budget.unresolved().length)throw new Error('UNRESOLVED_BUDGET_RESERVATION');
    for(let round=0;round<config.maxRounds&&budget.tradeCount()<TRADE_SUBMISSION_CAP&&budget.remaining('trade')>0n;round++){
      options.signal?.throwIfAborted();
      if(round>0&&config.pollIntervalMs)await new Promise(r=>setTimeout(r,config.pollIntervalMs));
      let radius=1,request:AeroRequest|undefined,result;
      // Auto tick coverage (G10): one recapture at double radius when the window was too narrow.
      for(let attempt=0;attempt<2;attempt++){
        const capture=await captureAeroSnapshot(client,registry.map(p=>({...p,bitmapRadius:Math.max(p.bitmapRadius??1,radius)})));
        const block=BigInt(capture.identity.blockNumber);
        const lenders=await Promise.all(config.lenders.map(l=>captureAeroLender(client,l.kind,l.address.toLowerCase() as Address,WETH,block)));
        const {nativeCost}=await estimateEvmFees(client,8453,account.address,account.address,PLAN_CALLDATA).then(f=>({nativeCost:PLAN_GAS*f.fees.maxFeePerGas+f.publicationFee}));
        const branches=aeroCycles(capture.pools,WETH,uint(config.bounds.minimum),config.minOutBps);
        if(!branches.length){result=undefined;request=undefined;break;}
        request=parseAeroRequest({schemaVersion:'aero-split/1.1',identity:capture.identity,sender:signer,borrowAsset:WETH,pools:capture.pools,
          pins:[...capture.pins,{address:artifact.address.toLowerCase(),codeHash:artifact.runtimeCodeHash,role:'executor',sourceRevision:artifact.artifactHash.slice(0,40)}],
          branches,lenders,bounds:{minimum:config.bounds.minimum,maximum:config.bounds.maximum,quantum:config.bounds.quantum,minNetProfit:config.bounds.minNetProfit,deadline:(BigInt(capture.identity.timestamp)+BigInt(config.bounds.deadlineSeconds)).toString(),maxBlockLag:config.bounds.maxBlockLag},
          cost:{evidenceDigest:digest({block:capture.identity,nativeCost:nativeCost.toString()}),nativeAsset:WETH,borrowAsset:WETH,nativeCostWei:nativeCost.toString(),costInBorrowAsset:nativeCost.toString(),conversionNumerator:'1',conversionDenominator:'1',valuationEvidenceDigest:digest({wrappedNative:WETH}),maxAgeSeconds:60},
          limits:config.limits});
        result=await optimizeAeroSplit(request,createAeroQuoterHost(client,artifact,options.signal));
        if(result.status==='selected'||result.reason!=='INCOMPLETE_TICK_COVERAGE'||radius>=8)break;
        radius=Math.min(8,radius*2);
      }
      if(!request||!result||result.status!=='selected'){await record({status:'no-opportunity',reason:result&&result.status!=='selected'?result.reason:'NO_CANDIDATE_CYCLE',blockNumber:request?.identity.blockNumber??'0'});continue;}
      const payload=buildAeroSplitCalldata(request,result,artifact);
      const gasEstimate=(await estimateEvmFees(client,8453,account.address,artifact.address,payload.data)).gas;
      const bid:AeroBidPolicy={bidShareBps:config.bid.bidShareBps,maxPriorityFeePerGas:uint(config.bid.maxPriorityFeePerGas)};
      const priorityFeePerGas=aeroPriorityFee(bid,uint(result.netProfit),1n,1n,gasEstimate);
      let proof;
      try{proof=await simulateAeroExecution(client,request,result,artifact,{requireLatest:true,priorityFeePerGas,signal:options.signal});}
      catch(e){await record({status:'skipped',reason:e instanceof Error?e.message:'SIMULATION_FAILED',blockNumber:request.identity.blockNumber,requestDigest:payload.requestDigest});continue;}
      const expiresAtMs=Number(request.bounds.deadline)*1000;
      const candidate:RouteCandidate={identity:{chain:'base',network:'8453',height:request.identity.blockNumber,blockHash:request.identity.blockHash},stateDigest:digest(request.pools),
        poolIds:request.pools.map(p=>`${LANE}:${p.poolId}`),adapterId:'aero-v2',adapterRevision:artifact.artifactHash,payloadDigest:digest(payload.data),
        borrowAmount:result.principal,profitAsset:PROFIT_ASSET,minProfit:request.bounds.minNetProfit,maxGasCost:result.costInBorrowAsset,expiresAtMs};
      const admission:Admission={chain:'base',network:'8453',revision:artifact.artifactHash,expiresAtMs,evidence:{schema:payload.requestDigest,math:payload.snapshotDigest,simulation:proof.payloadDigest,canary:artifact.artifactHash}};
      const adapter=new EvmLiquidityExecutionAdapter({rpcUrl:rpc,submissionUrl,executor:artifact.address,executorCodeHash:artifact.runtimeCodeHash,codePins,admission,confirmations:1,codec:aeroRouteCodec(config.bounds.maxBlockLag),priorityFeePerGas},account,[{candidate,calldata:payload.data}]);
      const reserveWei=budget.remaining('trade')<uint(result.costInBorrowAsset)*2n?budget.remaining('trade'):uint(result.costInBorrowAsset)*2n;
      const sign=adapter.sign.bind(adapter);
      adapter.sign=async(c,resource,signal)=>{
        signal?.throwIfAborted();const signed=await sign(c,resource,signal);
        state.pending={hash:signed.transactionId as Hex,candidate:c,calldata:payload.data,submissionStarted:false};state.status='pending';await save();
        await budget.reserve('trade',signed.transactionId as Hex,reserveWei);return signed;
      };
      adapter.beforeBroadcast=async hash=>{options.signal?.throwIfAborted();if(state.pending?.hash!==hash)throw new Error('PENDING_BINDING_MISMATCH');state.pending.submissionStarted=true;await save();};
      adapter.submissionNotAttempted=async()=>{if(state.pending){state.pending.submissionStarted=false;await save();}};
      const store=new SnapshotStore(30000);
      store.apply({schemaVersion:'3.0',identity:candidate.identity,sourceId:'aero-live',cursor:String(round+1),observedAtMs:Date.now(),complete:true,poolIds:candidate.poolIds,stateDigest:candidate.stateDigest});
      const decisions=await new LiquidityRuntime(store,journal,new Map([['aero-v2',adapter]])).run([candidate],{concurrency:1,maxCandidates:1,maxDailyLoss:reserveWei.toString(),minProfit:request.bounds.minNetProfit,budgetAssets:{[LANE]:PROFIT_ASSET},mode:'auto'});
      // run() reports the simulation and the signing-lane outcome separately; the lane outcome is final.
      const decision=decisions.find(d=>d.status!=='simulated')??decisions[0],pending=state.pending as LiveState['pending'];
      const common={blockNumber:request.identity.blockNumber,payloadDigest:candidate.payloadDigest,requestDigest:payload.requestDigest,priorityFeePerGas:priorityFeePerGas.toString(),...(pending?{txHash:pending.hash}:{})};
      if(pending&&!pending.submissionStarted){if(budget.has(pending.hash))await budget.cancelUnsent(pending.hash);delete state.pending;}
      if(pending?.submissionStarted){
        const receipt=await plain.getTransactionReceipt({hash:pending.hash}).catch(()=>undefined);
        if(receipt)await budget.settle(pending.hash,receipt.gasUsed*receipt.effectiveGasPrice);
        delete state.pending;
        if(decision.code==='REVERT_GAS_ACCOUNTED'||receipt?.status==='reverted'){await halt('LIVE_REVERT',common.blockNumber);return state;}
        if(decision.status!=='reconciled'){await halt(decision.code,common.blockNumber);return state;}
        state.status='scanning';await record({status:'reconciled',...common});continue;
      }
      state.status='scanning';
      if(decision.status==='halted'){await halt(decision.code,common.blockNumber);return state;}
      await record({status:'skipped',reason:decision.code,...common});
    }
    await save();return state;
  });
}
