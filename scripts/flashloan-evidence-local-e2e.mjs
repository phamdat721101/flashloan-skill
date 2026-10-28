import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keccak256} from 'viem';
import {startAeroNode,aeroTestClients,loadAeroArtifact,startL1FeeProxy} from './aero-e2e-utils.mjs';
import {runGapEvidence} from '../dist/evidence/gap-runtime.js';
import {runEvidence,payloadHash} from '../dist/evidence/runtime.js';
import {ArtifactStore,evidenceBytes} from '../dist/evidence/integrity.js';
import {buildLedger,compilePolicy} from '../dist/evidence/economics.js';
import {digest,SnapshotStore} from '../dist/liquidity/state.js';
import {projectPool} from '../dist/liquidity/projection.js';
import {encodeLenderArbitrage} from '../dist/liquidity/arbitrum.js';
import {EvmLiquidityExecutionAdapter} from '../dist/liquidity/arbitrum-execution.js';
import {AttemptJournal} from '../dist/liquidity/journal.js';
import {LiquidityRuntime} from '../dist/liquidity/runtime.js';
import {estimateEvmFees,receiptNativeCost} from '../dist/evm-fees.js';
import {projectRoundRow,roundRowCsv} from '../dist/execution-outcome.js';
const E=10n**18n,WETH='0x4200000000000000000000000000000000000006';
const node=await startAeroNode({port:19551,optimism:true}),proxy=await startL1FeeProxy(node.rpc);
const {client,account,wallet,deploy,write}=aeroTestClients(node.rpc);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),raw=value=>`0x${evidenceBytes(value).toString('hex')}`;
const directory=await mkdtemp(join(tmpdir(),'flashloan-evidence-e2e-')),store=new ArtifactStore(directory);
try{
  const token=await loadAeroArtifact('TestToken','ImmutableArbitrageExecutor.t');
  await client.request({method:'anvil_setCode',params:[WETH,token.deployedBytecode.object]});
  await client.request({method:'anvil_setCode',params:['0x420000000000000000000000000000000000000f','0x600060005260206000f3']});
  const a={address:WETH,abi:token.abi},b=await deploy('TestToken','ImmutableArbitrageExecutor.t');
  const roots=[await deploy('TestAeroFactory','AeroSplitExecutor.t'),await deploy('TestAeroFactory','AeroSplitExecutor.t')];
  for(const root of roots)await write(root,'setFee',[0n]);
  const venues=[];for(const root of roots){const p=await deploy('TestAeroPool','AeroSplitExecutor.t',[root.address,WETH,b.address,false]);await write(root,'setPool',[WETH,b.address,false,p.address]);venues.push(p);}
  for(const [i,x,y]of[[0,1000n*E,2000n*E],[1,3000n*E,1000n*E]]){await write(a,'mint',[venues[i].address,x]);await write(b,'mint',[venues[i].address,y]);await write(venues[i],'sync');}
  const lender=await deploy('TestMorphoLender','MultiVenueArbitrageExecutor.t'),executor=await deploy('MultiVenueArbitrageExecutor');
  const code=async address=>keccak256(await client.getCode({address}));
  await write(a,'mint',[lender.address,100000n*E]);await write(a,'mint',[executor.address,7n]);
  await write(executor,'configureLender',[1,lender.address,await code(lender.address),true]);
  for(const root of roots)await write(executor,'configureRoot',[2,root.address,await code(root.address),true,false]);
  const block=await client.getBlock(),observedAtNs=String(BigInt(Date.now())*1000000n),expiresAtNs=String(BigInt(observedAtNs)+120000000000n);
  const ref=(kind,contentHash)=>({kind,contentHash,sourceId:'constructed-local-e2e',locator:'local-artifact',observedAtNs,expiresAtNs});
  const asset={namespace:'eip155',networkId:'8453',assetId:WETH,decimals:18};
  const pools=[];for(const [i,p]of venues.entries()){const [reserve0,reserve1]=await client.readContract({...p,functionName:'getReserves',blockNumber:block.number});pools.push({schemaVersion:'4.0',identity:{chain:'base',network:'8453',height:String(block.number),blockHash:block.hash},poolId:`base:8453:${p.address}`,poolAddress:p.address,adapterRevision:'constructed-local-v2',revisionHash:await code(p.address),token0:WETH,token1:b.address,decimals0:18,decimals1:18,stateClass:'canonical',appliedOperations:[],state:{protocol:'uniswap-v2',reserve0:String(reserve0),reserve1:String(reserve1),feeNumerator:'1',feeDenominator:'1'}});}
  const encode=(principal,poolPath,minProfit)=>{let amount=principal;const mutated=new Map(pools.map(p=>[p.poolId,p]));let assetIn=WETH;const legs=poolPath.map((id,i)=>{const p=mutated.get(id),q=projectPool(p,{schemaVersion:'4.0',snapshotDigest:digest(p),operationId:`local:${i}`,operationClass:'hypothetical',tokenIn:assetIn,amountIn:String(amount)});amount=BigInt(q.amountOut);assetIn=q.tokenOut;mutated.set(id,q.projectedState);return {venueVersion:2,root:roots[pools.indexOf(pools.find(x=>x.poolId===id))].address,pool:p.poolAddress,tokenIn:q.tokenIn,tokenOut:q.tokenOut,minAmountOut:q.amountOut,fee:0,sqrtPriceLimitX96:'0',tickSpacing:0,hooks:`0x${'0'.repeat(40)}`,hookData:'0x'};});return encodeLenderArbitrage({kind:'morpho-blue',lender:lender.address,flashAsset:WETH,flashAmount:String(principal),minProfit:String(minProfit),deadline:String(block.timestamp+600n),legs});};
  const probe=encode(E,pools.map(p=>p.poolId),1n),fees=await estimateEvmFees(client,8453,account.address,executor.address,probe);
  const cost=fees.gas*2n*fees.fees.maxFeePerGas+fees.publicationFee,costRef=ref('configuration',digest({gas:String(fees.gas),maxFee:String(fees.fees.maxFeePerGas),publicationFee:String(fees.publicationFee)}));
  const valuation={price:{numerator:'1000',denominator:'1'},ref:ref('configuration',digest('constructed-local-price-only'))};
  const gapMode=process.env.PRICE_GAP_E2E==='1';
  const profile={principalCapRaw:String(400n*E),minimumPrincipalRaw:String(E),minimumBranchRaw:'0',minProfitUsd:{numerator:gapMode?'0':'10',denominator:'1'},maxPriceImpactBps:5000,minDeploymentBps:0,minBranchWeightBps:0,maxHopsPerBranch:2,maxBranches:1,maxTotalSwaps:2,maxAttempts:40,deadlineMs:2000,maxStateAgeNs:'120000000000',maxDailyLossRaw:String(E)};
  const profileRef=ref('configuration',digest(profile)),locator={namespace:'eip155',networkId:'8453',assetId:WETH};
  const request={schemaVersion:gapMode?'5.2':'5.1',recordType:'run-request',runId:'constructed-local-round',mode:'unsigned-simulation',networkId:'8453',assetLocators:[locator,{...locator,assetId:b.address}],borrowAsset:locator,riskProfileRef:profileRef,principalCapRaw:profile.principalCapRaw,requestedMinProfitUsd:null,requestedPriceImpactBps:null,networkCostEvidenceRef:costRef,valuationEvidenceRef:valuation.ref,watchDurationMs:0,caller:account.address.toLowerCase(),executor:executor.address,executorMode:'fixture',rotationMode:'report-only',requestedMinDeploymentBps:0,requestedMinBranchWeightBps:0,requestedMinPrincipalUsd:null,requestedMinBranchUsd:null,inventoryMinLiquidityUsd:null};
  const market={identity:{namespace:'eip155',networkId:'8453',height:String(block.number),stateHashOrDigest:block.hash,finality:'node-confirmed'},pools,asset,lender:{capacityRaw:String(100000n*E),feeNumerator:'0',feeDenominator:'1',evidence:ref('configuration',digest('local-morpho-terms'))},networkCost:{asset,amountRaw:{value:String(cost),reason:null},basis:'fee-estimate',includedInSwapOutput:false,evidence:costRef},valuation,observedAtNs,quantumRaw:String(E),openingBalances:{operatorPrefundRaw:'0',executorOpeningBalanceRaw:'7',evidence:ref('configuration',digest('measured-local-opening-7'))}};
  let compiled,traceTerminal;
  const host={profile:async()=>({body:profile,ref:profileRef}),inventory:async()=>[],capture:async()=>market,
    compile:async(req,plan)=>{const policy=compilePolicy(req,{body:profile,ref:profileRef},asset,valuation,BigInt(observedAtNs)),bytesHex=encode(BigInt(plan.principalRaw),plan.branches[0].poolPath,BigInt(policy.minProfitRaw)+1n+cost),revision=hash(await readFile('out/MultiVenueArbitrageExecutor.sol/MultiVenueArbitrageExecutor.json'));
      const candidate={identity:pools[0].identity,stateDigest:plan.stateDigest,poolIds:pools.map(p=>p.poolId),adapterId:'constructed-local',adapterRevision:revision,payloadDigest:digest(bytesHex),borrowAmount:plan.principalRaw,profitAsset:`base:8453:${WETH}`,minProfit:String(BigInt(policy.minProfitRaw)+1n),maxGasCost:String(cost),expiresAtMs:Number(block.timestamp+600n)*1000};
      compiled={bytesHex,executionContextHash:plan.executionContextHash,executorCodeOrPackageHash:(await code(executor.address)).slice(2),adapterRevision:revision,sourceId:'constructed-local-existing-bytecode',observedAtNs,expiresAtNs,executionCandidate:candidate};return compiled;},
    simulate:async(req,plan,payload)=>{await client.call({account:account.address,to:executor.address,data:payload.bytesHex,blockNumber:block.number});
      const trace=await client.request({method:'debug_traceCall',params:[{from:account.address,to:executor.address,data:payload.bytesHex},`0x${block.number.toString(16)}`,{tracer:'callTracer'}]});
      const all=[];const visit=c=>{all.push(c);for(const next of c.calls??[])visit(next);};visit(trace);
      const balanceCalls=all.filter(c=>c.to?.toLowerCase()===WETH&&c.input?.toLowerCase().startsWith('0x70a08231')&&c.input.toLowerCase().endsWith(executor.address.slice(2)));assert.ok(balanceCalls.length);traceTerminal=BigInt(balanceCalls.at(-1).output);
      const bytesHex=raw(trace),resultEvidence=ref('native-simulation',payloadHash(bytesHex));
      return {rawResult:{bytesHex},proof:{schemaVersion:'5.1',recordType:'native-simulation-proof',runId:req.runId,candidateHash:plan.planHash,stateDigest:plan.stateDigest,policyHash:plan.policyHash,payloadHash:payloadHash(payload.bytesHex),executorCodeOrPackageHash:payload.executorCodeOrPackageHash,adapterRevision:payload.adapterRevision,fidelity:'fixture-native',success:true,repaymentProven:true,terminalBalanceBasis:'after-debt-with-unused',terminalBalanceRaw:{value:String(traceTerminal),reason:null},revertDataRef:null,overrideRefs:[],resultEvidence,executionContextHash:plan.executionContextHash}};}}
  let round;
  if(gapMode){
    const option={optionId:'local-morpho-weth',lenderId:'local-morpho',lenderAddress:lender.address,callbackMode:'morpho-blue',asset,repaymentAsset:asset,identity:market.identity,capacityRaw:market.lender.capacityRaw,feeNumerator:'0',feeDenominator:'1',evidence:market.lender.evidence,executorCapabilityRef:ref('configuration',digest({executor:executor.address,code:await code(executor.address)}))};
    const gapHost={...host,compileFunding:async(option,...args)=>{assert.equal(option.lenderAddress,lender.address);return host.compile(...args);},simulateFunding:async(_option,...args)=>host.simulate(...args),funding:async()=>[option],captureFunding:async()=>({market,profile:{body:profile,ref:profileRef}})};
    const result=await runGapEvidence({schemaVersion:'5.2',recordType:'gap-run-request',runId:request.runId,request,allowedAssets:[asset],allowedLenderIds:[option.lenderId],principalCapsRaw:{[option.optionId]:profile.principalCapRaw},maxFundingOptions:1,maxAttemptsTotal:40,deadlineMs:30000},{store,host:gapHost,maxDurationMs:30000});
    assert.equal(result.selectedOptionId,option.optionId,JSON.stringify({attempts:result.attempts,reports:result.rounds.map(r=>r.artifacts.find(a=>a.kind==='report')?.value)}));round=result.rounds[0];
  }else round=await runEvidence(request,{store,host,maxDurationMs:30000});assert.equal(round.integrity.verdict,'PASS',JSON.stringify(round.integrity));assert.equal(round.integrity.evidenceClass,'SNAPSHOT_MODEL');request.runId=round.context.runId;
  const plan=round.artifacts.find(a=>a.kind==='plan').value;assert.ok(plan&&compiled);assert.equal(round.artifacts.find(a=>a.kind==='report').value.outcome,'INCONCLUSIVE','fixture must remain research-only');
  const journal=new AttemptJournal(join(directory,'attempts.jsonl')),candidate=compiled.executionCandidate,state=new SnapshotStore(120000);state.apply({schemaVersion:'3.0',identity:candidate.identity,sourceId:'constructed-local',cursor:'1',observedAtMs:Date.now(),complete:true,poolIds:candidate.poolIds,stateDigest:candidate.stateDigest});
  const pins={};for(const address of [lender.address,...roots.map(r=>r.address),...venues.map(v=>v.address)])pins[address]=await code(address);
  const adapter=new EvmLiquidityExecutionAdapter({rpcUrl:proxy.rpc,submissionUrl:proxy.rpc,executor:executor.address,executorCodeHash:`0x${compiled.executorCodeOrPackageHash}`,codePins:pins,admission:{chain:'base',network:'8453',revision:compiled.adapterRevision,expiresAtMs:candidate.expiresAtMs,evidence:{schema:plan.planHash,math:plan.stateDigest,simulation:payloadHash(compiled.bytesHex),canary:'constructed-local-only'}},confirmations:1},account,[{candidate,calldata:compiled.bytesHex}]);
  const lenderBefore=await client.readContract({...a,functionName:'balanceOf',args:[lender.address]}),opening=await client.readContract({...a,functionName:'balanceOf',args:[executor.address]});
  const decisions=await new LiquidityRuntime(state,journal,new Map([['constructed-local',adapter]])).run([candidate],{concurrency:1,maxCandidates:1,maxDailyLoss:String(E),minProfit:candidate.minProfit,budgetAssets:{'base:8453':candidate.profitAsset},mode:'auto',stepTimeoutMs:30000});
  const decision=decisions.find(d=>d.status==='reconciled');assert.ok(decision,JSON.stringify(decisions));
  const attempt=(await journal.latest()).find(a=>a.id===decision.attemptId),receipt=await client.getTransactionReceipt({hash:attempt.transactionId});
  const closing=await client.readContract({...a,functionName:'balanceOf',args:[executor.address]});assert.equal(closing,traceTerminal);assert.equal(await client.readContract({...a,functionName:'balanceOf',args:[lender.address]}),lenderBefore);assert.equal(closing-opening,BigInt(plan.outputAfterEmbeddedFeesRaw)-BigInt(plan.principalRaw));
  const rawReceipt={...receipt,blockNumber:String(receipt.blockNumber),cumulativeGasUsed:String(receipt.cumulativeGasUsed),gasUsed:String(receipt.gasUsed),effectiveGasPrice:String(receipt.effectiveGasPrice),transactionIndex:Number(receipt.transactionIndex),l1Fee:'0x0'};
  const clean=JSON.parse(JSON.stringify(rawReceipt,(_,v)=>typeof v==='bigint'?String(v):v)),receiptBytes=raw(clean),receiptSource={...ref('receipt',payloadHash(receiptBytes)),expiresAtNs:null};
  const actualCost=receiptNativeCost(8453,receipt,clean),ledger=buildLedger({schemaVersion:'5.1',runId:request.runId,asset,principalRaw:plan.principalRaw,deployedRaw:plan.principalRaw,unusedPrincipalRaw:'0',swapProceedsRaw:String(closing-opening+BigInt(plan.principalRaw)),flashFeeRaw:'0',networkCostRaw:String(actualCost),otherExternalCostsRaw:'0',operatorPrefundRaw:'0',executorOpeningBalanceRaw:String(opening),evidence:[receiptSource]});ledger.realizedNetRaw={value:ledger.simulatedNetRaw,reason:null};
  const receiptRecord={schemaVersion:'5.1',recordType:'execution-receipt',runId:request.runId,transactionId:attempt.transactionId,lane:'base:8453',success:true,repaymentProven:true,profitCustodyProven:true,source:receiptSource};
  const report={...round.artifacts.find(a=>a.kind==='report').value,outcome:'RECONCILED',ledgerRef:hash(evidenceBytes(ledger)),receiptRef:receiptSource,reasons:['CONSTRUCTED_LOCAL_E2E_ONLY']};
  const inputs=round.artifacts.filter(a=>!['report','ledger'].includes(a.kind)).map(({hash,...a})=>a);
  inputs.push({kind:'native-receipt',definition:'RawEvidence',value:{schemaVersion:'5.1',recordType:'raw-evidence',runId:request.runId,evidenceKind:'native-receipt',bytesHex:receiptBytes,contentHash:payloadHash(receiptBytes)}},{kind:'receipt',definition:'Receipt',value:receiptRecord},{kind:'ledger',definition:'Ledger',value:ledger},{kind:'report',definition:'Report',value:report});
  const amended=await store.publish(inputs,{...round.context,nowNs:String(BigInt(Date.now())*1000000n),attemptId:attempt.id},{journal,amendmentOf:hash(evidenceBytes(round))});
  assert.equal(amended.integrity.verdict,'PASS',JSON.stringify(amended.integrity));assert.equal(amended.integrity.evidenceClass,'RECEIPT');
  const row=projectRoundRow(report,amended.integrity,{state:round.artifacts.find(a=>a.kind==='canonical-state').value,plan,ledger,transactionId:attempt.transactionId},{date:new Date().toISOString().slice(0,10),roundId:'LOCAL-E2E',strategy:'S1',artifactPath:directory});
  await mkdir('.nim/e2e',{recursive:true});await writeFile('.nim/e2e/flashloan-evidence-local.csv',roundRowCsv([row]));
  const evidence={...(gapMode?{marker:'price_gap_local_receipt_proven'}:{}),success:true,scope:'constructed-local-only',publicNetworkAdmission:false,transactionId:attempt.transactionId,receiptStatus:receipt.status,lenderRepaid:true,openingBalancePreserved:true,nonzeroSwapLegs:plan.branches[0].hopCount,fixtureSimulationClass:round.integrity.evidenceClass,receiptClass:amended.integrity.evidenceClass,netRaw:ledger.realizedNetRaw.value,artifacts:directory};
  await writeFile('.nim/e2e/flashloan-evidence-local.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{proxy.close();node.close();}
