import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ajv2020} from 'ajv/dist/2020.js';
import {deriveV4PoolId} from '../state-adapters.js';
import {digest,uint} from '../liquidity/state.js';
import {buildPoolUniverse,parseAssetPolicy,parseInventory,type UniverseReader} from '../evm/pool-universe.js';
import {EvmBudget} from '../evm/budget.js';
import {domainHash as implDomainHash} from '../evidence/integration.js';
import {RESULT_STATUS_MAP} from '../execution-outcome.js';
import {nativeToRepaymentUpper} from '../evm-fees.js';

/**
 * v7 integration harness (docs/features/flashloan-v7-integration.md). Contract-scope only: every EDGE marker proves the
 * shared contract, vectors and the current-code baseline the SK work packages must change. Runtime proofs stay todo
 * until the owning SK item lands; markers carry runtime:"PENDING" so no output can be read as runtime admission.
 */
export const FLASHLOAN_INTEGRATION_V1_SCHEMA_SHA256='1de7fced7a55bccf7fc5c45ab41934087344054961238a48484598944256aaaf';
const root=new URL('../../',import.meta.url);
const read=(path:string)=>readFileSync(new URL(path,root));
const json=(path:string)=>JSON.parse(read(path).toString('utf8'));
const ex=(name:string)=>json(`schemas/examples/flashloan-integration-v1/${name}`);
const vectors=ex('vectors.json');
/** Lane A (local deterministic) runtime is implemented; fork (B) and live (C/D/E) lanes stay owner-gated and are never implied by this marker. */
const marker=(edge:number,extra:Record<string,unknown>={})=>console.log(`FLASHLOAN_V7_EDGE_0${edge} ${JSON.stringify({pass:true,scope:'contract+runtime',runtime:'LANE_A',pendingLanes:['B','C','D','E'],...extra})}`);

let ajv:Ajv2020|undefined;
/** Mirrors the loader SK-10 specifies: own instance, strictTypes off (pinned bytes, erratum E2), RFC3339-UTC date-time (E1). */
function schema(def:string){
  if(!ajv){
    ajv=new Ajv2020({strict:true,strictTypes:false,allErrors:true});
    ajv.addFormat('date-time',/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/);
    ajv.addSchema(json('schemas/flashloan-integration-v1.schema.json'));
  }
  const check=ajv.getSchema(`urn:flashloan-integration:1#/$defs/${def}`);
  assert.ok(check,def);
  return (value:unknown)=>check(value) as boolean;
}
/** Reference oracle for the spec's canonical hash preimage; SK-02 moves it to src/evidence/integration.ts with these vectors. */
function canonical(v:unknown):unknown{
  if(Array.isArray(v)) return v.map(canonical);
  if(v&&typeof v==='object') return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical((v as Record<string,unknown>)[k])]));
  if(typeof v==='number'&&!Number.isSafeInteger(v)) throw new Error('UNSAFE_NUMBER');
  if(typeof v==='string'&&/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v)) throw new Error('INVALID_UNICODE');
  if(v===null||['string','boolean','number'].includes(typeof v)) return v;
  throw new Error('INVALID_CANONICAL_INPUT');
}
const domainHash=(domain:string,value:unknown)=>`sha256:${createHash('sha256').update(`${domain}\n${JSON.stringify(canonical(value))}`,'utf8').digest('hex')}`;
const ceilDiv=(a:bigint,b:bigint)=>(a+b-1n)/b;

test('FLASHLOAN_V7_EDGE_00 pinned contract bytes compile and match the vectors header',()=>{
  const sha=createHash('sha256').update(read('schemas/flashloan-integration-v1.schema.json')).digest('hex');
  assert.equal(sha,FLASHLOAN_INTEGRATION_V1_SCHEMA_SHA256);
  assert.equal(vectors.contractSchemaSha256,`sha256:${sha}`);
  assert.ok(schema('Intent')(ex('intent-valid.json')));
  assert.ok(schema('Intent')(ex('intent-tightened.json')));
});

