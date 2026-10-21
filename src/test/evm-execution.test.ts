import { createHash } from 'node:crypto';
import { toFunctionSelector } from 'viem';
import { EvmBudget } from '../evm/budget.js';
import { runAcceptance, loadAdmissionEvidence } from '../evm/acceptance.js';
import { atomicJson } from '../evm/storage.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, encodeAbiParameters, encodeAbiParameters as encode, encodeEventTopics, encodeFunctionResult, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ArbitrumLiquidityExecutionAdapter, type ArbitrumExecutionConfig } from '../liquidity/arbitrum-execution.js';
import { encodeLenderArbitrage, MULTI_LENDER_ROUTE_ABI } from '../liquidity/arbitrum.js';
import { digest, SnapshotStore } from '../liquidity/state.js';
import { AttemptJournal } from '../liquidity/journal.js';
import { LiquidityRuntime, type RouteCandidate } from '../liquidity/runtime.js';

import { fixture, account, executor, root, lender, blockHash } from './evm-rpc-fixture.js';
import { evmProfile } from '../evm-chains.js';

for (const chainId of [8453,4663]) {
const fixtureForChain: typeof fixture = (run) => fixture(run,chainId);
test(`${chainId} adapter signs final EIP-1559 bytes locally and reconciles route-bound receipt custody`, async () => {
  await fixtureForChain(async (adapter, candidate, config, controls) => {
    const directory = await mkdtemp(join(tmpdir(), 'liquidity-real-signing-'));
    try {
      const snapshots = new SnapshotStore(60000);
      snapshots.apply({ schemaVersion: '3.0', identity: candidate.identity, sourceId: 'local-rpc', cursor: '1', observedAtMs: Date.now(), complete: true, poolIds: candidate.poolIds, stateDigest: candidate.stateDigest });
      const journal = new AttemptJournal(join(directory, 'attempts.jsonl'));
      const decisions = await new LiquidityRuntime(snapshots, journal, new Map([[candidate.adapterId, adapter]])).run([candidate], { mode: 'auto', concurrency: 1, maxCandidates: 1, maxDailyLoss: '1000000', minProfit: '10000', budgetAssets: { [`${evmProfile(chainId).key}:${chainId}`]: candidate.profitAsset } });
      assert.ok(decisions.some(decision => decision.status === 'reconciled'), JSON.stringify(decisions));
      assert.equal(controls.sends, 1); assert.ok(controls.raw);
      const parsed = parseTransaction(controls.raw);
      assert.equal(parsed.chainId, chainId); assert.equal(parsed.nonce, 0); assert.equal(parsed.to?.toLowerCase(), executor.toLowerCase());
      assert.ok(controls.raw.startsWith('0x02'));
      assert.equal((await recoverTransactionAddress({ serializedTransaction: controls.raw as `0x02${string}` })).toLowerCase(), account.address.toLowerCase());
      assert.equal((await journal.latest())[0].transactionId, keccak256(controls.raw));
      assert.equal((await journal.latest())[0].loss, '0');
      const receipt = await adapter.receipt(keccak256(controls.raw));
      assert.equal(receipt?.profitTransferProven, false); assert.equal(receipt?.profitCustodyProven, true);
      const recovered = new ArbitrumLiquidityExecutionAdapter(config, account, [{ candidate, calldata: parsed.data! }]);
      assert.equal((await recovered.receipt(keccak256(controls.raw)))?.profitAfterDebt, '110000');
      assert.equal(controls.sends, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
test(`${chainId} revision drift and pending nonce changes reject before submission`, async () => {
  await fixtureForChain(async (adapter, candidate, _, controls) => {
    const resource = await adapter.resource(candidate);
    controls.nonce = 1;
    await assert.rejects(adapter.sign(candidate, resource), /NONCE_CHANGED/);
    controls.drift = true;
    await assert.rejects(adapter.simulate(candidate), /EXECUTION_REVISION_CHANGED/);
    assert.equal(controls.sends, 0);
  });
});
test(`${chainId} cancellation during the relay chain-ID response cannot broadcast after halt`, async () => {
  await fixtureForChain(async (adapter, candidate, _, controls) => {
    const signed = await adapter.sign(candidate, await adapter.resource(candidate));
    const controller = new AbortController(); controls.abortRelay = controller;
    await assert.rejects(adapter.submit(signed.signedBytes, controller.signal), /EXECUTION_CANCELLED/);
    assert.equal(controller.signal.aborted, true); assert.equal(controls.chainReads, 2); assert.equal(controls.sends, 0);
  });
});

}


test('actual acceptance recovery validates proof artifacts and receipt-block feeds, finalizes once and never resends',async()=>{
  await fixture(async(adapter,candidate,config,controls)=>{
    const directory=await mkdtemp(join(tmpdir(),'evm-acceptance-recovery-'));
    const owner=account.address.toLowerCase(), authority=`.nim/evm-acceptance/4663-${owner}.json`;
    const journalPath=`${authority}.attempts.jsonl`, budgetPath=`.nim/evm-budgets/4663-${owner}.json`;
    const oldRpc=process.env.ROBINHOOD_RPC_URL;
    try {
      controls.profit=10n**18n;controls.recoveryFinalized=true;
      process.env.ROBINHOOD_RPC_URL=config.rpcUrl;
      const env=join(directory,'signer.env');await writeFile(env,`OPERATOR_PRIVATE_KEY=0x${'1'.repeat(64)}\n`);
      const artifactHash='b'.repeat(64), executorCodeHash=keccak256('0x6000'),capability=toFunctionSelector(MULTI_LENDER_ROUTE_ABI[0]);
      const evidencePath=join(directory,'evidence.json'),proofs:Record<string,{path:string;sha256:string}>={};
      for(const kind of ['schema','math','simulation','canary']) {
        const path=join(directory,`${kind}.json`),bytes=JSON.stringify({schemaVersion:'1.0',kind,success:true,chainId:4663,executorCodeHash,artifactHash,capability,source:'local RPC test fixture, not production admission',verifiedAtMs:Date.now(),blockHash});
        await writeFile(path,bytes);proofs[kind]={path,sha256:createHash('sha256').update(bytes).digest('hex')};
      }
      await atomicJson(evidencePath,{schemaVersion:'1.0',chainId:4663,executorCodeHash,artifactHash,capability,proofs});
      assert.equal(Object.keys(await loadAdmissionEvidence(evidencePath,4663,{runtimeCodeHash:executorCodeHash,artifactHash})).length,4);
      await writeFile(proofs.canary.path,'{}');await assert.rejects(loadAdmissionEvidence(evidencePath,4663,{runtimeCodeHash:executorCodeHash,artifactHash}),/HASH_MISMATCH/);
      const canary=JSON.stringify({schemaVersion:'1.0',kind:'canary',success:true,chainId:4663,executorCodeHash,artifactHash,capability,source:'local RPC fixture',verifiedAtMs:Date.now(),blockHash});
      await writeFile(proofs.canary.path,canary);proofs.canary.sha256=createHash('sha256').update(canary).digest('hex');
      await atomicJson(evidencePath,{schemaVersion:'1.0',chainId:4663,executorCodeHash,artifactHash,capability,proofs});
      const manifestPath=join(directory,'manifest.json'),deploymentStatePath=join(directory,'deployment.json');
      await atomicJson(manifestPath,{schemaVersion:'1.0',chainId:4663,roots:[{role:'morpho',address:lender,codeHash:executorCodeHash,source:'https://fixture.invalid'}],contracts:['MultiVenueArbitrageExecutor'],exclusions:[]});
      await atomicJson(deploymentStatePath,{chainId:4663,owner:account.address,deployments:[{contract:'MultiVenueArbitrageExecutor',status:'verified',address:executor,runtimeCodeHash:executorCodeHash,artifactHash}]});
      const feed=`0x${'6'.repeat(40)}`,asset=evmProfile(4663).wrappedNative;
      const acceptance={schemaVersion:'1.0',chainId:4663,manifestPath,deploymentStatePath,evidencePath,statePath:join(directory,'report.json'),pools:[{},{}],venueRoots:{[executor]:root},profitAsset:asset,assetUsdFeed:feed,nativeUsdFeed:feed,feedCodePins:{[feed]:executorCodeHash},maxPriceAgeSeconds:60,maxRounds:1,pollIntervalMs:1000};
      const configPath=join(directory,'config.json');await atomicJson(configPath,acceptance);
      const signed=await adapter.sign(candidate,await adapter.resource(candidate));
      const hash=signed.transactionId;
      await atomicJson(authority,{schemaVersion:'1.0',chainId:4663,owner:account.address,configDigest:digest(acceptance),startedAtMs:Date.now(),submissions:1,spentGasWei:'0',status:'acceptance-unknown',rounds:0,pending:{candidate,calldata:parseTransaction(toHexLocal(signed.signedBytes)).data,hash,valuation:{asset,decimals:18,nativeUsdFeed:feed,assetUsdFeed:feed,maxAgeSeconds:60},submissionStarted:true},receipts:[]});
      const budget=new EvmBudget(4663,account.address);await budget.load();await budget.reserve('trade',hash,100000n);
      const journal=new AttemptJournal(journalPath);await journal.prepare({id:'recovery',lane:'robinhood:4663',budgetAsset:candidate.profitAsset,candidateDigest:digest(candidate),resource:signed.resource,state:'prepared',transactionId:null,loss:'100000',day:new Date().toISOString().slice(0,10)},1000000n,100000n);await journal.transition('recovery','signed',hash);
      controls.feedDrift=true;await assert.rejects(runAcceptance(configPath,env,true),/PRICE_FEED_CHANGED/);
      controls.feedDrift=false;
      const recovered=await runAcceptance(configPath,env,true);assert.equal(recovered.status,'profitable-finalized');assert.equal(recovered.receipts.length,1);
      const again=await runAcceptance(configPath,env,true);assert.equal(again.receipts.length,1);assert.equal(again.spentGasWei,'42000');assert.equal(controls.sends,0);assert.equal((await journal.latest())[0].state,'reconciled');
    } finally {
      if(oldRpc===undefined)delete process.env.ROBINHOOD_RPC_URL;else process.env.ROBINHOOD_RPC_URL=oldRpc;
      for(const path of [authority,journalPath,budgetPath])await rm(path,{force:true});
      await rm(directory,{recursive:true,force:true});
    }
  },4663);
});
function toHexLocal(bytes:Uint8Array):Hex{return `0x${Buffer.from(bytes).toString('hex')}`;}
