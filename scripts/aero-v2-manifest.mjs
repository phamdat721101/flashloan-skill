import { writeFile, readFile } from 'node:fs/promises';
import { keccak256 } from 'viem';
import { aeroPublicClient, captureAeroSnapshot, discoverAeroPools, AERO_FACTORIES, UNISWAP_BASE } from '../dist/aero/capture.js';

// Read-only: discovers WETH/USDC venues on Base, keeps pools that capture coherently at one
// block, and writes the V2 executor deployment manifest, capture registry and live config.
const WETH='0x4200000000000000000000000000000000000006',USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const MORPHO='0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',BALANCER='0xba12222222228d8ba445958a75a0704d566bf2c8';
const client=aeroPublicClient(process.env.BASE_RPC_URL??'https://mainnet.base.org');
const block=await client.getBlockNumber();
const hash=async address=>{const code=await client.getCode({address,blockNumber:block});if(!code||code==='0x')throw new Error(`NO_CODE:${address}`);return keccak256(code);};
const candidates=await discoverAeroPools(client,[[WETH,USDC]],block,{uniswap:true});
const kept=[],captured=[];
for(const pool of candidates){
  try{
    const snap=await captureAeroSnapshot(client,[pool],block),s=snap.pools[0].state;
    // Initialized-but-empty CL pools cannot fill any leg; never pin them as trusted routes.
    if('liquidity'in s&&s.liquidity==='0'&&!s.initializedTicks.length)throw new Error('EMPTY_POOL');
    kept.push(pool);captured.push(snap.pools[0]);
  }
  catch(e){console.error(JSON.stringify({skipped:pool.poolId,reason:e.message.slice(0,60)}));}
}
const generation={classic:1,'cl-initial':2,'cl-gauge-caps':3,'cl-gauges-v3':4};
const roots=[
  {role:'morpho',address:MORPHO,codeHash:await hash(MORPHO),source:'https://docs.morpho.org/get-started/resources/addresses'},
  {role:'balancer-v2',address:BALANCER,codeHash:await hash(BALANCER),source:'https://docs.balancer.fi/reference/contracts/deployment-addresses/base.html',maxFee:'0'},
  {role:'v4-manager',address:UNISWAP_BASE.v4,codeHash:await hash(UNISWAP_BASE.v4),source:'https://docs.uniswap.org/contracts/v4/deployments'},
  ...await Promise.all(Object.entries(AERO_FACTORIES).map(async([g,address])=>({role:'aero-factory',address,codeHash:await hash(address),source:'https://github.com/aerodrome-finance/slipstream',generation:generation[g]}))),
  {role:'aero-factory',address:UNISWAP_BASE.v2,codeHash:await hash(UNISWAP_BASE.v2),source:'https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments',generation:5},
  {role:'aero-factory',address:UNISWAP_BASE.v3,codeHash:await hash(UNISWAP_BASE.v3),source:'https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments',generation:6},
  {role:'aero-factory',address:UNISWAP_BASE.v4,codeHash:await hash(UNISWAP_BASE.v4),source:'https://docs.uniswap.org/contracts/v4/deployments',generation:7},
  {role:'v2-fee',address:UNISWAP_BASE.v2,codeHash:await hash(UNISWAP_BASE.v2),source:'https://docs.uniswap.org/contracts/v2/concepts/advanced-topics/fees',feePips:3000},
];
for(const p of captured){
  if(p.generation==='external-v4')roots.push({role:'v4-pool',address:p.address,codeHash:await hash(p.address),source:'https://docs.uniswap.org/contracts/v4/deployments',poolId:p.state.poolKeyId});
  else roots.push({role:'aero-pool',address:p.address,codeHash:await hash(p.address),source:'https://basescan.org/address/'+p.address,implementation:p.implementation,implementationCodeHash:p.implementationCodeHash});
}
const manifest={schemaVersion:'1.0',chainId:8453,roots,contracts:['AeroSplitFlashExecutorV2'],exclusions:[]};
await writeFile('config/aero-v2-base-mainnet.json',JSON.stringify(manifest,null,2)+'\n');
await writeFile('config/aero-v2-base-pools.json',JSON.stringify(kept,null,2)+'\n');
let live;try{live=JSON.parse(await readFile('config/aero-v2-live.json','utf8'));}catch{live=undefined;}
if(!live)await writeFile('config/aero-v2-live.json',JSON.stringify({schemaVersion:'aero-live-config/1.0',registryPath:'config/aero-v2-base-pools.json',artifactPath:'config/aero-base-executor-v2.json',manifestPath:'config/aero-v2-base-mainnet.json',
  lenders:[{kind:'morpho',address:MORPHO},{kind:'uniswap-v4',address:UNISWAP_BASE.v4}],
  bounds:{minimum:'10000000000000000',maximum:'20000000000000000000',quantum:'10000000000000000',minNetProfit:'20000000000000',deadlineSeconds:12,maxBlockLag:2},
  limits:{maxEvaluations:400,borrowSamples:8,allocationChunks:4,maxQuoteSteps:2048,quoteTopK:3,refine:true},bid:{bidShareBps:1000,maxPriorityFeePerGas:'5000000'},minOutBps:9950,maxRounds:30,pollIntervalMs:2000},null,2)+'\n');
console.log(JSON.stringify({block:block.toString(),discovered:candidates.length,kept:kept.map(p=>p.poolId),roots:roots.length}));