test('FLASHLOAN_V7_EDGE_01 identity: v4 manager+poolId+PoolKey is canonical and current universe rejects it',async()=>{
  for(const v of vectors.v4PoolId) assert.equal(deriveV4PoolId(v.key),v.poolId);
  const good=ex('resolved-pool-native.json');
  assert.ok(schema('ResolvedPool')(good));
  assert.equal(deriveV4PoolId(good.key),good.poolId);
  const mismatch=ex('resolved-pool-mismatch.json');
  assert.ok(schema('ResolvedPool')(mismatch),'schema alone accepts a wrong poolId; semantic validator 1 must reject');
  assert.notEqual(deriveV4PoolId(mismatch.key),mismatch.poolId);
  assert.equal(schema('ResolvedPool')(ex('resolved-pool-zero-erc20.json')),false,'zero address is never an ERC20 asset');
  // Gate-off regression (S-E11): the legacy universe is unchanged and still rejects v4 rows; the gate-on bridge is partitionV4Inventory + resolveV4Pools.
  const manager='0x2222222222222222222222222222222222222222',[a,b]=vectors.v4PoolId;
  const WETH='0x82af49447d8a07e3bd95bd0d56f35241523fbab1',USDC='0xaf88d065e77c8cc2239327c5edb3a432268e5831';
  const row=(id:string,kind:string)=>({id,reference:{kind,chainId:42161,address:manager},asset_ids:[WETH,USDC],protocol:'uniswap-v4',labels:[],liquidity_usd:'500000',liquidity_eligible:true});
  const inventory={schema_version:'flashloan.public.v2',ok:true,data:{schema_version:'flashloan.inventory.v2',network:'arbitrum',observed_at:'2026-10-29T00:00:00.000Z',outcome:'SUCCESS',
    pools:[row(a.poolId,'provider_opaque'),row(a.poolId,'evm_contract'),row(b.poolId,'evm_contract')],coverage:[{source:'fixture',exhaustive:false}]}};
  const policy=parseAssetPolicy({schemaVersion:'asset-policy/1',chainId:42161,maxInventoryAgeSeconds:3600,universeTtlSeconds:600,maxPairs:16,denylist:[],
    assets:{[WETH]:{symbol:'WETH',usdFeed:'0x639fe6ab55c921f74e7fac1ee960c0b6293ba612',flashLenders:[]}},factories:{}});
  const reader:UniverseReader={async block(){return {number:1000n,hash:`0x${'ab'.repeat(32)}`,timestamp:BigInt(Date.parse('2026-10-29T00:00:00Z')/1000)};},async code(){return undefined;},async call(){return undefined;}};
  const u=await buildPoolUniverse(parseInventory(inventory),policy,reader,Date.parse('2026-10-29T00:00:30Z'));
  const reasons=u.rejected.map(r=>r.reason);
  assert.equal(reasons[0],'NOT_EVM_CONTRACT');
  assert.equal(reasons[2],'DUPLICATE');
  assert.equal(u.pools.length,0);
  marker(1,{baselineRejects:reasons});
});

test('FLASHLOAN_V7_EDGE_02 economics: shared uint256/rounding/strict-threshold/accounting vectors',()=>{
  for(const v of vectors.uint){
    assert.equal(schema(v.def??'Uint')(v.value),v.schemaValid,JSON.stringify(v));
    if(v.schemaValid&&v.def!=='Int') v.semanticValid?uint(v.value):assert.throws(()=>uint(v.value),/INTEGER_OUT_OF_RANGE/);
  }
  const c=vectors.nativeToRepayment;
  const num=BigInt(c.nativeRaw)*BigInt(c.nativeUsdUpper.num)*BigInt(c.repaymentUsdLower.den)*10n**BigInt(c.repaymentDecimals);
  const den=BigInt(c.nativeUsdUpper.den)*BigInt(c.repaymentUsdLower.num)*10n**BigInt(c.nativeDecimals);
  assert.ok(num%den!==0n);
  assert.equal(ceilDiv(num,den).toString(),c.expectedUpperRaw);
  assert.equal(nativeToRepaymentUpper(BigInt(c.nativeRaw),{numerator:c.nativeUsdUpper.num,denominator:c.nativeUsdUpper.den},{numerator:c.repaymentUsdLower.num,denominator:c.repaymentUsdLower.den},c.nativeDecimals,c.repaymentDecimals).toString(),c.expectedUpperRaw,'implementation rounds up');
  const min=BigInt(vectors.threshold.minNetProfitRaw);
  for(const t of vectors.threshold.cases){
    assert.equal(BigInt(t.netLowerBoundRaw)>min,t.localExclusiveQualifies);
    assert.equal(BigInt(t.netLowerBoundRaw)>=BigInt(t.mcpInclusiveMinProfit),t.mcpInclusiveQualifies);
    assert.equal(t.localExclusiveQualifies,t.mcpInclusiveQualifies,'inclusive adapter receives threshold+1');
  }
  const s=vectors.contractMinSurplus;
  assert.equal((BigInt(s.minNetProfitRaw)+BigInt(s.networkCostUpperRaw)+BigInt(s.otherCostUpperRaw)+1n).toString(),s.expected);
  const a=vectors.accounting,n=(k:string)=>BigInt(a[k]);
  assert.equal(n('principalRaw'),n('deployedRaw')+n('unusedPrincipalRaw'));
  assert.equal(n('terminalBeforeDebtRaw'),n('swapProceedsRaw')+n('unusedPrincipalRaw'),'opening balance excluded');
  assert.equal(n('surplusAfterDebtRaw'),n('terminalBeforeDebtRaw')-n('principalRaw')-n('lenderFeeRaw'));
  assert.equal(n('netLowerBoundRaw'),n('surplusAfterDebtRaw')-n('networkCostUpperRaw')-n('otherCostUpperRaw'));
  for(const r of vectors.ratio) assert.ok(BigInt(r.den)===0n||BigInt(r.num)<=0n,r.reason);
  marker(2,{vectorsHash:`sha256:${createHash('sha256').update(read('schemas/examples/flashloan-integration-v1/vectors.json')).digest('hex')}`});
});

