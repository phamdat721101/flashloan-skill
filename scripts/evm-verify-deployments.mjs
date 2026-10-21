// Read-only verification. Publish public receipts, never signer inputs or endpoints.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { atomicJson } from '../dist/evm/storage.js';
for(const key of ['base','robinhood']) {
  const statePath=`.nim/deployments/${key}.json`;
  const state=JSON.parse(await readFile(statePath,'utf8'));
  const verification=JSON.parse(execFileSync(process.execPath,['dist/evm/cli.js','deployment-status','--manifest',`config/${key}-mainnet.json`,'--state',statePath],{encoding:'utf8',timeout:180000}));
  await atomicJson(`docs/deployments/${key}-executors.json`,{schemaVersion:'1.0',chainId:state.chainId,owner:state.owner,verifiedAtMs:Date.now(),spentWei:state.spentWei,transactions:state.transactions,verification});
  console.log(JSON.stringify({chainId:state.chainId,contracts:verification.deployments.length,finalized:verification.deployments.every(d=>d.finalized),spentWei:state.spentWei}));
}
