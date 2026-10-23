import { createPublicClient, http, parseAbi, keccak256, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { digest } from '../liquidity/state.js';
import { secureEndpoint } from '../evm/deployment.js';
import type { AeroPool, AeroLender, AeroRequest, Generation } from './types.js';

export interface CapturePool {poolId:string;address:Address;factory:Address;generation:Generation;sourceRevision:string;bitmapRadius?:number;expectedFactoryCodeHash?:Hex;expectedImplementationCodeHash?:Hex}
export interface CaptureResult {identity:AeroRequest['identity'];pools:AeroPool[];pins:AeroRequest['pins']}
export const AERO_FACTORIES:Record<string,Address>={classic:'0x420dd381b31aef6683db6b902084cb0ffece40da','cl-initial':'0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a','cl-gauge-caps':'0xade65c38cd4849adba595a4323a8c7ddfe89716a','cl-gauges-v3':'0xf8f2eb4940cfe7d13603dddd87f123820fc061ef'};
const CLASSIC_REVISION='1ba30815bba620f7e9faa34769ffd00c214c9b82',CL_REVISION='f8717faaae6e6717db3c8e3850149c01a79c0603';
export const aeroPublicClient=(rpc:string):PublicClient=>createPublicClient({transport:http(secureEndpoint(rpc),{timeout:20000,retryCount:0})});
export async function readAero<T>(client:PublicClient,address:Address,signature:string,args:readonly unknown[],blockNumber:bigint):Promise<T> {
  return await client.readContract({address,abi:parseAbi([signature]),functionName:signature.slice(9).split('(')[0],args,blockNumber}) as T;
}
export function resolveAeroImplementation(pool:Address,code:Hex):Address {
  const match=/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code);
  return match?`0x${match[1].toLowerCase()}`:pool;
}
export async function captureAeroSnapshot(client:PublicClient,configs:CapturePool[],blockNumber?:bigint):Promise<CaptureResult> {
  if(await client.getChainId()!==8453)throw new Error('INCOHERENT_SNAPSHOT');
  if(configs.length<1||configs.length>48||new Set(configs.map(p=>p.poolId)).size!==configs.length||new Set(configs.map(p=>p.address.toLowerCase())).size!==configs.length)throw new Error('INVALID_INPUT');
  const block=await client.getBlock(blockNumber===undefined?{}:{blockNumber});
  if(!block.hash||!block.number||/^0x0{64}$/.test(block.hash))throw new Error('INCOHERENT_SNAPSHOT');
  const identity={chainId:8453 as const,blockNumber:block.number.toString(),blockHash:block.hash,timestamp:block.timestamp.toString()},pins:AeroRequest['pins']=[];
  const pin=async(address:Address,role:AeroRequest['pins'][number]['role'],revision:string)=>{
    const prior=pins.find(p=>p.address===address&&p.role===role);if(prior)return prior.codeHash;
    const code=await client.getCode({address,blockNumber:block.number});if(!code||code==='0x')throw new Error('UNTRUSTED_ROOT');
    const codeHash=keccak256(code);pins.push({address,role,codeHash,sourceRevision:revision});return codeHash;
  };
  const pools:AeroPool[]=[];
  for(const c of configs) {
    if(!/^[a-f0-9]{40}$/.test(c.sourceRevision))throw new Error('INVALID_INPUT');
    const address=c.address.toLowerCase() as Address,factory=c.factory.toLowerCase() as Address;
    if(AERO_FACTORIES[c.generation]&&factory!==AERO_FACTORIES[c.generation])throw new Error('UNSUPPORTED_GENERATION');
    const factoryHash=await pin(factory,'factory',c.sourceRevision);if(c.expectedFactoryCodeHash&&factoryHash!==c.expectedFactoryCodeHash)throw new Error('UNTRUSTED_ROOT');
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
        pools.push({...common,state:{protocol:stable?'aero-stable':'aero-volatile',reserve0:reserve0.toString(),reserve1:reserve1.toString(),balance0:balances[0].toString(),balance1:balances[1].toString(),feeBps:Number(fee),stable}});
      } else throw new Error('EXPLICIT_EXTERNAL_V2_FEE_PROFILE_REQUIRED');
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
      let module:Address=zeroAddress;let feeProfile:'fixed-proven'|'dynamic-evm'='fixed-proven';
      if(!external) {
        module=await readAero<Address>(client,factory,'function swapFeeModule() view returns(address)',[],block.number);
        if(module!==zeroAddress){await pin(module.toLowerCase() as Address,'fee-module',c.sourceRevision);feeProfile='dynamic-evm';}
      }
      pools.push({...common,state:{protocol:external?'uniswap-v3':'aero-slipstream',sqrtPriceX96:String(slot[0]),tick,liquidity:liquidity.toString(),tickSpacing:spacing,feePips,unlocked:true,lowerTick:Math.max(-887272,bitmapWords[0].wordPosition*256*spacing),upperTick:Math.min(887272,(bitmapWords.at(-1)!.wordPosition+1)*256*spacing-1),bitmapWords,initializedTicks,feeProfile,feeEvidenceDigest:digest({identity,factory,feePips,module})}});
    }
  }
  if((await client.getBlock({blockNumber:block.number})).hash!==block.hash)throw new Error('STATE_CHANGED');
  return {identity,pools,pins};
}
export async function discoverAeroPools(client:PublicClient,pairs:ReadonlyArray<readonly [Address,Address]>,blockNumber:bigint):Promise<CapturePool[]> {
  if(pairs.length>12||await client.getChainId()!==8453)throw new Error('INVALID_INPUT');
  const found:CapturePool[]=[];
  for(const [a,b] of pairs)for(const [generation,factory] of Object.entries(AERO_FACTORIES)) {
    const selectors=generation==='classic'?[false,true]:[1,10,50,100,200,2000];
    for(const selector of selectors) {
      const pool=await readAero<Address>(client,factory,generation==='classic'?'function getPool(address,address,bool) view returns(address)':'function getPool(address,address,int24) view returns(address)',[a,b,selector],blockNumber);
      if(pool!==zeroAddress&&!found.some(p=>p.address===pool.toLowerCase()))found.push({poolId:`${generation}:${pool.toLowerCase()}`,address:pool.toLowerCase() as Address,factory,generation:generation as Generation,sourceRevision:generation==='classic'?CLASSIC_REVISION:CL_REVISION});
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
  return {lenderId:`${kind}:${address.toLowerCase()}`,kind,address:address.toLowerCase() as Address,codeHash:keccak256(code),asset:asset.toLowerCase() as Address,available:available.toString(),feeNumerator:numerator.toString(),feeDenominator:denominator.toString(),feeRounding:kind==='morpho'?'zero':'ceil',termsEvidenceDigest:digest({kind,address,blockNumber:blockNumber.toString(),available:available.toString(),numerator:numerator.toString(),denominator:denominator.toString(),codeHash:keccak256(code)})};
}
