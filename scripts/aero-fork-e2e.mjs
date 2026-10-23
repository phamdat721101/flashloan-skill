import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseAbi,keccak256,decodeEventLog } from 'viem';
import { startAeroNode,aeroTestClients } from './aero-e2e-utils.mjs';
import { aeroPublicClient,captureAeroSnapshot,captureAeroLender,readAero } from '../dist/aero/capture.js';
import { quoteAeroExactInput } from '../dist/aero/math.js';
import { sqrtRatioAtTick } from '../dist/liquidity/clmm.js';
import { optimizeAeroSplit } from '../dist/aero/solver.js';
import { createAeroEvmHost } from '../dist/aero/evm-host.js';
import { AERO_EXECUTOR_ABI,AERO_SELECTOR,buildAeroSplitCalldata,simulateAeroExecution } from '../dist/aero/execution.js';
import { estimateEvmFees } from '../dist/evm-fees.js';
import { digest } from '../dist/liquidity/state.js';

if(process.env.AERO_RUN_FORK!=='1')throw new Error('AERO_FORK_OPT_IN_REQUIRED');
const blockNumber=process.env.AERO_FORK_BLOCK,blockHash=process.env.AERO_FORK_BLOCK_HASH;
if(!blockNumber||!/^\d+$/.test(blockNumber)||!/^0x[0-9a-f]{64}$/.test(blockHash??''))throw new Error('EXPLICIT_FORK_BLOCK_AND_HASH_REQUIRED');
const source=process.env.BASE_RPC_URL??'https://mainnet.base.org',remote=aeroPublicClient(source);
assert.equal(await remote.getChainId(),8453);assert.equal((await remote.getBlock({blockNumber:BigInt(blockNumber)})).hash,blockHash);
const registry=JSON.parse(await readFile(process.env.AERO_REGISTRY_FILE??'config/aero-base-pools.json','utf8'));
assert.equal(registry.length,5);
const WETH='0x4200000000000000000000000000000000000006',USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',MORPHO='0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
const tokenAbi=parseAbi(['function deposit() payable','function transfer(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)']);
const poolAbi=parseAbi(['function getAmountOut(uint256,address) view returns(uint256)','function swap(uint256,uint256,address,bytes)']);
let node;
try{
 node=await startAeroNode({forkUrl:source,blockNumber});const {client,wallet,account,deploy,write,receipt}=aeroTestClients(node.rpc);
 assert.equal((await client.getBlock({blockNumber:BigInt(blockNumber)})).hash,blockHash);
 await write({address:WETH,abi:tokenAbi},'deposit',[],{value:10n**19n});
 // Construct only the counter-venue. Funding uses a real Aero swap on the fork,
 // without storage injection into production pools or token contracts.
 const funding=registry.find(p=>p.generation==='classic'&&p.address==='0xcdac0d6c6c59727a65f871236188350531885c43');
 const fundAmount=10n**17n,fundQuote=await client.readContract({address:funding.address,abi:poolAbi,functionName:'getAmountOut',args:[fundAmount,WETH]});
 await write({address:WETH,abi:tokenAbi},'transfer',[funding.address,fundAmount]);await write({address:funding.address,abi:poolAbi},'swap',[0n,fundQuote,account.address,'0x']);
 const startingSnapshot=await client.request({method:'evm_snapshot'}),cases=[];let snapshot=startingSnapshot;
 for(const config of registry){
  console.log(JSON.stringify({stage:'capture',generation:config.generation,pool:config.address}));
  const root=await deploy('TestAeroFactory','AeroSplitExecutor.t');await write(root,'setFee',[0n]);
  const counter=await deploy('TestAeroPool','AeroSplitExecutor.t',[root.address,WETH,USDC,false]);await write(root,'setPool',[WETH,USDC,false,counter.address]);
  await write({address:WETH,abi:tokenAbi},'transfer',[counter.address,5n*10n**18n]);await write({address:USDC,abi:tokenAbi},'transfer',[counter.address,1000000n]);await write(counter,'sync');
  const executor=await deploy('AeroSplitFlashExecutor'),hash=async address=>keccak256(await client.getCode({address}));
  await write(executor,'configureFactory',[config.generation==='classic'?1:config.generation==='cl-initial'?2:config.generation==='cl-gauge-caps'?3:4,config.factory,await hash(config.factory)]);
  await write(executor,'configureFactory',[5,root.address,await hash(root.address)]);
  let captured=await captureAeroSnapshot(client,[config]),pool=captured.pools[0];
  assert.equal(pool.token0,WETH);assert.equal(pool.token1,USDC);
  for(const p of[pool,{address:counter.address,implementation:counter.address,implementationCodeHash:await hash(counter.address)}])await write(executor,'configurePool',[p.address,await hash(p.address),p.implementation,p.implementationCodeHash]);
  const morphoHash=await hash(MORPHO);await write(executor,'configureLender',[1,MORPHO,morphoHash,0n]);
  captured=await captureAeroSnapshot(client,[config]);pool=captured.pools[0];
  const parity=[];
  if(config.generation!=='classic') {
    const probe=await deploy('AeroQuoteProbe','AeroSplitExecutor.t');await write({address:USDC,abi:tokenAbi},'transfer',[probe.address,10000n]);
    captured=await captureAeroSnapshot(client,[config]);pool=captured.pools[0];
    const mathPool=structuredClone(pool);mathPool.state.feeProfile='fixed-proven';
    const limit=(sqrtRatioAtTick(pool.state.upperTick)-(pool.state.upperTick===887272?1n:0n)).toString();
    const expected=quoteAeroExactInput(mathPool,{poolId:pool.poolId,tokenIn:USDC,minOutBps:9900,sqrtPriceLimitX96:limit},'10000');
    const actual=(await client.simulateContract({...probe,functionName:'quote',args:[pool.address,false,10000n,BigInt(limit)],account:account.address,blockNumber:BigInt(captured.identity.blockNumber)})).result;
    assert.equal(actual[0].toString(),expected.quote.amountOut);assert.equal(actual[1].toString(),expected.projectedState.state.sqrtPriceX96);assert.equal(actual[2],expected.projectedState.state.tick);assert.equal(actual[3].toString(),expected.projectedState.state.liquidity);
    parity.push({asset:USDC,amount:'10000',amountOut:actual[0].toString(),source:'deployed-swap-eth-call',direction:'one-for-zero',stateParity:true});
  }
  const lender=await captureAeroLender(client,'morpho',MORPHO,WETH,BigInt(captured.identity.blockNumber));assert.ok(BigInt(lender.available)>=10n**14n);
  if(config.generation==='classic')for(const [asset,amount]of[[WETH,10n**14n],[USDC,1000000n]]){
    const leg={poolId:pool.poolId,tokenIn:asset,minOutBps:9900,sqrtPriceLimitX96:'0'},quote=quoteAeroExactInput(pool,leg,amount.toString());
    const exact=await client.readContract({address:pool.address,abi:poolAbi,functionName:'getAmountOut',args:[amount,asset],blockNumber:BigInt(captured.identity.blockNumber)});
    assert.equal(quote.quote.amountOut,exact.toString());parity.push({asset,amount:amount.toString(),amountOut:exact.toString(),source:'deployed-getAmountOut'});
  }
  const counterState={poolId:'constructed-counter',address:counter.address,factory:root.address,generation:'external-v2',token0:WETH,token1:USDC,decimals0:18,decimals1:6,implementation:counter.address,implementationCodeHash:await hash(counter.address),state:{protocol:'uniswap-v2',reserve0:'5000000000000000000',reserve1:'1000000',feeNumerator:'1',feeDenominator:'1'}};
  const pin=(address,codeHash,role)=>({address,codeHash,role,sourceRevision:'1'.repeat(40)});
  const request={schemaVersion:'aero-split/1.0',identity:captured.identity,sender:account.address.toLowerCase(),borrowAsset:WETH,pools:[pool,counterState],pins:[...captured.pins,pin(counter.address,await hash(counter.address),'pool'),pin(root.address,await hash(root.address),'factory'),pin(MORPHO,morphoHash,'lender')],branches:[{branchId:'fork-cycle',legs:[{poolId:pool.poolId,tokenIn:WETH,minOutBps:9900,sqrtPriceLimitX96:config.generation==='classic'?'0':(sqrtRatioAtTick(pool.state.lowerTick)+(pool.state.lowerTick===-887272?1n:0n)).toString()},{poolId:counterState.poolId,tokenIn:USDC,minOutBps:9900,sqrtPriceLimitX96:'0'}]}],lenders:[lender],bounds:{minimum:'100000000000000',maximum:'100000000000000',quantum:'100000000000000',minNetProfit:'1000000000000',deadline:(BigInt(captured.identity.timestamp)+3600n).toString()},cost:{evidenceDigest:digest('fork cost pending'),nativeAsset:WETH,borrowAsset:WETH,nativeCostWei:'0',costInBorrowAsset:'0',conversionNumerator:'1',conversionDenominator:'1',valuationEvidenceDigest:digest('WETH is wrapped native ETH'),maxAgeSeconds:60},limits:{maxEvaluations:1,borrowSamples:2,allocationChunks:1,maxQuoteSteps:4096}};
  const artifactBytes=await readFile('out/AeroSplitFlashExecutor.sol/AeroSplitFlashExecutor.json'),artifact={address:executor.address,runtimeCodeHash:await hash(executor.address),artifactHash:createHash('sha256').update(artifactBytes).digest('hex'),selector:AERO_SELECTOR,chainId:8453};
  const host=createAeroEvmHost(client,node.rpc,executor.address);const evaluate=host.evaluateSchedule;host.evaluateSchedule=async(...args)=>{try{return await evaluate(...args);}catch(error){console.error(JSON.stringify({generation:config.generation,quoteError:/^[A-Z_]+$/.test(error.message??'')?error.message:'RPC_ERROR'}));throw error;}};let selected=await optimizeAeroSplit(request,host);assert.equal(selected.status,'selected',`${config.generation}: ${selected.reason}`);
  let payload=buildAeroSplitCalldata(request,selected,artifact),fees=await estimateEvmFees(client,8453,account.address,payload.to,payload.data);
  const costBudget=(fees.nativeCost*11000n+9999n)/10000n;request.cost.nativeCostWei=costBudget.toString();request.cost.costInBorrowAsset=costBudget.toString();request.cost.evidenceDigest=digest({blockHash:captured.identity.blockHash,gas:fees.gas.toString(),nativeCost:fees.nativeCost.toString()});
  selected=await optimizeAeroSplit(request,host);assert.equal(selected.status,'selected');payload=buildAeroSplitCalldata(request,selected,artifact);
  const simulation=await simulateAeroExecution(client,request,selected,artifact);
  const balance=async address=>client.readContract({address:WETH,abi:tokenAbi,functionName:'balanceOf',args:[address]}),beforeLender=await balance(MORPHO),beforeExecutor=await balance(executor.address);
  const tx=await receipt(await wallet.sendTransaction({to:payload.to,data:payload.data}));
  const proof=tx.logs.flatMap(l=>{try{const e=decodeEventLog({abi:AERO_EXECUTOR_ABI,...l});return e.eventName==='AeroArbitrageExecuted'?[e.args]:[];}catch{return[];}})[0];
  assert.ok(proof);assert.equal(await balance(MORPHO),beforeLender);assert.equal(await balance(executor.address),beforeExecutor+proof.profit);assert.ok(proof.profit>=BigInt(selected.minProfit));
  cases.push({generation:config.generation,protocol:pool.state.protocol,pool:pool.address,factory:pool.factory,implementation:pool.implementation,implementationCodeHash:pool.implementationCodeHash,feeProfile:pool.state.feeProfile??'classic',pins:captured.pins,parity,simulation,receipt:{transactionHash:tx.transactionHash,blockHash:tx.blockHash,profitAfterDebt:proof.profit.toString()},repaymentProven:true,custodyProven:true,constructed:true});
  console.log(JSON.stringify({stage:'passed',generation:config.generation,protocol:pool.state.protocol,repaymentProven:true,profitAfterDebt:proof.profit.toString()}));
  assert.equal(await client.request({method:'evm_revert',params:[snapshot]}),true);snapshot=await client.request({method:'evm_snapshot'});
 }
 const report={verified:true,scope:'pinned-base-fork',chainId:8453,origin:{blockNumber,blockHash},constructed:true,mainnetBroadcast:false,artifactHash:cases[0].simulation.artifactHash,selector:AERO_SELECTOR,cases};
 assert.equal(new Set(cases.map(c=>c.protocol)).size,3);assert.equal(new Set(cases.filter(c=>c.generation.startsWith('cl-')).map(c=>c.generation)).size,3);
 await mkdir('.nim/e2e',{recursive:true});await writeFile('.nim/e2e/aero-fork.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({event:'AERO_IMPL_EDGE_05',verified:true,cases:cases.length,origin:report.origin,mainnetBroadcast:false}));
}catch(error){console.error(JSON.stringify({status:'failed',code:error instanceof assert.AssertionError?error.message:/^[A-Z_]+$/.test(error.message??'')?error.message:'AERO_FORK_PROOF_FAILED',mainnetBroadcast:false}));process.exitCode=1;}finally{node?.close();}
