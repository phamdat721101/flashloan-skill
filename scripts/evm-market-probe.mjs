// Wallet-free, bounded opportunity research. Results never authorize submission.
import { readFile } from 'node:fs/promises';
import { createPublicClient,http,parseAbi,keccak256 } from 'viem';
import { evmProfile,PROFIT_ASSETS } from '../dist/evm-chains.js';
import { parseManifest } from '../dist/evm/deployment.js';
import { discoverEvmPools } from '../dist/evm/discovery.js';
import { enumerateSimpleProfitCycles } from '../dist/evm/acceptance.js';
import { readEvmAnalyticsSnapshot } from '../dist/liquidity/sources.js';
import { compareRouteDirections } from '../dist/liquidity/sizing.js';
import { digest } from '../dist/liquidity/state.js';
import { priceUsdE8 } from '../dist/evm-fees.js';
import { atomicJson } from '../dist/evm/storage.js';
async function main() {
const selectedChain=process.env.EVM_PROBE_CHAIN;
if(selectedChain!==undefined && !['base','robinhood'].includes(selectedChain))throw new Error('INVALID_PROBE_CHAIN');
for(const [chainId,key,feed] of [[8453,'base','0x7e860098F58bBFC8648a4311b374B1D669a2bc6B'],[4663,'robinhood','0x61B7e5650328764B076A108EFF5fa7282a1B9aD2']]) {
  if(selectedChain&&selectedChain!==key)continue;
  const profile=evmProfile(chainId),rpc=process.env[profile.rpcEnv]??profile.chain.rpcUrls.default.http[0];
  const client=createPublicClient({transport:http(rpc,{timeout:20000,retryCount:0})});
  const manifest=parseManifest(JSON.parse(await readFile(`config/${key}-mainnet.json`,'utf8')));
  const head=await client.getBlock({blockTag:'latest'});
  const requested=process.env.EVM_PROBE_BLOCKS??'24000';
  if(!/^(?:[1-9][0-9]{0,4})$/.test(requested) || Number(requested)>24000)throw new Error('INVALID_PROBE_WINDOW');
  const window=BigInt(requested),from=head.number>window?head.number-window:0n;
  let discovered,discoveryDegraded=null;
  try { discovered=await discoverEvmPools(manifest,from,head.number,true,true); }
  catch(error) {
    if(!(error instanceof Error) || error.message!=='DISCOVERY_LOG_QUERY_FAILED')throw error;
    // Retain a truthful finite probe when a public RPC refuses historical logs.
    discovered=await discoverEvmPools(manifest,head.number,head.number,true,false);
    discoveryDegraded='public RPC refused Initialize-log discovery; standard settlement-pair keys only';
  }
  const captured=await readEvmAnalyticsSnapshot(rpc,'wallet-free-probe','1',discovered.pools);
  const block=BigInt(captured.snapshot.identity.height),asset=PROFIT_ASSETS[chainId][1];
  const tokenAbi=parseAbi(['function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)']);
  const [decimals,available,price,code]=await Promise.all([client.readContract({address:asset,abi:tokenAbi,functionName:'decimals',blockNumber:block}),client.readContract({address:asset,abi:tokenAbi,functionName:'balanceOf',args:[manifest.roots.find(r=>r.role==='morpho').address],blockNumber:block}),priceUsdE8(client,feed,block,86400),client.getCode({address:feed,blockNumber:block})]);
  if(price<99000000n || price>101000000n || !code || code==='0x')throw new Error('INVALID_STABLE_PRICE');
  const cap=100000n*100000000n*10n**BigInt(decimals)/price, maximum=available<cap?available:cap;
  const byPoolId=new Map(captured.pools.map(pool=>[pool.poolId,pool])),routes=[];
  for(const route of enumerateSimpleProfitCycles(captured.pools,asset)) {
    const pools=route.map(leg=>byPoolId.get(leg.poolId));
    const request={schemaVersion:'4.0',snapshotDigest:digest(pools),borrowAsset:asset,route,minimum:'1',maximum:maximum.toString(),quantum:'1',lenderAvailable:available.toString(),flashFeeNumerator:'0',flashFeeDenominator:'1',costInBorrowAsset:'0',costEvidenceDigest:digest({scope:'optimistic-zero-gas-research-only'}),minProfit:((1000000000n*10n**BigInt(decimals)+price-1n)/price).toString(),maxEvaluations:64};
    routes.push({poolIds:route.map(leg=>leg.poolId),fees:pools.map(p=>p.state.lpFeePips),result:compareRouteDirections(pools,request)});
  }
  const result={schemaVersion:'1.0',chainId,source:'bounded wallet-free public RPC probe',coverage:discoveryDegraded?'four standard WETH/stable V4 keys only; 64 sampled sizes per direction; zero gas is optimistic, not execution admission':'standard WETH/stable keys plus Initialize events over the recorded range that touch a supported settlement asset; six largest raw-liquidity static V4 pools; simple two-to-six-hop cycles; 64 sampled sizes per direction; zero gas is optimistic, not execution admission',discoveryDegraded,capturedAtMs:Date.now(),snapshot:captured,discovery:discovered,price:{feed,source:`https://docs.chain.link/data-feeds/price-feeds/addresses?network=${key}`,codeHash:keccak256(code),usdE8:price.toString()},lenderAvailable:available.toString(),routes,selected:routes.filter(r=>r.result.selected).length};
  await atomicJson(`docs/deployments/${key}-market-probe.json`,result);
  console.log(JSON.stringify({chainId,pools:captured.pools.length,routes:routes.length,selected:result.selected,evidence:`docs/deployments/${key}-market-probe.json`}));
}
}
main().catch(error=>{const name=error instanceof Error&&/^[A-Za-z]{1,60}Error$/.test(error.name)?error.name:'Error',message=error instanceof Error?error.message:'';const code=/^[A-Z][A-Z0-9_]{2,80}$/.test(message)?message:'WALLET_FREE_PROBE_FAILED';console.error(JSON.stringify({status:'failed',code,category:name,detail:'Inspect the configured RPC and retry; no transaction was signed or sent.'}));process.exitCode=1;});
