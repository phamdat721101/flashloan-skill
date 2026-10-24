import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { keccak256, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startAeroNode,aeroTestClients,loadAeroArtifact,startL1FeeProxy } from './aero-e2e-utils.mjs';
import { optimizeAeroSplit } from '../dist/aero/solver.js';
import { buildAeroSplitCalldata,simulateAeroExecution,aeroPriorityFee,AERO_V2_SELECTOR } from '../dist/aero/execution.js';
import { createAeroQuoterHost } from '../dist/aero/evm-host.js';
import { aeroRouteCodec } from '../dist/aero/live.js';
import { EvmLiquidityExecutionAdapter } from '../dist/liquidity/arbitrum-execution.js';
import { LiquidityRuntime } from '../dist/liquidity/runtime.js';
import { AttemptJournal } from '../dist/liquidity/journal.js';
import { SnapshotStore, digest } from '../dist/liquidity/state.js';
import { estimateEvmFees } from '../dist/evm-fees.js';

// Snapshot -> plan -> on-chain quoter top-K -> final simulation -> signed send through the
// shared runtime -> receipt proof; then a front-run on-chain revert is accounted, not hidden.
const WETH='0x4200000000000000000000000000000000000006',E=10n**18n;
const node=await startAeroNode({port:19547,optimism:true});
const {rpc}=node,{client,account,deploy,write}=aeroTestClients(rpc);
const l1Proxy=await startL1FeeProxy(rpc),adapterRpc=l1Proxy.rpc;
const signer=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const journalPath='.nim/e2e/aero-v2-local.attempts.jsonl';await rm(journalPath,{force:true});await rm(`${journalPath}.lock`,{force:true});
try{
  const token=await loadAeroArtifact('TestToken','ImmutableArbitrageExecutor.t');
  await client.request({method:'anvil_setCode',params:[WETH,token.deployedBytecode.object]});
  const a={address:WETH,abi:token.abi},b=await deploy('TestToken','ImmutableArbitrageExecutor.t');assert.ok(a.address<b.address);
  const firstRoot=await deploy('TestAeroFactory','AeroSplitExecutor.t'),backRoot=await deploy('TestAeroFactory','AeroSplitExecutor.t');await write(backRoot,'setFee',[0n]);
  const first=await deploy('TestAeroPool','AeroSplitExecutor.t',[firstRoot.address,a.address,b.address,false]),back=await deploy('TestAeroPool','AeroSplitExecutor.t',[backRoot.address,a.address,b.address,false]);
  await write(firstRoot,'setPool',[a.address,b.address,false,first.address]);await write(backRoot,'setPool',[a.address,b.address,false,back.address]);
  for(const [pool,x,y]of[[first,1000n*E,2000n*E],[back,3000n*E,1000n*E]]){await write(a,'mint',[pool.address,x]);await write(b,'mint',[pool.address,y]);await write(pool,'sync');}
  const lender=await deploy('TestMorphoLender','MultiVenueArbitrageExecutor.t'),executor=await deploy('AeroSplitFlashExecutorV2');
  await write(a,'mint',[lender.address,100000n*E]);await write(a,'mint',[executor.address,7n]);
  const hash=async address=>keccak256(await client.getCode({address}));
  await write(executor,'configureLender',[1,lender.address,await hash(lender.address),0n]);
  await write(executor,'configureFactory',[1,firstRoot.address,await hash(firstRoot.address)]);await write(executor,'configureFactory',[5,backRoot.address,await hash(backRoot.address)]);
  await write(executor,'configureV2Fee',[backRoot.address,0,true]);
  for(const pool of[first,back])await write(executor,'configurePool',[pool.address,await hash(pool.address),pool.address,await hash(pool.address)]);
  await client.request({method:'anvil_setCode',params:['0x420000000000000000000000000000000000000f','0x600060005260206000f3']});
  const bytes=await readFile('out/AeroSplitFlashExecutorV2.sol/AeroSplitFlashExecutorV2.json');
  const artifact={address:executor.address,runtimeCodeHash:await hash(executor.address),artifactHash:createHash('sha256').update(bytes).digest('hex'),selector:AERO_V2_SELECTOR,chainId:8453,version:2};
  const codePins={};for(const x of[lender.address,firstRoot.address,backRoot.address,first.address,back.address])codePins[x]=await hash(x);

  const build=async()=>{
    const block=await client.getBlock(),reserves=async p=>(await client.readContract({...p,functionName:'getReserves'})).slice(0,2).map(String);
    const [r0,r1]=await reserves(first),[s0,s1]=await reserves(back);
    const pools=[{poolId:'out',address:first.address,factory:firstRoot.address,generation:'classic',token0:a.address,token1:b.address,decimals0:18,decimals1:18,implementation:first.address,implementationCodeHash:codePins[first.address],state:{protocol:'aero-volatile',reserve0:r0,reserve1:r1,balance0:r0,balance1:r1,feeBps:30,stable:false}},
      {poolId:'back',address:back.address,factory:backRoot.address,generation:'external-v2',token0:a.address,token1:b.address,decimals0:18,decimals1:18,implementation:back.address,implementationCodeHash:codePins[back.address],state:{protocol:'uniswap-v2',reserve0:s0,reserve1:s1,feeNumerator:'1000000',feeDenominator:'1000000'}}];
    const pins=Object.entries(codePins).map(([address,codeHash])=>({address,codeHash,role:address===lender.address?'lender':[firstRoot.address,backRoot.address].includes(address)?'factory':'pool',sourceRevision:'1'.repeat(40)}));
    const fee=(await estimateEvmFees(client,8453,account.address,account.address,`0x${'11'.repeat(3072)}`)),native=900000n*fee.fees.maxFeePerGas+fee.publicationFee;
    return {schemaVersion:'aero-split/1.1',identity:{chainId:8453,blockNumber:block.number.toString(),blockHash:block.hash,timestamp:block.timestamp.toString()},sender:account.address.toLowerCase(),borrowAsset:a.address,pools,pins,
      branches:[{branchId:'cycle-a',legs:[{poolId:'out',tokenIn:a.address,minOutBps:9900,sqrtPriceLimitX96:'0'},{poolId:'back',tokenIn:b.address,minOutBps:9900,sqrtPriceLimitX96:'0'}]}],
      lenders:[{lenderId:'morpho-local',kind:'morpho',address:lender.address,codeHash:codePins[lender.address],asset:a.address,available:(100000n*E).toString(),feeNumerator:'0',feeDenominator:'1',feeRounding:'zero',termsEvidenceDigest:'2'.repeat(64)}],
      bounds:{minimum:E.toString(),maximum:(400n*E).toString(),quantum:E.toString(),minNetProfit:'1',deadline:(block.timestamp+60n).toString(),maxBlockLag:3},
      cost:{evidenceDigest:digest({native:native.toString()}),nativeAsset:WETH,borrowAsset:WETH,nativeCostWei:native.toString(),costInBorrowAsset:native.toString(),conversionNumerator:'1',conversionDenominator:'1',valuationEvidenceDigest:'2'.repeat(64),maxAgeSeconds:60},
      limits:{maxEvaluations:400,borrowSamples:8,allocationChunks:4,maxQuoteSteps:256,quoteTopK:3,refine:true}};
  };
  const send=async(request,selected,interfere)=>{
    const payload=buildAeroSplitCalldata(request,selected,artifact);
    const gas=(await estimateEvmFees(client,8453,account.address,artifact.address,payload.data)).gas;
    const priorityFeePerGas=aeroPriorityFee({bidShareBps:100,maxPriorityFeePerGas:2_000_000_000n},BigInt(selected.netProfit),1n,1n,gas);
    const proof=await simulateAeroExecution(client,request,selected,artifact,{syntheticLocalRpc:rpc,priorityFeePerGas});
    const expiresAtMs=Number(request.bounds.deadline)*1000;
    const candidate={identity:{chain:'base',network:'8453',height:request.identity.blockNumber,blockHash:request.identity.blockHash},stateDigest:digest(request.pools),poolIds:request.pools.map(p=>`base:8453:${p.poolId}`),adapterId:'aero-v2',adapterRevision:artifact.artifactHash,payloadDigest:digest(payload.data),borrowAmount:selected.principal,profitAsset:`base:8453:${WETH}`,minProfit:request.bounds.minNetProfit,maxGasCost:selected.costInBorrowAsset,expiresAtMs};
    const admission={chain:'base',network:'8453',revision:artifact.artifactHash,expiresAtMs,evidence:{schema:payload.requestDigest,math:payload.snapshotDigest,simulation:proof.payloadDigest,canary:artifact.artifactHash}};
    const adapter=new EvmLiquidityExecutionAdapter({rpcUrl:adapterRpc,submissionUrl:adapterRpc,executor:artifact.address,executorCodeHash:artifact.runtimeCodeHash,codePins,admission,confirmations:1,codec:aeroRouteCodec(3),priorityFeePerGas},signer,[{candidate,calldata:payload.data}]);
    if(interfere){
      // Hold our tx in the mempool, land a competing swap first, then mine both: an on-chain revert.
      const submit=adapter.submit.bind(adapter);
      adapter.submit=async(bytes,signal)=>{await client.request({method:'evm_setAutomine',params:[false]});const id=await submit(bytes,signal);await interfere();await client.request({method:'evm_mine',params:[]});await client.request({method:'evm_setAutomine',params:[true]});return id;};
    }
    const store=new SnapshotStore(60000);store.apply({schemaVersion:'3.0',identity:candidate.identity,sourceId:'aero-v2-local',cursor:'1',observedAtMs:Date.now(),complete:true,poolIds:candidate.poolIds,stateDigest:candidate.stateDigest});
    const decisions=await new LiquidityRuntime(store,new AttemptJournal(journalPath),new Map([['aero-v2',adapter]])).run([candidate],{concurrency:1,maxCandidates:1,maxDailyLoss:(10n*E).toString(),minProfit:'1',budgetAssets:{'base:8453':`base:8453:${WETH}`},mode:'auto',stepTimeoutMs:30000});
    // run() reports the simulation and the signing-lane outcome separately; the lane outcome is final.
    const decision=decisions.find(d=>d.status!=='simulated')??decisions[0];
    return {decision,proof,priorityFeePerGas};
  };

  const request=await build();
  const model=await optimizeAeroSplit(request),selected=await optimizeAeroSplit(request,createAeroQuoterHost(client,artifact));
  assert.equal(selected.status,'selected');assert.equal(selected.quoteSource,'evm-quoter');
  assert.equal(selected.terminalReturn,model.terminalReturn,'constant-product model and on-chain quoter agree exactly');
  const beforeLender=await client.readContract({...a,functionName:'balanceOf',args:[lender.address]}),beforeExec=await client.readContract({...a,functionName:'balanceOf',args:[executor.address]});
  await client.request({method:'evm_mine',params:[]});// one block of lag: exercised by maxBlockLag=3
  const success=await send(request,selected);
  assert.equal(success.decision.status,'reconciled',JSON.stringify(success.decision));assert.equal(success.decision.code,'RECEIPT_ACCOUNTED');
  const afterExec=await client.readContract({...a,functionName:'balanceOf',args:[executor.address]});
  assert.equal(await client.readContract({...a,functionName:'balanceOf',args:[lender.address]}),beforeLender,'lender repaid exactly');
  assert.equal(afterExec-beforeExec,BigInt(selected.terminalReturn)-BigInt(selected.principal),'custody equals quoted profit');

  const second=await build(),plan=await optimizeAeroSplit(second,createAeroQuoterHost(client,artifact));assert.equal(plan.status,'selected');
  // A second account outbids our tip so both of its txs mine first in the same block; no receipt wait (automine is off).
  const rival=createWalletClient({account:privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'),chain:defineChain({id:8453,name:'rival',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}}),transport:http(rpc)});
  const tip={maxPriorityFeePerGas:50_000_000_000n,maxFeePerGas:100_000_000_000n,gas:200000n};
  const frontRun=async()=>{await rival.writeContract({...a,functionName:'mint',args:[first.address,500n*E],...tip});await rival.writeContract({...first,functionName:'sync',args:[],nonce:await client.getTransactionCount({address:rival.account.address,blockTag:'pending'}),...tip});};
  const reverted=await send(second,plan,frontRun);
  assert.equal(reverted.decision.status,'reconciled',JSON.stringify(reverted.decision));assert.equal(reverted.decision.code,'REVERT_GAS_ACCOUNTED','revert is accounted as gas loss and visible to the halt policy');
  assert.equal(await client.readContract({...a,functionName:'balanceOf',args:[lender.address]}),beforeLender);
  const evidence={verified:true,scope:'local-e2e-v2',mainnet:false,constructed:true,chainId:8453,artifactHash:artifact.artifactHash,selector:AERO_V2_SELECTOR,
    quoteSource:selected.quoteSource,principal:selected.principal,profit:(afterExec-beforeExec).toString(),priorityFeePerGas:success.priorityFeePerGas.toString(),
    sentThroughSharedRuntime:true,blockLagAdmitted:true,l1FeeSynthetic:true,repaymentProven:true,revertAccounted:true,simulation:success.proof};
  await mkdir('.nim/e2e',{recursive:true});await writeFile('.nim/e2e/aero-v2-local.json',JSON.stringify(evidence,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
  console.log(JSON.stringify({event:'AERO_V2_EDGE_05',quoteSource:evidence.quoteSource,profit:evidence.profit,revertAccounted:true}));
}finally{l1Proxy.close();node.close();}
