// Read-only verification of the price-gap replacement. No signer is loaded.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createPublicClient,http,keccak256,parseAbi,toFunctionSelector} from 'viem';
import {parseManifest,secureEndpoint,verifyRuntime,rootKey} from '../dist/evm/deployment.js';
import {atomicJson} from '../dist/evm/storage.js';
import {evmProfile} from '../dist/evm-chains.js';
const manifest=parseManifest(JSON.parse(await readFile('config/arbitrum-price-gap.json','utf8')));
const state=JSON.parse(await readFile('.nim/deployments/arbitrum-price-gap.json','utf8'));
if(state.chainId!==manifest.chainId||state.manifestHash!==createHash('sha256').update(JSON.stringify(manifest)).digest('hex')||state.deployments.length!==1)throw Error('DEPLOYMENT_STATE_BINDING_MISMATCH');
const entry=state.deployments[0];if(entry.contract!=='PortableMultiSplitFlashExecutor'||entry.status!=='verified'||state.transactions.length!==11||state.transactions.some(t=>t.status!=='confirmed'))throw Error('DEPLOYMENT_INCOMPLETE');
const client=createPublicClient({transport:http(secureEndpoint(process.env.ARBITRUM_RPC_URL??evmProfile(42161).chain.rpcUrls.default.http[0]),{timeout:20000,retryCount:1})});
try {
 if(await client.getChainId()!==42161)throw Error('CHAIN_MISMATCH');
 const block=await client.getBlock();const code=await client.getCode({address:entry.address,blockNumber:block.number});if(!code)throw Error('CODE_MISSING');
 const bytes=await readFile('out/PortableMultiSplitFlashExecutor.sol/PortableMultiSplitFlashExecutor.json'),artifact=JSON.parse(bytes);
 if(createHash('sha256').update(bytes).digest('hex')!==entry.artifactHash||keccak256(code)!==entry.runtimeCodeHash)throw Error('ARTIFACT_OR_CODE_CHANGED');
 verifyRuntime(artifact,code,state.owner);
 const owner=await client.readContract({address:entry.address,abi:artifact.abi,functionName:'owner',blockNumber:block.number});if(owner.toLowerCase()!==state.owner.toLowerCase())throw Error('OWNER_MISMATCH');
 const rootPins=[];
 for(const root of manifest.roots){
  const code=await client.getCode({address:root.address,blockNumber:block.number});if(!code||keccak256(code)!==root.codeHash)throw Error('ROOT_CODE_CHANGED');
  const field=root.role==='morpho'||root.role==='balancer-v2'?'trustedLenderCodeHash':root.role==='aave-provider'?'trustedAaveProviderCodeHash':root.role==='v2-factory'?'trustedV2FactoryCodeHash':root.role==='v3-factory'?'trustedV3FactoryCodeHash':root.role==='algebra-factory'?'trustedAlgebraFactoryCodeHash':'trustedV4ManagerCodeHash';
  const args=field==='trustedLenderCodeHash'?[root.role==='morpho'?1:2,root.address]:[root.address];
  const pin=await client.readContract({address:entry.address,abi:artifact.abi,functionName:field,args,blockNumber:block.number});if(pin!==root.codeHash)throw Error('ROOT_READBACK_MISMATCH');
  if(root.role==='v4-manager'&&await client.readContract({address:entry.address,abi:artifact.abi,functionName:'v4HooksAllowed',args:[root.address],blockNumber:block.number}))throw Error('HOOK_POLICY_MISMATCH');
  rootPins.push({...root,key:rootKey(root,manifest.roots),verified:true,configuredCodeHash:pin});
 }
 const transactions=[];
 for(const t of state.transactions){const receipt=await client.getTransactionReceipt({hash:t.hash});if(receipt.status!=='success'||block.number<receipt.blockNumber+1n||(await client.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash)throw Error('RECEIPT_INVALID');transactions.push({label:t.label,hash:t.hash,blockNumber:String(receipt.blockNumber),status:'success',gasUsed:String(receipt.gasUsed),costWei:t.costWei});}
 if((await client.getBlock({blockNumber:block.number})).hash!==block.hash)throw Error('READBACK_REORG');
 let finalized=null;try{finalized=await client.getBlock({blockTag:'finalized'});}catch{}
 const report={schemaVersion:'1.0',chainId:42161,contract:entry.contract,address:entry.address,owner,runtimeCodeHash:entry.runtimeCodeHash,artifactHash:entry.artifactHash,deployTxHash:entry.txHash,deploymentBlock:entry.blockNumber,verifiedAt:new Date().toISOString(),checkedBlock:{number:String(block.number),hash:block.hash},confirmationsAtLeast:2,l1Finalized:finalized?transactions.every(t=>BigInt(t.blockNumber)<=finalized.number):null,finalizedBlock:finalized?String(finalized.number):null,selectors:artifact.abi.filter(x=>x.type==='function'&&['executeSplitArbitrage','executeArbitrage','executeLenderArbitrage'].includes(x.name)).map(x=>({name:x.name,selector:toFunctionSelector(x)})),capabilities:{maximumBranches:8,maximumHopsPerBranch:6,splitLenders:['morpho','balancer-v2'],linearLenders:['morpho','balancer-v2','aave-v3'],hookPolicy:'disabled',assetPolicy:'route-specified; exact native simulation required'},rootPins,transactions,spentWei:state.spentWei,supersedesForNewPriceGapRoutes:'0x2502539753df1182f015378f32fbdef0ec9c9de2',liveTradingAdmitted:false,verificationScope:'deployment, canonical receipts, exact artifact/owner and all ten roots; no live profit/canary claim'};
 await atomicJson('docs/deployments/arbitrum-price-gap-executor-20261028.json',report);
 console.log(JSON.stringify({verified:true,address:report.address,roots:rootPins.length,transactions:transactions.length,spentWei:report.spentWei,l1Finalized:report.l1Finalized,liveTradingAdmitted:false}));
}catch(error){console.error(JSON.stringify({verified:false,code:/^[A-Z_]+$/.test(error.message)?error.message:'READBACK_RPC_ERROR'}));process.exitCode=1;}
