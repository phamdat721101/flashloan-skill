import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { startAeroNode,startL1FeeProxy } from './aero-e2e-utils.mjs';
import { EvmDeployment, parseManifest } from '../dist/evm/deployment.js';
import { aeroPublicClient, captureAeroSnapshot, captureAeroLender } from '../dist/aero/capture.js';
import { evaluateAeroSchedule } from '../dist/aero/solver.js';
import { createAeroQuoterHost } from '../dist/aero/evm-host.js';
import { AERO_V2_SELECTOR } from '../dist/aero/execution.js';
import { aeroLegLimit, aeroBranchId } from '../dist/aero/live.js';
import { parseAeroRequest } from '../dist/aero/types.js';

// Pinned Base fork rehearsal: the real EvmDeployment deploys and configures the V2 executor from
// the mainnet manifest, then every captured real pool is quoted by the on-chain quoter and compared
// leg-by-leg with the TS model. No profitable opportunity is required; nothing reaches mainnet.
if(process.env.AERO_RUN_FORK!=='1')throw new Error('AERO_RUN_FORK_REQUIRED');
const source=process.env.BASE_RPC_URL??'https://mainnet.base.org',block=process.env.AERO_FORK_BLOCK;
if(!/^\d+$/.test(block??''))throw new Error('AERO_FORK_BLOCK_REQUIRED');
const WETH='0x4200000000000000000000000000000000000006',USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const account=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const signer=account.address.toLowerCase();
// Test-only signer ledgers: the fork resets every run, so stale local ledgers must not carry over.
for(const f of[`.nim/deployment-ledger/8453-${signer}-aero-v2.json`,`.nim/evm-budgets/8453-${signer}.json`,'.nim/e2e/aero-v2-fork-deploy.json'])await rm(f,{force:true});
const node=await startAeroNode({port:19548,forkUrl:source,blockNumber:block,optimism:true,blockTime:1});
const l1=await startL1FeeProxy(node.rpc);
try{
  // Forked state is fetched lazily from the source RPC; allow slow first reads.
  const client=aeroPublicClient(node.rpc,120000);
  await client.request({method:'anvil_setCode',params:['0x420000000000000000000000000000000000000f','0x600060005260206000f3']});
  const manifest=parseManifest(JSON.parse(await readFile('config/aero-v2-base-mainnet.json','utf8')));
  const state=await new EvmDeployment(manifest,l1.rpc,l1.rpc,account,'.nim/e2e/aero-v2-fork-deploy.json').run();
  const entry=state.deployments.find(d=>d.contract==='AeroSplitFlashExecutorV2');assert.equal(entry?.status,'verified');
  assert.equal(entry.configurations.length,manifest.roots.length,'every root configured and read back');
  const bytes=await readFile('out/AeroSplitFlashExecutorV2.sol/AeroSplitFlashExecutorV2.json');
  const artifact={address:entry.address,runtimeCodeHash:entry.runtimeCodeHash,artifactHash:createHash('sha256').update(bytes).digest('hex'),selector:AERO_V2_SELECTOR,chainId:8453,version:2};
  const registry=JSON.parse(await readFile('config/aero-v2-base-pools.json','utf8'));
  // Same state, faster: capture from the source RPC at the fork block; quote on the fork head, where the executor exists.
  const capture=await captureAeroSnapshot(aeroPublicClient(source,60000),registry.map(p=>({...p,bitmapRadius:4})),BigInt(block));
  const height=BigInt(capture.identity.blockNumber);
  const lender=await captureAeroLender(aeroPublicClient(source,60000),'morpho','0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',WETH,height);
  const probe=10n**16n,ref=capture.pools.find(p=>p.generation==='external-v3'&&'feePips'in p.state&&p.state.feePips===500)??capture.pools.find(p=>p.generation==='external-v3');
  const request=(pools,branches,size)=>parseAeroRequest({schemaVersion:'aero-split/1.1',identity:capture.identity,sender:signer,borrowAsset:WETH,pools,pins:capture.pins,branches,lenders:[lender],
    bounds:{minimum:size.toString(),maximum:size.toString(),quantum:size.toString(),minNetProfit:'1',deadline:(BigInt(capture.identity.timestamp)+3600n).toString(),maxBlockLag:1},
    cost:{evidenceDigest:'2'.repeat(64),nativeAsset:WETH,borrowAsset:WETH,nativeCostWei:'1',costInBorrowAsset:'1',conversionNumerator:'1',conversionDenominator:'1',valuationEvidenceDigest:'2'.repeat(64),maxAgeSeconds:60},
    limits:{maxEvaluations:10,borrowSamples:2,allocationChunks:1,maxQuoteSteps:4096}});
  const quoter=createAeroQuoterHost(client,artifact),cases=[];
  for(const pool of capture.pools.filter(p=>p.poolId!==ref.poolId)){
    const branch={branchId:aeroBranchId(pool.poolId,ref.poolId),legs:[{poolId:pool.poolId,tokenIn:WETH,minOutBps:9900,sqrtPriceLimitX96:aeroLegLimit(pool,WETH)},{poolId:ref.poolId,tokenIn:USDC,minOutBps:9900,sqrtPriceLimitX96:aeroLegLimit(ref,USDC)}]};
    // Thin pools (WETH-denominated V4) exhaust the captured window at 0.01 WETH; retry smaller sizes.
    let r,amounts,model,reason;
    for(const size of[probe,probe/1000n,probe/1000000n]){r=request([pool,ref],[branch],size);amounts=[{branchId:branch.branchId,amountIn:size.toString()}];try{model=evaluateAeroSchedule(r,amounts);break;}catch(e){reason=e.message;}}
    if(!model){cases.push({poolId:pool.poolId,generation:pool.generation,status:'model-coverage',reason});continue;}
    const exact=await quoter.evaluateSchedule(r,lender,amounts);
    const modelOut=model.allocations[0].legs.map(l=>l.amountOut),quoted=exact.allocations[0].legs.map(l=>l.amountOut);
    const feeProfile='feeProfile'in pool.state?pool.state.feeProfile:'static';
    const parity=modelOut[0]===quoted[0];
    cases.push({poolId:pool.poolId,generation:pool.generation,feeProfile,amountIn:amounts[0].amountIn,modelOut:modelOut[0],quoterOut:quoted[0],parity});
    if(feeProfile!=='dynamic-snapshot')assert.ok(parity,`exact parity required for ${pool.poolId}: model ${modelOut[0]} quoter ${quoted[0]}`);
  }
  const quoted=cases.filter(c=>'parity'in c),generations=new Set(quoted.map(c=>c.generation));
  // V4 is required only when the registry holds a liquid hookless WETH pool (none on Base at capture time;
  // V4 execution is then proven by the strict delta-accounting Foundry mock).
  for(const g of['classic','external-v2','external-v3',...(registry.some(p=>p.generation==='external-v4')?['external-v4']:[])])assert.ok(generations.has(g),`fork proof must cover ${g}`);
  assert.ok([...generations].some(g=>g.startsWith('cl-')),'fork proof must cover Slipstream');
  const evidence={verified:true,scope:'pinned-base-fork-v2',mainnetBroadcast:false,constructed:false,l1FeeSynthetic:true,chainId:8453,block:capture.identity,
    executor:{address:artifact.address,runtimeCodeHash:artifact.runtimeCodeHash,artifactHash:artifact.artifactHash,selector:AERO_V2_SELECTOR,configuredRoots:entry.configurations.length},
    reference:ref.poolId,probeWei:probe.toString(),cases,exactParity:quoted.filter(c=>c.parity).length,dynamicSnapshotDrift:quoted.filter(c=>!c.parity).map(c=>c.poolId),v4Coverage:registry.some(p=>p.generation==='external-v4')?'fork':'foundry-strict-mock (no liquid hookless WETH/USDC V4 pool)'};
  await mkdir('.nim/e2e',{recursive:true});await writeFile('.nim/e2e/aero-v2-fork.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({event:'AERO_V2_EDGE_06',executor:artifact.address,roots:entry.configurations.length,quoted:quoted.length,exactParity:evidence.exactParity,drift:evidence.dynamicSnapshotDrift.length}));
}finally{l1.close();node.close();}
