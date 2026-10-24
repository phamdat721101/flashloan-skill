// Offline audit of actual local/fork receipts. Run the E2E commands to regenerate.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {AERO_SELECTOR} from '../dist/aero/execution.js';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
if(process.argv.includes('--feature')&&process.argv[process.argv.indexOf('--feature')+1]==='v2'){
  // V2: quoter-verified local send through the shared runtime, and pinned-fork deploy + real-pool quote parity.
  const {AERO_V2_SELECTOR}=await import('../dist/aero/execution.js');
  const v2Hash=createHash('sha256').update(readFileSync('out/AeroSplitFlashExecutorV2.sol/AeroSplitFlashExecutorV2.json')).digest('hex');
  const local=read('.nim/e2e/aero-v2-local.json'),fork=read('.nim/e2e/aero-v2-fork.json');
  assert.equal(local.artifactHash,v2Hash);assert.equal(fork.executor.artifactHash,v2Hash);assert.equal(local.selector,AERO_V2_SELECTOR);assert.equal(fork.executor.selector,AERO_V2_SELECTOR);
  assert.equal(local.quoteSource,'evm-quoter');assert.equal(local.sentThroughSharedRuntime,true);assert.equal(local.repaymentProven,true);assert.equal(local.revertAccounted,true);assert.equal(local.blockLagAdmitted,true);assert.ok(BigInt(local.profit)>0n);
  assert.equal(fork.mainnetBroadcast,false);assert.ok(fork.executor.configuredRoots>=10);
  const quoted=fork.cases.filter(c=>'parity'in c);assert.ok(quoted.length>=10);
  for(const c of quoted)if(c.feeProfile!=='dynamic-snapshot')assert.equal(c.parity,true,c.poolId);
  const generations=new Set(quoted.map(c=>c.generation));for(const g of['classic','external-v2','external-v3','cl-initial','cl-gauge-caps','cl-gauges-v3'])assert.ok(generations.has(g),g);
  if(process.argv.includes('--deployment')){
    const d=read(process.argv[process.argv.indexOf('--deployment')+1]),artifact=read('config/aero-base-executor-v2.json');
    assert.equal(d.verified,true);assert.equal(d.chainId,8453);assert.equal(d.artifactHash,v2Hash);assert.equal(artifact.artifactHash,v2Hash);assert.equal(artifact.version,2);
    assert.equal(artifact.address.toLowerCase(),d.address.toLowerCase());assert.equal(artifact.runtimeCodeHash,d.runtimeCodeHash);assert.equal(artifact.selector,AERO_V2_SELECTOR);
    console.log(JSON.stringify({event:'AERO_V2_EDGE_08',verified:true,address:d.address}));
  }
  console.log(JSON.stringify({event:'AERO_V2_EDGE_05_06',verified:true,artifactHash:v2Hash,forkQuoted:quoted.length,exactParity:quoted.filter(c=>c.parity).length,mainnetTradingBroadcast:false}));
  process.exit(0);
}
const artifactHash=createHash('sha256').update(readFileSync('out/AeroSplitFlashExecutor.sol/AeroSplitFlashExecutor.json')).digest('hex');
const local=read('.nim/e2e/aero-local.json'),fork=read('.nim/e2e/aero-fork.json');
for(const proof of[local,fork]){assert.equal(proof.verified,true);assert.equal(proof.chainId,8453);assert.equal(proof.constructed,true);assert.equal(proof.artifactHash,artifactHash);assert.equal(proof.selector,AERO_SELECTOR);}
assert.equal(local.repaymentProven,true);assert.equal(local.openingBalancePreserved,true);assert.equal(local.finalAwaitCancellationProven,true);assert.equal(local.orderedEvmHostProven,true);
assert.equal(local.simulation.broadcast,false);assert.equal(local.simulation.valuationSource,'synthetic-local');assert.equal(fork.mainnetBroadcast,false);assert.equal(fork.cases.length,5);
assert.equal(new Set(fork.cases.map(c=>c.protocol)).size,3);
assert.deepEqual(fork.cases.filter(c=>c.generation.startsWith('cl-')).map(c=>c.generation).sort(),['cl-gauge-caps','cl-gauges-v3','cl-initial']);
for(const c of fork.cases){
 assert.equal(c.repaymentProven,true);assert.equal(c.custodyProven,true);assert.equal(c.simulation.broadcast,false);assert.equal(c.simulation.valuationSource,'wrapped-native');assert.equal(c.simulation.artifactHash,artifactHash);assert.ok(BigInt(c.simulation.netProfit)>0n);assert.ok(BigInt(c.receipt.profitAfterDebt)>0n);
 assert.match(c.receipt.transactionHash,/^0x[0-9a-f]{64}$/);assert.ok(c.pins.some(p=>p.role==='factory'&&p.address===c.factory));assert.ok(c.pins.some(p=>p.role==='implementation'&&p.address===c.implementation&&p.codeHash===c.implementationCodeHash));
 if(c.generation==='classic')assert.equal(c.parity.length,2);else assert.ok(c.parity.some(p=>p.direction==='one-for-zero'&&p.stateParity));
}
console.log(JSON.stringify({event:'AERO_IMPL_EDGE_05',verified:true,artifactHash,local:true,pinnedBaseCases:5,reverseClParity:true,naturalLiveProfit:false,mainnetTradingBroadcast:false}));