test('FLASHLOAN_V7_EDGE_03 admission bindings: domain-separated canonical hashes, no self-hash, legacy digest parity',()=>{
  const p=vectors.hash.canonicalParityWithLegacyDigest;
  assert.equal(digest(p.value),p.legacyDigestHex,'canonical bytes equal legacy digest preimage');
  const [first,...rest]=vectors.hash.domain;
  assert.equal(domainHash(first.domain,first.value),first.expected);
  for(const d of rest) assert.equal(domainHash(d.domain,d.value),d.expected,d.note);
  for(const d of vectors.hash.domain) assert.equal(implDomainHash(d.domain,d.value),domainHash(d.domain,d.value),'implementation matches the independent oracle');
  assert.equal(rest[0].expected,first.expected,'key order irrelevant');
  assert.notEqual(rest[1].expected,first.expected,'array order significant');
  assert.notEqual(rest[2].expected,first.expected,'domain separation');
  assert.throws(()=>domainHash('x',{n:2**53}),/UNSAFE_NUMBER/);
  assert.throws(()=>domainHash('x',{s:'\ud800'}),/INVALID_UNICODE/);
  assert.throws(()=>domainHash('x',{x:1.5}),/UNSAFE_NUMBER/);
  const manifest=json('schemas/flashloan-integration-v1.schema.json').$defs;
  assert.ok(!manifest.Plan.properties.planHash,'plan carries no self-hash');
  assert.equal(manifest.ExecutorManifest.properties.manifestHash.$ref,'#/$defs/Hash');
  marker(3);
});

test('FLASHLOAN_V7_EDGE_04 recovery: an unresolved reservation blocks any second send (reused EvmBudget)',async()=>{
  const signer='0x1111111111111111111111111111111111111111';
  const dir=await mkdtemp(join(tmpdir(),'v7-budget-'));
  const budget=new EvmBudget(4663,signer,dir);await budget.load();
  const h1=`0x${'01'.repeat(32)}` as const,h2=`0x${'02'.repeat(32)}` as const;
  await budget.reserve('trade',h1,1000n);
  await assert.rejects(budget.reserve('trade',h2,1000n),/UNRESOLVED_BUDGET_RESERVATION/);
  const reloaded=new EvmBudget(4663,signer,dir);await reloaded.load();
  assert.equal(reloaded.unresolved().length,1,'restart keeps the unknown attempt reserved');
  await assert.rejects(reloaded.reserve('trade',h2,1000n),/UNRESOLVED_BUDGET_RESERVATION/);
  marker(4);
});

test('FLASHLOAN_V7_EDGE_05 receipt truth: result statuses are the prompt v7 set and each maps to a legacy outcome',()=>{
  const statuses=json('schemas/flashloan-integration-v1.schema.json').$defs.Result.properties.status.enum as string[];
  const ledger=json('docs/features/flashloan-v7-integration.spec.json');
  assert.deepEqual([...statuses].sort(),Object.keys(ledger.resultStatusMap).sort());
  const legacy=new Set(['SIMULATED_OPPORTUNITY','NO_OPPORTUNITY','INCONCLUSIVE','COVERAGE_BLOCKED','INPUT_BLOCKED','POLICY_UNSUPPORTED','TOOL_ERROR','RECONCILED']);
  for(const [status,mapped] of Object.entries(ledger.resultStatusMap as Record<string,string|null>)) assert.ok(mapped===null||legacy.has(mapped),status);
  assert.equal(ledger.resultStatusMap.MODEL_OPPORTUNITY,null,'model-only is never a simulated opportunity');
  assert.deepEqual(RESULT_STATUS_MAP,ledger.resultStatusMap,'implementation map equals the ledger');
  assert.equal(ledger.resultStatusMap.SUBMITTED_UNKNOWN,null,'unknown receipt never maps to a realized outcome');
  marker(5);
});
