import { EvmBudget, TRADE_SUBMISSION_CAP } from './budget.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPublicClient, http, parseAbi, keccak256, toFunctionSelector, type Address, type Hex } from 'viem';
import { MULTI_LENDER_ROUTE_ABI } from '../liquidity/arbitrum.js';
import { evmProfile, PROFIT_ASSETS } from '../evm-chains.js';
import { nativeCostInAsset, priceUsdE8, receiptNativeCost, type GasValuation } from '../evm-fees.js';
import { readEvmAnalyticsSnapshot, type AnalyticsPoolConfig } from '../liquidity/sources.js';
import { prepareArbitrumTrade } from '../liquidity/arbitrum.js';
import { EvmLiquidityExecutionAdapter } from '../liquidity/arbitrum-execution.js';
import { digest, SnapshotStore, uint } from '../liquidity/state.js';
import { AttemptJournal } from '../liquidity/journal.js';
import { LiquidityRuntime, type RouteCandidate } from '../liquidity/runtime.js';
import { ExecutionLock } from '../execution-lock.js';
import { atomicJson, loadSigner, parseManifest, secureEndpoint, type DeploymentState } from './deployment.js';

export interface AcceptanceConfig {
  schemaVersion: '1.0'; chainId: number; manifestPath: string; deploymentStatePath: string;
  evidencePath: string; statePath: string; pools: AnalyticsPoolConfig[];
  venueRoots: Record<string, Address>; profitAsset: Address;
  assetUsdFeed: Address; nativeUsdFeed: Address; feedCodePins: Record<string, Hex>;
  maxPriceAgeSeconds: number; maxRounds: number; pollIntervalMs: number;
}
export interface AcceptanceState {
  schemaVersion: '1.0'; chainId: number; owner: Address; configDigest: string; startedAtMs: number;
  submissions: number; spentGasWei: string; status: string; rounds: number;
  pending?: { candidate: RouteCandidate; calldata: Hex; hash: Hex; valuation: GasValuation; submissionStarted: boolean };
  receipts: Array<{ schemaVersion:'1.0'; chainId:number; transactionHash: Hex; blockNumber: string; blockHash: Hex; netProfitUsdE8: string; gasWei: string; status:'awaiting-finality'|'profitable-finalized'; source:string }>;
}
/** Enumerate bounded simple return paths from one settlement asset. Reverse traversals are deduplicated. */
export function enumerateSimpleProfitCycles(pools: ReadonlyArray<Pick<import('../liquidity/projection.js').PoolStateEnvelope,'poolId'|'token0'|'token1'>>, profitAsset: Address, maxHops = 6) {
  if(!Number.isSafeInteger(maxHops) || maxHops<2 || maxHops>6 || pools.length<2 || pools.length>6)throw new Error('INVALID_CYCLE_GRAPH');
  const same=(left:string,right:string)=>left.toLowerCase()===right.toLowerCase();
  const start=profitAsset.toLowerCase(), ordered=[...pools].sort((left,right)=>left.poolId.localeCompare(right.poolId));
  if(new Set(ordered.map(pool=>pool.poolId)).size!==ordered.length || ordered.some(pool=>same(pool.token0,pool.token1)))throw new Error('INVALID_CYCLE_GRAPH');
  const cycles=new Map<string,Array<{poolId:string;tokenIn:string}>>();
  const walk=(asset:string,path:Array<{poolId:string;tokenIn:string}>,used:Set<string>)=>{
    for(const pool of ordered) {
      if(used.has(pool.poolId) || (!same(asset,pool.token0) && !same(asset,pool.token1)))continue;
      const next=same(asset,pool.token0)?pool.token1:pool.token0;
      const route=[...path,{poolId:pool.poolId,tokenIn:asset}];
      if(same(next,start)) {
        if(route.length<2)continue;
        const forward=route.map(leg=>leg.poolId).join(','), reverse=[...route].reverse().map(leg=>leg.poolId).join(',');
        cycles.set(forward<reverse?forward:reverse,route);
      } else if(route.length<maxHops) {
        const nextUsed=new Set(used);nextUsed.add(pool.poolId);walk(next,route,nextUsed);
      }
    }
  };
  walk(profitAsset,[],new Set());
  return [...cycles.entries()].sort(([left],[right])=>left.localeCompare(right)).map(([,route])=>route);
}
export function parseAcceptance(input: unknown): AcceptanceConfig {
  const c = input as AcceptanceConfig;
  const fields = 'assetUsdFeed,chainId,deploymentStatePath,evidencePath,feedCodePins,manifestPath,maxPriceAgeSeconds,maxRounds,nativeUsdFeed,pollIntervalMs,pools,profitAsset,schemaVersion,statePath,venueRoots';
  if (!c || Object.keys(c).sort().join(',') !== fields || c.schemaVersion !== '1.0' || ![8453,4663].includes(c.chainId) || !Array.isArray(c.pools) || c.pools.length < 2 || c.pools.length > 6 || !Number.isSafeInteger(c.maxRounds) || c.maxRounds < 1 || c.maxRounds > 86400 || !Number.isSafeInteger(c.pollIntervalMs) || c.pollIntervalMs < 1000 || c.pollIntervalMs > 60000 || !Number.isSafeInteger(c.maxPriceAgeSeconds) || c.maxPriceAgeSeconds < 1 || c.maxPriceAgeSeconds > 86400) throw new Error('INVALID_ACCEPTANCE_CONFIG');
  if (![c.manifestPath,c.deploymentStatePath,c.evidencePath,c.statePath].every(v => typeof v === 'string' && v.length > 0) || typeof c.profitAsset!=='string' || !PROFIT_ASSETS[c.chainId]?.includes(c.profitAsset.toLowerCase() as Address)) throw new Error('INVALID_ACCEPTANCE_BINDING');
  if(!c.feedCodePins || typeof c.feedCodePins!=='object' || Object.keys(c.feedCodePins).length>2 || !c.venueRoots || typeof c.venueRoots!=='object' || Object.keys(c.venueRoots).length>6)throw new Error('INVALID_ACCEPTANCE_BINDING');
  for (const feed of [c.assetUsdFeed,c.nativeUsdFeed]) if (!/^0x[0-9a-fA-F]{40}$/.test(feed) || !/^0x[0-9a-f]{64}$/.test(c.feedCodePins?.[feed.toLowerCase()] ?? '')) throw new Error('UNPINNED_PRICE_FEED');
  return structuredClone(c);
}
/** Local proof artifacts are explicit host inputs. Their contents and capabilities must agree. */
export async function loadAdmissionEvidence(path: string, chainId: number, executor: { runtimeCodeHash: Hex; artifactHash: string }) {
  const evidence=JSON.parse(await readFile(path,'utf8'));
  const capability=toFunctionSelector(MULTI_LENDER_ROUTE_ABI[0]);
  if(!evidence || Object.keys(evidence).sort().join(',')!=='artifactHash,capability,chainId,executorCodeHash,proofs,schemaVersion' || evidence.schemaVersion!=='1.0' || evidence.chainId!==chainId || evidence.executorCodeHash!==executor.runtimeCodeHash || evidence.artifactHash!==executor.artifactHash || evidence.capability!==capability || !evidence.proofs || Object.keys(evidence.proofs).sort().join(',')!=='canary,math,schema,simulation')throw new Error('MISSING_EXECUTION_ADMISSION_EVIDENCE');
  const verified: Record<string,string>={};
  for(const kind of ['schema','math','simulation','canary']) {
    const ref=evidence.proofs[kind];
    if(!ref || Object.keys(ref).sort().join(',')!=='path,sha256' || typeof ref.path!=='string' || !/^[a-f0-9]{64}$/.test(ref.sha256))throw new Error('INVALID_ADMISSION_PROOF_REFERENCE');
    const bytes=await readFile(ref.path), hash=createHash('sha256').update(bytes).digest('hex');
    if(hash!==ref.sha256)throw new Error('ADMISSION_PROOF_HASH_MISMATCH');
    const proof=JSON.parse(bytes.toString());
    if(proof.schemaVersion!=='1.0' || proof.kind!==kind || proof.success!==true || proof.chainId!==chainId || proof.executorCodeHash!==executor.runtimeCodeHash || proof.artifactHash!==executor.artifactHash || proof.capability!==capability || typeof proof.source!=='string' || !proof.source || !Number.isSafeInteger(proof.verifiedAtMs) || proof.verifiedAtMs<=0 || proof.verifiedAtMs>Date.now())throw new Error('ADMISSION_PROOF_BINDING_MISMATCH');
    if(['simulation','canary'].includes(kind) && (!/^0x[0-9a-f]{64}$/.test(proof.blockHash) || /^0x0{64}$/.test(proof.blockHash)))throw new Error('ADMISSION_PROOF_BLOCK_REQUIRED');
    verified[kind]=`${ref.path}#sha256:${hash}`;
  }
  return verified;
}
/** Bounded real-route acceptance. A no-op/rejection never counts as live proof. */
export async function runAcceptance(path: string, envFile?: string, reconcileOnly = false) {
  const config = parseAcceptance(JSON.parse(await readFile(path,'utf8')));
  if (!envFile) throw new Error('EXPLICIT_SIGNER_ENV_FILE_REQUIRED');
  const account = await loadSigner(envFile), profile = evmProfile(config.chainId);
  const manifest = parseManifest(JSON.parse(await readFile(config.manifestPath,'utf8')));
  const deployment: DeploymentState = JSON.parse(await readFile(config.deploymentStatePath,'utf8'));
  const executor = deployment.deployments.find(d=>d.contract==='MultiVenueArbitrageExecutor' && d.status==='verified');
  const lender = manifest.roots.find(r=>r.role==='morpho');
  if (manifest.chainId !== config.chainId || deployment.chainId !== config.chainId || deployment.owner.toLowerCase() !== account.address.toLowerCase() || !executor || !lender) throw new Error('UNVERIFIED_EXECUTOR_OR_LENDER');
  const evidence = await loadAdmissionEvidence(config.evidencePath,config.chainId,executor);
  const rpc = process.env[profile.rpcEnv] ?? profile.chain.rpcUrls.default.http[0];
  const client = createPublicClient({ transport:http(secureEndpoint(rpc),{timeout:15000,retryCount:0}) });
  const submission = process.env[`${profile.key.toUpperCase()}_SUBMISSION_URL`] ?? rpc;
  const lane = `${profile.key}:${config.chainId}`, profitAsset = config.profitAsset.toLowerCase() as Address;
  const tokenAbi = parseAbi(['function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)']);
  return new ExecutionLock(`.nim/signing/${config.chainId}-${account.address.toLowerCase()}.lock`).runExclusive(async()=>{
    const authorityPath = `.nim/evm-acceptance/${config.chainId}-${account.address.toLowerCase()}.json`;
    const budget = new EvmBudget(config.chainId, account.address); await budget.load();
    let state: AcceptanceState;
    try { state=JSON.parse(await readFile(authorityPath,'utf8')); }
    catch(e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; state={schemaVersion:'1.0',chainId:config.chainId,owner:account.address,configDigest:digest(config),startedAtMs:Date.now(),submissions:0,spentGasWei:'0',status:'scanning',rounds:0,receipts:[]}; }
    if (state.chainId!==config.chainId || state.owner!==account.address || state.configDigest!==digest(config)) throw new Error('ACCEPTANCE_STATE_BINDING_MISMATCH');
    const journal = new AttemptJournal(`${authorityPath}.attempts.jsonl`);
    const deadline = state.startedAtMs+86400000;
    const save = async()=>{
      state.submissions = budget.tradeCount(); state.spentGasWei = budget.spent('trade').toString();
      await atomicJson(authorityPath,state); await atomicJson(config.statePath,state);
    };
    const codePins: Record<string,Hex>={...config.feedCodePins};
    for(const root of manifest.roots)codePins[root.address.toLowerCase()]=root.codeHash;
    const adapterFor = (candidate: RouteCandidate,calldata: Hex,valuation: GasValuation) => new EvmLiquidityExecutionAdapter({rpcUrl:rpc,submissionUrl:submission,executor:executor.address,executorCodeHash:executor.runtimeCodeHash,codePins,admission:{chain:profile.key,network:String(config.chainId),revision:executor.artifactHash,expiresAtMs:Date.now()+30000,evidence:{schema:evidence.schema,math:evidence.math,simulation:evidence.simulation,canary:evidence.canary}},confirmations:2,...(profitAsset!==profile.wrappedNative?{valuation}:{})},account,[{candidate,calldata}]);
    const reconcile = async()=>{
      const pending=state.pending;
      if(!pending)throw new Error('MISSING_PENDING_EXECUTION');
      let receipt;
      try { receipt=await client.getTransactionReceipt({hash:pending.hash}); }
      catch { state.status='acceptance-unknown';await save();return false; }
      for(const [address,pin] of Object.entries(config.feedCodePins)) {
        const code=await client.getCode({address:address as Address,blockNumber:receipt.blockNumber});
        if(!code || keccak256(code)!==pin)throw new Error('PRICE_FEED_CHANGED');
      }
      const raw=await client.request({method:'eth_getTransactionReceipt',params:[pending.hash]});
      const gas=receiptNativeCost(config.chainId,receipt,raw);
      await budget.settle(pending.hash,gas);
      const proof=await adapterFor(pending.candidate,pending.calldata,pending.valuation).receipt(pending.hash);
      if(!proof || !proof.repaymentProven || !proof.profitCustodyProven || receipt.status!=='success') {state.status='halted';await save();return false;}
      const net=uint(proof.profitAfterDebt)-uint(proof.gasCostInProfitAsset);
      const realizedPrice=await priceUsdE8(client,config.assetUsdFeed,receipt.blockNumber,config.maxPriceAgeSeconds);
      const netUsd=net*realizedPrice/10n**BigInt(pending.valuation.decimals);
      if(netUsd<1000000000n) {state.status='halted';await save();return false;}
      if(!state.receipts.some(r=>r.transactionHash===pending.hash))state.receipts.push({schemaVersion:'1.0',chainId:config.chainId,transactionHash:pending.hash,blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,netProfitUsdE8:netUsd.toString(),gasWei:gas.toString(),status:'awaiting-finality',source:proof.source});
      const attempt=(await journal.latest()).find(a=>a.transactionId===pending.hash);
      if(attempt?.state==='signed')await journal.transition(attempt.id,'submitted',pending.hash);
      if(attempt && attempt.state!=='reconciled')await journal.transition(attempt.id,'reconciled',pending.hash,0n);
      state.status='awaiting-finality';await save();
      do {
        const finalized=await client.getBlock({blockTag:'finalized'});
        if((await client.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash) {state.status='halted';await save();throw new Error('RECEIPT_REORG');}
        if(finalized.number>=receipt.blockNumber) {state.status='profitable-finalized';state.receipts.find(r=>r.transactionHash===pending.hash)!.status='profitable-finalized';await save();return true;}
        if(reconcileOnly)return false;
        await new Promise(r=>setTimeout(r,15000));
      } while(Date.now()<deadline);
      return false;
    };
    for(const orphan of await journal.latest()) {
      if(orphan.state==='prepared' && orphan.transactionId===null)await journal.transition(orphan.id,'cancelled',null,0n);
    }
    if(state.status==='profitable-finalized') {await reconcile();return state;}
    if(state.pending && !state.pending.submissionStarted) {
      const hash=state.pending.hash;if(budget.has(hash))await budget.cancelUnsent(hash);
      const unsent=(await journal.latest()).find(a=>a.transactionId===hash);
      if(unsent && unsent.state!=='cancelled')await journal.transition(unsent.id,'cancelled',hash,0n);
      delete state.pending;state.status='scanning';await save();
    }
    if(state.pending) {await reconcile();return state;}
    if(state.status==='halted' || budget.unresolved().length)throw new Error('UNRESOLVED_ACCEPTANCE_ATTEMPT');
    if(reconcileOnly)return state;
    for (;state.rounds<config.maxRounds && Date.now()<deadline && budget.tradeCount()<TRADE_SUBMISSION_CAP && budget.remaining('trade')>0n;state.rounds++) {
      if (await client.getChainId()!==config.chainId) throw new Error('SOURCE_CHAIN_MISMATCH');
      const captured=await readEvmAnalyticsSnapshot(rpc,'evm-acceptance',String(state.rounds),config.pools);
      const block=BigInt(captured.snapshot.identity.height);
      for (const [address,pin] of Object.entries(config.feedCodePins)) {
        const code=await client.getCode({address:address as Address,blockNumber:block});
        if (!code || (await import('viem')).keccak256(code)!==pin) throw new Error('PRICE_FEED_CHANGED');
      }
      const [decimals,price,available]=await Promise.all([
        client.readContract({address:profitAsset,abi:tokenAbi,functionName:'decimals',blockNumber:block}),
        priceUsdE8(client,config.assetUsdFeed,block,config.maxPriceAgeSeconds),
        client.readContract({address:profitAsset,abi:tokenAbi,functionName:'balanceOf',args:[lender.address],blockNumber:block})
      ]);
      if (decimals>18) throw new Error('INVALID_ASSET_DECIMALS');
      const wrapped=profitAsset===profile.wrappedNative;
      if (!wrapped && (price<99000000n || price>101000000n)) throw new Error('STABLECOIN_DEPEG');
      const valuation: GasValuation={asset:profitAsset,decimals,nativeUsdFeed:config.nativeUsdFeed,assetUsdFeed:config.assetUsdFeed,maxAgeSeconds:config.maxPriceAgeSeconds};
      const reserveNative=budget.remaining('trade');
      const gasReserve=wrapped?reserveNative:await nativeCostInAsset(client,reserveNative,block,valuation);
      const minimumProfit=(1000000000n*10n**BigInt(decimals)+price-1n)/price;
      const cap=100000n*100000000n*10n**BigInt(decimals)/price;
      const maximum=available<cap?available:cap;
      const cycles=enumerateSimpleProfitCycles(captured.pools,profitAsset);
      const byPoolId=new Map(captured.pools.map(pool=>[pool.poolId,pool]));
      for(const route of cycles) {
        if (budget.tradeCount()>=TRADE_SUBMISSION_CAP || !maximum || !gasReserve) break;
        const pools=route.map(leg=>byPoolId.get(leg.poolId)!);
        const snapshot={...captured.snapshot,poolIds:pools.map(p=>p.poolId),stateDigest:digest(pools)};
        const roots=pools.map(p=>{const root=p.state.protocol==='uniswap-v4'?p.poolAddress:config.venueRoots[p.poolAddress.toLowerCase()];if(!root || !codePins[root.toLowerCase()]) throw new Error('UNPINNED_VENUE_ROOT');if(p.state.protocol!=='uniswap-v4')codePins[p.poolAddress.toLowerCase()]=p.revisionHash as Hex;return{poolId:p.poolId,root:root as Address,adapterRevision:p.adapterRevision,revisionHash:p.revisionHash};});
        const expiresAtMs=Date.now()+30000;
        const prepared=prepareArbitrumTrade(pools,{schemaVersion:'4.0',snapshotDigest:digest(pools),borrowAsset:profitAsset,route,minimum:'1',maximum:maximum.toString(),quantum:'1',lenderAvailable:available.toString(),flashFeeNumerator:'0',flashFeeDenominator:'1',costInBorrowAsset:gasReserve.toString(),costEvidenceDigest:digest({block:block.toString(),reserveNative:reserveNative.toString(),price:price.toString()}),minProfit:minimumProfit.toString(),maxEvaluations:64},snapshot,{kind:'morpho-blue',lender:lender.address,deadline:String(Math.floor(expiresAtMs/1000)),roots,adapterId:'evm-acceptance',adapterRevision:executor.artifactHash,expiresAtMs,maxGasCost:gasReserve.toString()});
        if (!prepared.candidate || !prepared.unsignedPayload) continue;
        const adapter=adapterFor(prepared.candidate,prepared.unsignedPayload,valuation);
        const sign=adapter.sign.bind(adapter);
        adapter.sign=async(candidate,resource,signal)=>{
          const signed=await sign(candidate,resource,signal);
          state.pending={candidate,calldata:prepared.unsignedPayload!,hash:signed.transactionId,valuation,submissionStarted:false};
          state.status='signed';await save();
          await budget.reserve('trade',signed.transactionId,reserveNative);await save();return signed;
        };
        adapter.beforeBroadcast=async(hash)=>{
          if(!state.pending || state.pending.hash!==hash || Date.now()>=deadline)throw new Error('ACCEPTANCE_LIMIT_REACHED');
          state.pending.submissionStarted=true;state.status='acceptance-unknown';await save();
        };
        adapter.submissionNotAttempted=async()=>{
          if(state.pending){state.pending.submissionStarted=false;await save();}
        };
        const store=new SnapshotStore(30000);store.apply(snapshot);
        const decisions=await new LiquidityRuntime(store,journal,new Map([['evm-acceptance',adapter]])).run([prepared.candidate],{concurrency:1,maxCandidates:1,maxDailyLoss:gasReserve.toString(),minProfit:minimumProfit.toString(),budgetAssets:{[lane]:prepared.candidate.profitAsset},mode:'auto',stepTimeoutMs:15000});
        const attemptId=decisions.find(d=>d.attemptId)?.attemptId;
        const attempt=attemptId?(await journal.latest()).find(a=>a.id===attemptId):undefined;
        const currentPending = (() : AcceptanceState['pending'] => state.pending)();
        if(currentPending?.submissionStarted) {await reconcile();return state;}
        // All work stayed inside local verification; no transport send was invoked.
        if(currentPending){if(budget.has(currentPending.hash))await budget.cancelUnsent(currentPending.hash);delete state.pending;}
        if(attempt && attempt.state==='halted')await journal.transition(attempt.id,'cancelled',attempt.transactionId,0n);
        if(decisions.some(d=>d.status==='halted'&&!['STATE_CHANGED','EXECUTION_CANCELLED','ADAPTER_TIMEOUT','NONCE_CHANGED'].includes(d.code))) {state.status='halted';await save();return state;}
        state.status='scanning';await save();
      }
      state.status='scanning';await save();
      if(state.rounds+1<config.maxRounds)await new Promise(r=>setTimeout(r,config.pollIntervalMs));
    }
    state.status='NO_PROFITABLE_OPPORTUNITY';await save();return state;
  });
}
