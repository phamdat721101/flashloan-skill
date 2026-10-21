import { createPublicClient, http, parseAbiItem, parseAbi, keccak256, encodeAbiParameters, type Address } from 'viem';
import { evmProfile, PROFIT_ASSETS } from '../evm-chains.js';
import type { DeploymentManifest } from './deployment.js';
import { secureEndpoint } from './deployment.js';
import type { AnalyticsPoolConfig } from '../liquidity/sources.js';

/** Inclusive tick horizon: the upper edge must stay inside the last fetched word. */
export function discoveryTickWindow(tick:number, tickSpacing:number, radius = 3) {
  if(!Number.isInteger(tick) || tick < -887272 || tick > 887272 || !Number.isInteger(tickSpacing) || tickSpacing<1 || tickSpacing>32767 || !Number.isInteger(radius) || radius < 1 || radius > 16)throw new Error('INVALID_DISCOVERY_TICK');
  const word=Math.floor(Math.floor(tick/tickSpacing)/256);
  return {bitmapWordPositions:Array.from({length:radius*2+1},(_,index)=>word-radius+index),lowerTick:Math.max(-887272,(word-radius)*256*tickSpacing),upperTick:Math.min(887272,(word+radius+1)*256*tickSpacing-1)};
}

/** A connected discovery can add one intermediary asset; default discovery remains settlement-only. */
export function isProfitAssetPool(token0:string,token1:string,assets:readonly string[],connected:boolean) {
  const matches=[token0,token1].map(token=>assets.includes(token.toLowerCase()));
  return connected ? matches.some(Boolean) : matches.every(Boolean);
}

/** Bounded, wallet-free V4 discovery. Coverage describes a block range, never the whole market. */
export async function discoverEvmPools(manifest: DeploymentManifest, from: bigint, to: bigint, probeStandardKeys = false, connectedToProfitAssets = false) {
  if(from<0n || to<from || to-from>256000n)throw new Error('DISCOVERY_RANGE_LIMIT');
  const profile=evmProfile(manifest.chainId), root=manifest.roots.find(r=>r.role==='v4-manager');
  if(!root)throw new Error('V4_ROOT_REQUIRED');
  const client=createPublicClient({transport:http(secureEndpoint(process.env[profile.rpcEnv]??profile.chain.rpcUrls.default.http[0]),{retryCount:0,timeout:20000})});
  if(await client.getChainId()!==manifest.chainId)throw new Error('SOURCE_CHAIN_MISMATCH');
  const head=await client.getBlock({blockNumber:to});
  const code=await client.getCode({address:root.address,blockNumber:to});
  if(!code || keccak256(code)!==root.codeHash)throw new Error('ROOT_CODE_CHANGED');
  const event=parseAbiItem('event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)');
  const assets=PROFIT_ASSETS[manifest.chainId]??[], discovered=new Map<string,{ config: AnalyticsPoolConfig; liquidity: bigint }>();
  const stateAbi=parseAbi(['function extsload(bytes32) view returns(bytes32)']), stateMask=(1n<<160n)-1n, liquidityMask=(1n<<128n)-1n;
  const slotFor=(id:`0x${string}`,offset=0n)=>`0x${(BigInt(keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'}],[id,6n])))+offset).toString(16).padStart(64,'0')}` as `0x${string}`;
  const capture=async(id:`0x${string}`,key:{currency0:Address;currency1:Address;fee:number;tickSpacing:number;hooks:Address})=>{
    if(discovered.has(id))return;
    const slot=slotFor(id),[packed,liquidityWord]=await Promise.all([0n,3n].map(async offset=>BigInt(await client.readContract({address:root.address,abi:stateAbi,functionName:'extsload',args:[offset===0n?slot:slotFor(id,offset)],blockNumber:to}))));
    if(!(packed&stateMask))return;
    let tick=Number((packed>>160n)&0xffffffn);if(tick>=0x800000)tick-=0x1000000;
    discovered.set(id,{config:{protocol:'uniswap-v4',address:root.address,expectedCodeHash:root.codeHash,adapterRevision:`v4:${root.codeHash}`,key,...discoveryTickWindow(tick,key.tickSpacing)},liquidity:liquidityWord&liquidityMask});
  };
  let examined=0;
  if(probeStandardKeys) {
    // Explicit finite key coverage. This makes no market-wide discovery claim.
    for(let i=0;i<assets.length;i++)for(let j=i+1;j<assets.length;j++)for(const [fee,tickSpacing] of [[100,1],[500,10],[3000,60],[10000,200]]) {
      const [currency0,currency1]=[assets[i],assets[j]].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
      const key={currency0,currency1,fee,tickSpacing,hooks:'0x0000000000000000000000000000000000000000' as const};
      const id=keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],[currency0,currency1,fee,tickSpacing,key.hooks]));
      await capture(id,key);
    }
  }

  // Public RPCs commonly cap dense log responses; small fixed pages keep coverage explicit.
  for(let start=from;(!probeStandardKeys || connectedToProfitAssets) && start<=to;start+=250n) {
    const end=start+249n<to?start+249n:to;
    let logs;
    try { logs=await client.getLogs({address:root.address,event,fromBlock:start,toBlock:end,strict:true}); }
    catch { throw new Error('DISCOVERY_LOG_QUERY_FAILED'); }
    examined+=logs.length;
    for(const log of logs) {
      const a=log.args;
      if(a.hooks!=='0x0000000000000000000000000000000000000000' || (a.fee&0x800000) || !isProfitAssetPool(a.currency0,a.currency1,assets,connectedToProfitAssets))continue;
      await capture(a.id,{currency0:a.currency0,currency1:a.currency1,fee:a.fee,tickSpacing:a.tickSpacing,hooks:a.hooks});
    }
  }
  if((await client.getBlock({blockNumber:to})).hash!==head.hash)throw new Error('BLOCK_REORG');
  const ranked=[...discovered.entries()].sort(([left,a],[right,b])=>b.liquidity>a.liquidity?-1:b.liquidity<a.liquidity?1:left.localeCompare(right));
  const coverage=probeStandardKeys&&connectedToProfitAssets?'standard-keys-plus-range-connected-to-profit-assets':probeStandardKeys?'four-standard-erc20-keys-only':connectedToProfitAssets?'declared-range-connected-to-profit-assets':'declared-range-only';
  return {schemaVersion:'1.0',chainId:manifest.chainId,fromBlock:from.toString(),toBlock:to.toString(),blockHash:head.hash,examinedInitializeEvents:examined,coverage,pools:ranked.slice(0,6).map(entry=>entry[1].config),omittedPools:Math.max(0,ranked.length-6)};
}
