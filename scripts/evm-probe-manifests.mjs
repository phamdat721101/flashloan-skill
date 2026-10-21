import { createPublicClient,http,keccak256,parseAbi } from 'viem';
import { atomicJson } from '../dist/evm/storage.js';
const sources={uniswap:'https://docs.uniswap.org/contracts/v4/deployments',morpho:'https://api.morpho.org/graphql',aave:'https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Base.sol'};
const targets=[
  {key:'base',id:8453,rpc:'https://mainnet.base.org',morpho:'0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',manager:'0x498581ff718922c3f8e6a244956af099b2652b2b',provider:'0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D'},
  {key:'robinhood',id:4663,rpc:'https://rpc.mainnet.chain.robinhood.com',morpho:'0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010',manager:'0x8366a39cc670b4001a1121b8f6a443a643e40951'}
];
for(const t of targets) {
  const client=createPublicClient({transport:http(t.rpc,{retryCount:0,timeout:20000})});
  if(await client.getChainId()!==t.id)throw new Error('CHAIN_MISMATCH');
  const block=await client.getBlock({blockTag:'latest'});
  const roots=[];
  for(const [role,address,source] of [['morpho',t.morpho,sources.morpho],['v4-manager',t.manager,sources.uniswap],...(t.provider?[['aave-provider',t.provider,sources.aave]]:[])]) {
    const code=await client.getCode({address,blockNumber:block.number});
    if(!code || code==='0x')throw new Error('ROOT_CODE_MISSING');
    roots.push({role,address,codeHash:keccak256(code),source});
  }
  if(t.provider) {
    const pool=await client.readContract({address:t.provider,abi:parseAbi(['function getPool() view returns(address)']),functionName:'getPool',blockNumber:block.number});
    if(pool.toLowerCase()!=='0xa238dd80c259a72e81d7e4664a9801593f98d1c5')throw new Error('AAVE_POOL_MAPPING_CHANGED');
  }
  if((await client.getBlock({blockNumber:block.number})).hash!==block.hash)throw new Error('BLOCK_REORG');
  const contracts=['MultiVenueArbitrageExecutor','PortableMultiSplitFlashExecutor','V4StateQuoter',...(t.provider?['ImmutableArbitrageExecutor']:[])];
  const exclusions=[{contract:'ArbitrumMultiSplitFlashExecutor',reason:'Historical Arbitrum constants; replaced by portable authenticated split revision'},...(!t.provider?[{contract:'ImmutableArbitrageExecutor',reason:'No authoritative Aave provider admitted for Robinhood'}]:[])];
  await atomicJson(`config/${t.key}-mainnet.json`,{schemaVersion:'1.0',chainId:t.id,roots,contracts,exclusions});
  await atomicJson(`docs/deployments/${t.key}-root-verification.json`,{chainId:t.id,blockNumber:block.number.toString(),blockHash:block.hash,observedAt:new Date().toISOString(),roots,source:'public-rpc-code-and-provider-readback',tradingAdmission:'not-admitted'});
  console.log(JSON.stringify({chainId:t.id,roots:roots.length,verified:true,readOnly:true}));
}
