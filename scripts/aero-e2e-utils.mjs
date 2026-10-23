import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createPublicClient,createWalletClient,http,defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const loadAeroArtifact=async(name,file=name)=>JSON.parse(await readFile(`out/${file}.sol/${name}.json`,'utf8'));
export function aeroTestClients(rpc){
  const url=new URL(rpc);assert.ok(url.hostname==='127.0.0.1'&&url.protocol==='http:','localhost required');
  // Published Anvil development key; never load an operator key in a proof.
  const account=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const chain=defineChain({id:8453,name:'Aero proof',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}});
  const client=createPublicClient({transport:http(rpc,{retryCount:0,timeout:60000})}),wallet=createWalletClient({account,chain,transport:http(rpc,{retryCount:0,timeout:60000})});
  const receipt=async hash=>{const result=await client.waitForTransactionReceipt({hash,timeout:60000});assert.equal(result.status,'success',`transaction reverted: ${hash}`);return result;};
  const deploy=async(name,file=name,args=[])=>{const artifact=await loadAeroArtifact(name,file);const r=await receipt(await wallet.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,args}));return {address:r.contractAddress.toLowerCase(),abi:artifact.abi};};
  const write=async(contract,functionName,args=[],extra={})=>{try{return await receipt(await wallet.writeContract({...contract,functionName,args,...extra}));}catch(e){throw new Error(`PROOF_WRITE_FAILED_${functionName.toUpperCase()}`,{cause:e});}};
  return {account,client,wallet,receipt,deploy,write};
}
export async function startAeroNode({port=19546,forkUrl,blockNumber}={}){
  const rpc=`http://127.0.0.1:${port}`,probe=createPublicClient({transport:http(rpc,{timeout:250,retryCount:0})});
  try{await probe.getChainId();throw new Error('PROOF_PORT_IN_USE');}catch(e){if(e.message==='PROOF_PORT_IN_USE')throw e;}
  let proxy;const args=['--host','127.0.0.1','--port',String(port),'--chain-id','8453','--silent'];
  if(forkUrl){
    const url=new URL(forkUrl);assert.equal(url.protocol,'https:');assert.ok(!url.username&&!url.password);assert.ok(blockNumber&&/^\d+$/.test(String(blockNumber)));
    const allowed=new Set(['eth_chainId','net_version','eth_getBlockByNumber','eth_getBlockByHash','eth_getCode','eth_getStorageAt','eth_getBalance','eth_getTransactionCount','eth_getProof','eth_call','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getLogs','eth_getBlockReceipts','eth_getBlockTransactionCountByNumber','eth_getBlockTransactionCountByHash']);
    // Credentials remain inside this explicit read-only host adapter. Anvil's
    // process arguments contain only localhost, and remote sends are impossible.
    proxy=createServer(async(req,res)=>{
      let body='';try{
        for await(const part of req){body+=part;if(body.length>1000000)throw new Error('TOO_LARGE');}
        const input=JSON.parse(body),batch=Array.isArray(input)?input:[input];if(batch.some(x=>!allowed.has(x.method)))throw new Error('METHOD_NOT_ALLOWED');
        let response;
        for(let attempt=0;attempt<3;attempt++){
          response=await fetch(forkUrl,{method:'POST',body,headers:{'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(30000)});
          if(response.status!==429&&response.status<500)break;
          await new Promise(r=>setTimeout(r,500*2**attempt));
        }
        res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text());
      }catch{res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32000,message:'FORK_SOURCE_READ_FAILED'}}));}
    });
    await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
    args.push('--fork-url',`http://127.0.0.1:${proxy.address().port}`,'--fork-block-number',String(blockNumber),'--retries','2','--timeout','60000');
  }
  const node=spawn('anvil',args,{stdio:['ignore','ignore','pipe']});let errors='';node.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-2000);});
  const close=()=>{node.kill('SIGTERM');proxy?.closeAllConnections();proxy?.close();};
  for(let i=0;i<300;i++){
    if(node.exitCode!==null){close();throw new Error('ANVIL_PROOF_START_FAILED');}
    try{if(await probe.getChainId()===8453)return {rpc,close};}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  close();throw new Error('ANVIL_PROOF_START_TIMEOUT');
}
