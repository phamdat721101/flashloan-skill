import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { keccak256, decodeEventLog } from 'viem';
import { startAeroNode,aeroTestClients } from './aero-e2e-utils.mjs';
import { optimizeAeroSplit } from '../dist/aero/solver.js';
import { buildAeroSplitCalldata,simulateAeroExecution,AERO_EXECUTOR_ABI,AERO_SELECTOR } from '../dist/aero/execution.js';
import { createAeroEvmHost } from '../dist/aero/evm-host.js';
import { estimateEvmFees } from '../dist/evm-fees.js';
import { digest } from '../dist/liquidity/state.js';

const node=await startAeroNode({port:19545});
const {rpc}=node,{client,wallet,account,deploy,write,receipt}=aeroTestClients(rpc);
const transaction=async args=>receipt(await wallet.sendTransaction(args));
try{
  const tokenA=await deploy('TestToken','ImmutableArbitrageExecutor.t'),tokenB=await deploy('TestToken','ImmutableArbitrageExecutor.t');const [a,b]=[tokenA,tokenB].sort((x,y)=>x.address.localeCompare(y.address));
  const firstRoot=await deploy('TestAeroFactory','AeroSplitExecutor.t'),backRoot=await deploy('TestAeroFactory','AeroSplitExecutor.t');await write(backRoot,'setFee',[0n]);
  const first=await deploy('TestAeroPool','AeroSplitExecutor.t',[firstRoot.address,a.address,b.address,false]),back=await deploy('TestAeroPool','AeroSplitExecutor.t',[backRoot.address,a.address,b.address,false]);
  await write(firstRoot,'setPool',[a.address,b.address,false,first.address]);await write(backRoot,'setPool',[a.address,b.address,false,back.address]);
  for(const [pool,x,y]of[[first,1000n,2000n],[back,3000n,1000n]]){await write(a,'mint',[pool.address,x]);await write(b,'mint',[pool.address,y]);await write(pool,'sync');}
  const lender=await deploy('TestMorphoLender','MultiVenueArbitrageExecutor.t'),executor=await deploy('AeroSplitFlashExecutor');await write(a,'mint',[lender.address,100000n]);await write(a,'mint',[executor.address,7n]);
  const hash=async address=>keccak256(await client.getCode({address}));
  await write(executor,'configureLender',[1,lender.address,await hash(lender.address),0n]);
  await write(executor,'configureFactory',[1,firstRoot.address,await hash(firstRoot.address)]);await write(executor,'configureFactory',[5,backRoot.address,await hash(backRoot.address)]);
  for(const pool of[first,back])await write(executor,'configurePool',[pool.address,await hash(pool.address),pool.address,await hash(pool.address)]);
  // Local-only OP fee predeploy stand-in: zero publication charge, actual RPC gas fees.
  await client.request({method:'anvil_setCode',params:['0x420000000000000000000000000000000000000f','0x600060005260206000f3']});
  const block=await client.getBlock(),state=(protocol,x,y)=>protocol==='uniswap-v2'?{protocol,reserve0:x,reserve1:y,feeNumerator:'1',feeDenominator:'1'}:{protocol,reserve0:x,reserve1:y,balance0:x,balance1:y,feeBps:30,stable:false};
  const pools=[{poolId:'out',address:first.address,factory:firstRoot.address,generation:'classic',token0:a.address,token1:b.address,decimals0:18,decimals1:18,implementation:first.address,implementationCodeHash:await hash(first.address),state:state('aero-volatile','1000','2000')},{poolId:'back',address:back.address,factory:backRoot.address,generation:'external-v2',token0:a.address,token1:b.address,decimals0:18,decimals1:18,implementation:back.address,implementationCodeHash:await hash(back.address),state:state('uniswap-v2','3000','1000')}];
  const pins=[];for(const address of[first.address,back.address,firstRoot.address,backRoot.address,lender.address])pins.push({address,codeHash:await hash(address),role:address===lender.address?'lender':[firstRoot.address,backRoot.address].includes(address)?'factory':'pool',sourceRevision:'1'.repeat(40)});
  const request={schemaVersion:'aero-split/1.0',identity:{chainId:8453,blockNumber:block.number.toString(),blockHash:block.hash,timestamp:block.timestamp.toString()},sender:account.address.toLowerCase(),borrowAsset:a.address,pools,pins,branches:[{branchId:'cycle-a',legs:[{poolId:'out',tokenIn:a.address,minOutBps:9900,sqrtPriceLimitX96:'0'},{poolId:'back',tokenIn:b.address,minOutBps:9900,sqrtPriceLimitX96:'0'}]}],lenders:[{lenderId:'morpho-local',kind:'morpho',address:lender.address,codeHash:await hash(lender.address),asset:a.address,available:'100000',feeNumerator:'0',feeDenominator:'1',feeRounding:'zero',termsEvidenceDigest:digest('local lender')}],bounds:{minimum:'20',maximum:'20',quantum:'1',minNetProfit:'1',deadline:(block.timestamp+3600n).toString()},cost:{evidenceDigest:digest('local estimate pending'),nativeAsset:'0x4200000000000000000000000000000000000006',borrowAsset:a.address,nativeCostWei:'0',costInBorrowAsset:'0',conversionNumerator:'1',conversionDenominator:'1000000000000000000',valuationEvidenceDigest:digest('synthetic local units'),maxAgeSeconds:60},limits:{maxEvaluations:32,borrowSamples:2,allocationChunks:2,maxQuoteSteps:4096}};
  const bytes=await readFile('out/AeroSplitFlashExecutor.sol/AeroSplitFlashExecutor.json');const artifact={address:executor.address,runtimeCodeHash:await hash(executor.address),artifactHash:createHash('sha256').update(bytes).digest('hex'),selector:AERO_SELECTOR,chainId:8453};
  let selected=await optimizeAeroSplit(request);assert.equal(selected.status,'selected');let payload=buildAeroSplitCalldata(request,selected,artifact);
  const fees=await estimateEvmFees(client,8453,account.address,payload.to,payload.data);
  request.cost.nativeCostWei=fees.nativeCost.toString();request.cost.costInBorrowAsset=((fees.nativeCost+10n**18n-1n)/10n**18n).toString();request.cost.evidenceDigest=digest({nativeCostWei:fees.nativeCost.toString(),blockHash:block.hash});
  selected=await optimizeAeroSplit(request);assert.equal(selected.status,'selected');payload=buildAeroSplitCalldata(request,selected,artifact);
  const traceHost=createAeroEvmHost(client,rpc,executor.address);const traced=await optimizeAeroSplit(request,traceHost);assert.equal(traced.status,'selected');assert.equal(traced.terminalReturn,selected.terminalReturn);
  const proof=await simulateAeroExecution(client,request,selected,artifact,{syntheticLocalRpc:rpc});
  const cancelled=new AbortController();let owners=0;const wrapped={...client,readContract:async args=>{const result=await client.readContract(args);if(args.functionName==='owner'&&++owners===2)cancelled.abort();return result;}};
  await assert.rejects(simulateAeroExecution(wrapped,request,selected,artifact,{signal:cancelled.signal,syntheticLocalRpc:rpc}));
  const beforeLender=await client.readContract({...a,functionName:'balanceOf',args:[lender.address]});
  const receipt=await transaction({to:payload.to,data:payload.data});
  const events=receipt.logs.flatMap(l=>{try{return[decodeEventLog({abi:AERO_EXECUTOR_ABI,...l})];}catch{return[];}});
  const event=events.find(e=>e.eventName==='AeroArbitrageExecuted');assert.ok(event);assert.equal(event.args.fee,0n);assert.equal(event.args.profit,BigInt(selected.terminalReturn)-BigInt(selected.principal));
  assert.equal(await client.readContract({...a,functionName:'balanceOf',args:[lender.address]}),beforeLender);
  assert.equal(await client.readContract({...a,functionName:'balanceOf',args:[executor.address]}),7n+event.args.profit);
  const forged=structuredClone(selected);forged.allocations[0].legs[0].amountOut='999999';assert.throws(()=>buildAeroSplitCalldata(request,forged,artifact));
  const evidence={verified:true,scope:'local-e2e',mainnet:false,constructed:true,chainId:8453,blockHash:block.hash,artifactHash:artifact.artifactHash,selector:AERO_SELECTOR,requestDigest:digest(request),simulation:proof,receipt:{hash:receipt.transactionHash,blockHash:receipt.blockHash,profitAfterDebt:event.args.profit.toString()},openingBalancePreserved:true,repaymentProven:true,finalAwaitCancellationProven:true,orderedEvmHostProven:true};
  await mkdir('.nim/e2e',{recursive:true});await writeFile('.nim/e2e/aero-local.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({event:'AERO_IMPL_EDGE_05',...evidence}));
}finally{node.close();}
