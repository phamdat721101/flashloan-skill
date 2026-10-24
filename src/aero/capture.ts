import { createPublicClient, http, parseAbi, keccak256, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { snapshotUniswapV4, type StateClient } from '../state-adapters.js';
import { digest } from '../liquidity/state.js';
import { secureEndpoint } from '../evm/deployment.js';
import type { AeroPool, AeroLender, AeroRequest, Generation } from './types.js';

/** external-v2 requires v2FeePips (the factory's fixed input fee). external-v4 uses address=factory=PoolManager
 * and requires tokens + v4Key (hookless, static fee); the PoolKey id identifies the pool. */
export interface CapturePool {poolId:string;address:Address;factory:Address;generation:Generation;sourceRevision:string;bitmapRadius?:number;expectedFactoryCodeHash?:Hex;expectedImplementationCodeHash?:Hex;v2FeePips?:number;tokens?:readonly [Address,Address];v4Key?:{fee:number;tickSpacing:number}}
export interface CaptureResult {identity:AeroRequest['identity'];pools:AeroPool[];pins:AeroRequest['pins']}
export const UNISWAP_BASE={v2:'0x8909dc15e40173ff4699343b6eb8132c65e18ec6',v3:'0x33128a8fc17869897dce68ed026d694621f6fdfd',v4:'0x498581ff718922c3f8e6a244956af099b2652b2b'} as const;
export const V3_FEE_TIERS=[100,500,3000,10000] as const;
export const V4_STANDARD_KEYS=[{fee:100,tickSpacing:1},{fee:500,tickSpacing:10},{fee:3000,tickSpacing:60},{fee:10000,tickSpacing:200}] as const;
export const AERO_FACTORIES:Record<string,Address>={classic:'0x420dd381b31aef6683db6b902084cb0ffece40da','cl-initial':'0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a','cl-gauge-caps':'0xade65c38cd4849adba595a4323a8c7ddfe89716a','cl-gauges-v3':'0xf8f2eb4940cfe7d13603dddd87f123820fc061ef'};
const CLASSIC_REVISION='1ba30815bba620f7e9faa34769ffd00c214c9b82',CL_REVISION='f8717faaae6e6717db3c8e3850149c01a79c0603';
// viem aggregates concurrent eth_calls at the same block into Multicall3 (G2).
export const aeroPublicClient=(rpc:string,timeoutMs=20000):PublicClient=>createPublicClient({chain:base,batch:{multicall:{wait:8}},transport:http(secureEndpoint(rpc),{timeout:timeoutMs,retryCount:0})}) as PublicClient;
/** Pin a state adapter's head to the capture block so V4 reads share the snapshot identity. */
function pinnedStateClient(client:PublicClient,block:{number:bigint;hash:Hex;timestamp:bigint}):StateClient {
  return {getChainId:()=>client.getChainId(),getBlock:async args=>args?.blockNumber===undefined?block:client.getBlock({blockNumber:args.blockNumber}),
    getCode:args=>client.getCode(args),readContract:args=>client.readContract(args as Parameters<PublicClient['readContract']>[0])};
}
export async function readAero<T>(client:PublicClient,address:Address,signature:string,args:readonly unknown[],blockNumber:bigint):Promise<T> {
  return await client.readContract({address,abi:parseAbi([signature]),functionName:signature.slice(9).split('(')[0],args,blockNumber}) as T;
}
export function resolveAeroImplementation(pool:Address,code:Hex):Address {
  const match=/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code);
  return match?`0x${match[1].toLowerCase()}`:pool;
}
// V4 pools share the PoolManager address; they are unique by (tokens, fee, tickSpacing).
const unique=(values:string[])=>new Set(values).size===values.length;
export async function captureAeroSnapshot(client:PublicClient,configs:CapturePool[],blockNumber?:bigint):Promise<CaptureResult> {
  if(await client.getChainId()!==8453)throw new Error('INCOHERENT_SNAPSHOT');
  if(configs.length<1||configs.length>48||new Set(configs.map(p=>p.poolId)).size!==configs.length||!unique(configs.filter(p=>p.generation!=='external-v4').map(p=>p.address.toLowerCase()))||!unique(configs.filter(p=>p.generation==='external-v4').map(p=>JSON.stringify([...(p.tokens??[])].map(t=>t.toLowerCase()).sort().concat([String(p.v4Key?.fee),String(p.v4Key?.tickSpacing)])))))throw new Error('INVALID_INPUT');
  const block=await client.getBlock(blockNumber===undefined?{}:{blockNumber});
  if(!block.hash||!block.number||/^0x0{64}$/.test(block.hash))throw new Error('INCOHERENT_SNAPSHOT');
  const identity={chainId:8453 as const,blockNumber:block.number.toString(),blockHash:block.hash,timestamp:block.timestamp.toString()},pins:AeroRequest['pins']=[];
  const pinned=new Map<string,Promise<Hex>>();
  const pin=(address:Address,role:AeroRequest['pins'][number]['role'],revision:string)=>{
    const key=`${role}:${address}`;if(!pinned.has(key))pinned.set(key,pinOnce(address,role,revision));return pinned.get(key)!;
  };
  const pinOnce=async(address:Address,role:AeroRequest['pins'][number]['role'],revision:string)=>{
    const code=await client.getCode({address,blockNumber:block.number});if(!code||code==='0x')throw new Error('UNTRUSTED_ROOT');
    const codeHash=keccak256(code);pins.push({address,role,codeHash,sourceRevision:revision});return codeHash;
  };
  const pools:AeroPool[]=new Array(configs.length);
  // Pools are captured concurrently (bounded) so batched reads share Multicall3 round-trips.
  await bounded(configs,6,async(c,index)=>{
    if(!/^[a-f0-9]{40}$/.test(c.sourceRevision))throw new Error('INVALID_INPUT');
    const address=c.address.toLowerCase() as Address,factory=c.factory.toLowerCase() as Address;
    if(AERO_FACTORIES[c.generation]&&factory!==AERO_FACTORIES[c.generation])throw new Error('UNSUPPORTED_GENERATION');
    const factoryHash=await pin(factory,'factory',c.sourceRevision);if(c.expectedFactoryCodeHash&&factoryHash!==c.expectedFactoryCodeHash)throw new Error('UNTRUSTED_ROOT');
    if(c.generation==='external-v4'){pools[index]=await captureV4(client,c,factory,factoryHash,block as {number:bigint;hash:Hex;timestamp:bigint});return;}
    const code=await client.getCode({address,blockNumber:block.number});if(!code||code==='0x')throw new Error('UNTRUSTED_ROOT');
    await pin(address,'pool',c.sourceRevision);
    const implementation=resolveAeroImplementation(address,code),implementationCodeHash=await pin(implementation,'implementation',c.sourceRevision);
    if(c.expectedImplementationCodeHash&&implementationCodeHash!==c.expectedImplementationCodeHash)throw new Error('UNTRUSTED_ROOT');
    const read=<T>(signature:string,args:readonly unknown[]=[])=>readAero<T>(client,address,signature,args,block.number);
    const token0=(await read<Address>('function token0() view returns(address)')).toLowerCase() as Address,token1=(await read<Address>('function token1() view returns(address)')).toLowerCase() as Address;
    if(token0>=token1||token0===zeroAddress)throw new Error('INVALID_INPUT');
    const decimals0=await readAero<number>(client,token0,'function decimals() view returns(uint8)',[],block.number),decimals1=await readAero<number>(client,token1,'function decimals() view returns(uint8)',[],block.number);
    const common={poolId:c.poolId,address,factory,generation:c.generation,token0,token1,decimals0,decimals1,implementation,implementationCodeHash};
    if(c.generation==='classic'||c.generation==='external-v2') {
      const [reserve0,reserve1]=await read<readonly [bigint,bigint,number]>('function getReserves() view returns(uint256,uint256,uint256)');
      if(c.generation==='classic') {
        const stable=await read<boolean>('function stable() view returns(bool)');
        if((await read<Address>('function factory() view returns(address)')).toLowerCase()!==factory||(await readAero<Address>(client,factory,'function getPool(address,address,bool) view returns(address)',[token0,token1,stable],block.number)).toLowerCase()!==address)throw new Error('UNTRUSTED_ROOT');
        const fee=await readAero<bigint>(client,factory,'function getFee(address,bool) view returns(uint256)',[address,stable],block.number);
        const balances=await Promise.all([token0,token1].map(t=>readAero<bigint>(client,t,'function balanceOf(address) view returns(uint256)',[address],block.number)));
        if(balances[0]!==reserve0||balances[1]!==reserve1||fee>=10000n)throw new Error('INCOHERENT_SNAPSHOT');
        pools[index]=({...common,state:{protocol:stable?'aero-stable':'aero-volatile',reserve0:reserve0.toString(),reserve1:reserve1.toString(),balance0:balances[0].toString(),balance1:balances[1].toString(),feeBps:Number(fee),stable}});
      } else {
        const fee=c.v2FeePips;if(fee===undefined||!Number.isInteger(fee)||fee<0||fee>=1000000)throw new Error('EXPLICIT_EXTERNAL_V2_FEE_PROFILE_REQUIRED');
        if((await readAero<Address>(client,factory,'function getPair(address,address) view returns(address)',[token0,token1],block.number)).toLowerCase()!==address)throw new Error('UNTRUSTED_ROOT');
        pools[index]={...common,state:{protocol:'uniswap-v2',reserve0:reserve0.toString(),reserve1:reserve1.toString(),feeNumerator:(1000000-fee).toString(),feeDenominator:'1000000'}};
      }
    } else {
      const spacing=await read<number>('function tickSpacing() view returns(int24)'),external=c.generation==='external-v3';
      const feePips=await read<number>('function fee() view returns(uint24)');
      if(!Number.isInteger(spacing)||spacing<=0)throw new Error('INVALID_INPUT');
      const found=await readAero<Address>(client,factory,external?'function getPool(address,address,uint24) view returns(address)':'function getPool(address,address,int24) view returns(address)',[token0,token1,external?feePips:spacing],block.number);
      if(found.toLowerCase()!==address||!external&&(await read<Address>('function factory() view returns(address)')).toLowerCase()!==factory)throw new Error('UNTRUSTED_ROOT');
      const slot=await read<readonly unknown[]>(external?'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)':'function slot0() view returns(uint160,int24,uint16,uint16,uint16,bool)');
      const tick=Number(slot[1]),liquidity=await read<bigint>('function liquidity() view returns(uint128)');
      if(!slot[external?6:5])throw new Error('INCOHERENT_SNAPSHOT');
      const radius=c.bitmapRadius??1;if(!Number.isInteger(radius)||radius<1||radius>8)throw new Error('INVALID_INPUT');
      const center=Math.floor(Math.floor(tick/spacing)/256),bitmapWords=[],initializedTicks=[];
      for(let pos=Math.max(-32768,center-radius);pos<=Math.min(32767,center+radius);pos++) {
        const bitmap=await read<bigint>('function tickBitmap(int16) view returns(uint256)',[pos]);bitmapWords.push({wordPosition:pos,bitmap:bitmap.toString()});
        const indices=[];for(let bit=0;bit<256;bit++)if(bitmap&(1n<<BigInt(bit)))indices.push((pos*256+bit)*spacing);
        // Bounded batches avoid rate-limit fan-out without reading inconsistent heads.
        for(let start=0;start<indices.length;start+=8)initializedTicks.push(...await Promise.all(indices.slice(start,start+8).map(async t=>{
          const [gross,net]=await read<readonly [bigint,bigint]>('function ticks(int24) view returns(uint128,int128)',[t]);return {tick:t,liquidityGross:gross.toString(),liquidityNet:net.toString()};
        })));
      }
      let module:Address=zeroAddress;let feeProfile:'fixed-proven'|'dynamic-snapshot'='fixed-proven';
      if(!external) {
        module=await readAero<Address>(client,factory,'function swapFeeModule() view returns(address)',[],block.number);
        // fee() already reads the module's fee at this block; only an EVM quoter can admit it (2A).
        if(module!==zeroAddress){await pin(module.toLowerCase() as Address,'fee-module',c.sourceRevision);feeProfile='dynamic-snapshot';}
      }
      pools[index]=({...common,state:{protocol:external?'uniswap-v3':'aero-slipstream',sqrtPriceX96:String(slot[0]),tick,liquidity:liquidity.toString(),tickSpacing:spacing,feePips,unlocked:true,lowerTick:Math.max(-887272,bitmapWords[0].wordPosition*256*spacing),upperTick:Math.min(887272,(bitmapWords.at(-1)!.wordPosition+1)*256*spacing-1),bitmapWords,initializedTicks,feeProfile,feeEvidenceDigest:digest({identity,factory,feePips,module})}});
    }
  });
  if((await client.getBlock({blockNumber:block.number})).hash!==block.hash)throw new Error('STATE_CHANGED');
  // Concurrent capture discovers pins in arbitrary order; sort for a reproducible snapshot digest.
  pins.sort((a,b)=>`${a.role}:${a.address}`.localeCompare(`${b.role}:${b.address}`));
  return {identity,pools,pins};
}
async function bounded<T>(items:readonly T[],limit:number,run:(item:T,index:number)=>Promise<void>):Promise<void> {
  let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;await run(items[i],i);}}));
}
async function captureV4(client:PublicClient,c:CapturePool,manager:Address,managerHash:Hex,block:{number:bigint;hash:Hex;timestamp:bigint}):Promise<AeroPool> {
  if(c.address.toLowerCase()!==manager||!c.tokens||!c.v4Key)throw new Error('INVALID_INPUT');
  const [a,b]=c.tokens.map(t=>t.toLowerCase() as Address);const [token0,token1]=a<b?[a,b]:[b,a];
  if(token0===zeroAddress||token0===token1)throw new Error('INVALID_INPUT');
  const key={currency0:token0,currency1:token1,fee:c.v4Key.fee,tickSpacing:c.v4Key.tickSpacing,hooks:zeroAddress};
  const state=pinnedStateClient(client,block),policy={chainId:8453,expectedRuntimeCodeHash:managerHash,maxBitmapWords:17};
  const probe=await snapshotUniswapV4(state,manager,key,[0],policy);
  if(probe.sqrtPriceX96==='0')throw new Error('INCOHERENT_SNAPSHOT');
  if(probe.protocolFeePips!==0||probe.lpFeePips!==c.v4Key.fee||c.v4Key.fee>=0x800000)throw new Error('UNSUPPORTED_FEE_PROFILE');
  const radius=c.bitmapRadius??1;if(!Number.isInteger(radius)||radius<1||radius>8)throw new Error('INVALID_INPUT');
  const center=Math.floor(Math.floor(probe.tick/key.tickSpacing)/256),words:number[]=[];
  for(let pos=Math.max(-32768,center-radius);pos<=Math.min(32767,center+radius);pos++)words.push(pos);
  const snap=await snapshotUniswapV4(state,manager,key,words,policy);
  const decimals=await Promise.all([token0,token1].map(t=>readAero<number>(client,t,'function decimals() view returns(uint8)',[],block.number)));
  const cl={protocol:'uniswap-v4' as const,sqrtPriceX96:snap.sqrtPriceX96,tick:snap.tick,liquidity:snap.liquidity,tickSpacing:key.tickSpacing,feePips:key.fee,unlocked:true as const,
    lowerTick:Math.max(-887272,words[0]*256*key.tickSpacing),upperTick:Math.min(887272,(words.at(-1)!+1)*256*key.tickSpacing-1),bitmapWords:snap.bitmapWords,initializedTicks:snap.initializedTicks,
    feeProfile:'fixed-proven' as const,feeEvidenceDigest:digest({poolId:snap.poolId,lpFeePips:snap.lpFeePips,protocolFeePips:snap.protocolFeePips,block:block.number.toString()}),hooks:zeroAddress,poolKeyId:snap.poolId};
  return {poolId:c.poolId,address:manager,factory:manager,generation:'external-v4',token0,token1,decimals0:decimals[0],decimals1:decimals[1],implementation:manager,implementationCodeHash:managerHash,state:cl};
}
/** V4 candidates are emitted for every standard key; capture rejects uninitialized ones (INCOHERENT_SNAPSHOT). */
export async function discoverAeroPools(client:PublicClient,pairs:ReadonlyArray<readonly [Address,Address]>,blockNumber:bigint,options:{uniswap?:boolean}={}):Promise<CapturePool[]> {
  if(pairs.length>12||await client.getChainId()!==8453)throw new Error('INVALID_INPUT');
  const found:CapturePool[]=[];
  for(const [a,b] of pairs)for(const [generation,factory] of Object.entries(AERO_FACTORIES)) {
    const selectors=generation==='classic'?[false,true]:[1,10,50,100,200,2000];
    for(const selector of selectors) {
      const pool=await readAero<Address>(client,factory,generation==='classic'?'function getPool(address,address,bool) view returns(address)':'function getPool(address,address,int24) view returns(address)',[a,b,selector],blockNumber);
      if(pool!==zeroAddress&&!found.some(p=>p.address===pool.toLowerCase()))found.push({poolId:`${generation}:${pool.toLowerCase()}`,address:pool.toLowerCase() as Address,factory,generation:generation as Generation,sourceRevision:generation==='classic'?CLASSIC_REVISION:CL_REVISION});
    }
  }
  // Uniswap venues on Base: V2 pair (fixed 0.3%), V3 fee tiers, V4 hookless standard keys.
  if(options.uniswap){
    const UNI={v2:'6a9e7c97860676e0992f22a49665760444c1cdf5',v3:'5ea68a77cb541c6b3812df783be71ba8c081e25f',v4:'bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6'};
    for(const [a,b] of pairs){
      const pair=(await readAero<Address>(client,UNISWAP_BASE.v2,'function getPair(address,address) view returns(address)',[a,b],blockNumber)).toLowerCase() as Address;
      if(pair!==zeroAddress)found.push({poolId:`external-v2:${pair}`,address:pair,factory:UNISWAP_BASE.v2,generation:'external-v2',sourceRevision:UNI.v2,v2FeePips:3000});
      for(const fee of V3_FEE_TIERS){
        const pool=(await readAero<Address>(client,UNISWAP_BASE.v3,'function getPool(address,address,uint24) view returns(address)',[a,b,fee],blockNumber)).toLowerCase() as Address;
        if(pool!==zeroAddress)found.push({poolId:`external-v3:${pool}`,address:pool,factory:UNISWAP_BASE.v3,generation:'external-v3',sourceRevision:UNI.v3});
      }
      for(const key of V4_STANDARD_KEYS)found.push({poolId:`external-v4:${a.toLowerCase()}:${b.toLowerCase()}:${key.fee}:${key.tickSpacing}`,address:UNISWAP_BASE.v4,factory:UNISWAP_BASE.v4,generation:'external-v4',sourceRevision:UNI.v4,tokens:[a,b],v4Key:{...key}});
    }
  }
  return found;
}
export async function captureAeroLender(client:PublicClient,kind:AeroLender['kind'],address:Address,asset:Address,blockNumber:bigint):Promise<AeroLender> {
  const code=await client.getCode({address,blockNumber});if(!code||code==='0x')throw new Error('UNTRUSTED_ROOT');
  const available=await readAero<bigint>(client,asset,'function balanceOf(address) view returns(uint256)',[address],blockNumber);
  let numerator=0n,denominator=1n;
  if(kind==='balancer-v2') {
    const collector=await readAero<Address>(client,address,'function getProtocolFeesCollector() view returns(address)',[],blockNumber);
    numerator=await readAero<bigint>(client,collector,'function getFlashLoanFeePercentage() view returns(uint256)',[],blockNumber);denominator=10n**18n;
    const [paused]=await readAero<readonly [boolean,bigint,bigint]>(client,address,'function getPausedState() view returns(bool,uint256,uint256)',[],blockNumber);if(paused)throw new Error('UNSUPPORTED_LENDER_CAPABILITY');
  }
  return {lenderId:`${kind}:${address.toLowerCase()}`,kind,address:address.toLowerCase() as Address,codeHash:keccak256(code),asset:asset.toLowerCase() as Address,available:available.toString(),feeNumerator:numerator.toString(),feeDenominator:denominator.toString(),feeRounding:kind==='balancer-v2'?'ceil':'zero',termsEvidenceDigest:digest({kind,address,blockNumber:blockNumber.toString(),available:available.toString(),numerator:numerator.toString(),denominator:denominator.toString(),codeHash:keccak256(code)})};
}
