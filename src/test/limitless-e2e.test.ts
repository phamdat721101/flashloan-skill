import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FakeLimitlessExchange, FIXTURE_KEY, FEE } from './fixtures/limitless-exchange.js';
import { PredictionRuntime } from '../prediction/runtime.js';
import { PredictionLedger, positionsFrom } from '../prediction/ledger.js';
import { collateralFeeRaw, hash, policyHash, validate, type Mode, type Request, type Result, type TradeIntent, type TradePlan } from '../prediction/contracts.js';
import { verifyGrant } from '../prediction/config.js';

let sequence=0;
const intent=(f:FakeLimitlessExchange,overrides:Partial<TradeIntent>={}):TradeIntent=>({schemaVersion:'prediction-intent/1',intentId:`intent-${++sequence}`,accountId:f.config.accountId,marketSlug:'fixture-market',outcome:'YES',side:'BUY',orderType:'FAK',spendCapRaw:'1000000',limitPricePpm:400000,...overrides});
const request=(command:Request['command'],mode:Mode,payload:Record<string,unknown>={}):Request=>({schemaVersion:'prediction-request/1',requestId:`req-${++sequence}`,command,payload:{mode,...payload}});
const run=(f:FakeLimitlessExchange,command:Request['command'],mode:Mode,payload:Record<string,unknown>={})=>new PredictionRuntime(f.config).run(request(command,mode,payload));
function plan(result:Result):TradePlan {assert.equal(result.outcome,'ok',JSON.stringify(result));return(result.data as {plan:TradePlan}).plan;}
const order=(result:Result):any=>{assert(result.data,JSON.stringify(result));return(result.data as any).order;};
const markers:Record<string,string>={'01':'limitless_edge_01_verified','02':'limitless_edge_02_verified','03':'limitless_edge_03_verified','04':'limitless_edge_04_verified','05':'limitless_edge_05_verified'};
const marker=(id:string)=>console.log(JSON.stringify({marker:markers[id],fidelity:'fixture',liveTrading:false}));
async function cli(f:FakeLimitlessExchange,input:Request):Promise<Result>{
 const child=spawn(process.execPath,[fileURLToPath(new URL('../prediction/cli.js',import.meta.url)),'--config',f.configPath,'--fixture'],{env:process.env,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.stdin.end(JSON.stringify(input));
 const timer=setTimeout(()=>child.kill(),15000);try{await new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('close',()=>resolve());});}finally{clearTimeout(timer);}
 assert.equal(stderr,'');assert(stdout.trim(),stderr);return validate('ResultEnvelope',JSON.parse(stdout));
}

test('EDGE-01 provider identity, schemas, paper isolation and unit gates',async t=>{
 const f=await new FakeLimitlessExchange().start();t.after(()=>f.close());
 assert.throws(()=>validate('CommandRequest',{...request('markets','paper'),unknown:true}));
 assert.throws(()=>validate('CommandRequest',request('execute','assisted',{planHash:'not-a-hash',grant:{approved:true}})));
 assert.throws(()=>validate('TradeIntent',{...intent(f),orderType:'FOK'}));
 assert.throws(()=>validate('TradeIntent',{...intent(f),spendCapRaw:1.5}));
 const saved=process.env.LIMITLESS_TEST_KEY_FILE;process.env.LIMITLESS_TEST_KEY_FILE='/nonexistent-do-not-load-in-paper';
 const p=plan(await run(f,'prepare','paper',{intent:intent(f)}));const r=await run(f,'execute','paper',{planHash:p.planHash});assert.equal(order(r).fills[0].fidelity,'paper');
 process.env.LIMITLESS_TEST_KEY_FILE=saved;
 assert.equal(f.requests.some(r=>r.authenticated),false);assert.equal(f.orders.size,0);assert.equal(f.receipts.size,0);
 f.chainId=1;const doctor=await run(f,'doctor','paper',{publicOnly:true});assert.equal((doctor.data as any).ready,false);f.chainId=8453;
 f.walletMode='smartWallet';assert.equal((await run(f,'prepare','assisted',{intent:intent(f)})).errors[0].code,'WALLET_MODE_MISMATCH');f.walletMode='eoa';
 const q=plan(await run(f,'prepare','assisted',{intent:intent(f)}));f.code='0x6000';assert.equal((await run(f,'execute','assisted',{planHash:q.planHash,grant:f.grant(q)})).errors[0].code,'DEPLOYMENT_CODE_DRIFT');assert.equal(f.orders.size,0);
 marker('01');
});

test('EDGE-02 SDK amounts, collateral/legacy fees, NegRisk and bounded approvals',async t=>{
 const f=await new FakeLimitlessExchange().start();t.after(()=>f.close());
 assert.equal(collateralFeeRaw(40_000_000n,100_000_000n,500),1_200_000n);
 const p=plan(await run(f,'prepare','assisted',{intent:intent(f)}));assert.equal(p.order.feeRateBps,0);assert.equal(p.order.makerAmount,1000000);assert.equal(p.order.takerAmount,2500000);assert(BigInt(p.reserveRaw)>1000000n);assert.equal(p.order.expiration,'0');assert.equal(p.order.nonce,0);
 const same=plan(await run(f,'prepare','assisted',{intent:p.intent}));assert.equal(same.planHash,p.planHash);
 assert.equal((await run(f,'prepare','paper',{intent:intent(f,{limitPricePpm:400001})})).errors[0].code,'PRICE_TICK_INVALID');
 assert.equal((await run(f,'prepare','paper',{intent:intent(f,{spendCapRaw:'100000000000000000000'})})).outcome,'blocked');
 f.collateral=false;f.negrisk=true;const q=plan(await run(f,'prepare','assisted',{intent:intent(f)}));assert.equal(q.market.type,'negrisk');assert.equal(q.order.feeRateBps,300);assert.equal(q.feeAsset,'SHARES');
 f.collateral=true;f.allApproved=false;const a=plan(await run(f,'prepare','assisted',{intent:intent(f)}));assert(a.approvals.some(c=>c.spender===FEE));assert(a.approvals.every(c=>BigInt(c.amountRaw)<2n**255n));
 const grant=f.grant(a);let r=await run(f,'execute','assisted',{planHash:a.planHash,grant});assert.equal((r.data as any).kind,'chain');assert.equal(f.nonce,1);
 await run(f,'reconcile','assisted');r=await run(f,'execute','assisted',{planHash:a.planHash,grant});assert.equal((r.data as any).kind,'chain');assert.equal(f.nonce,2);
 await run(f,'reconcile','assisted');r=await run(f,'execute','assisted',{planHash:a.planHash,grant});assert.equal(order(r).state,'filled');assert.equal(f.nonce,2);
 marker('02');
});

test('EDGE-03 independent owner grants are required before signing or posting',async t=>{
 const f=await new FakeLimitlessExchange().start();t.after(()=>f.close());
 const p=plan(await run(f,'prepare','assisted',{intent:intent(f)}));
 assert.equal((await run(f,'execute','assisted',{planHash:p.planHash})).outcome,'blocked');
 const grant=f.grant(p),tampered={...grant,limits:{...grant.limits,maxOrderSpendRaw:'999999999'}};
 assert.equal((await run(f,'execute','assisted',{planHash:p.planHash,grant:tampered})).errors[0].code,'AUTHORITY_INVALID_SIGNATURE');
 const expired=f.grant(p,{issuedAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()-1000).toISOString()});
 assert.equal((await run(f,'execute','assisted',{planHash:p.planHash,grant:expired})).errors[0].code,'AUTHORITY_EXPIRED');
 const small=f.grant(p,{limits:{...grant.limits,maxOrderSpendRaw:'1'}});assert.equal((await run(f,'execute','assisted',{planHash:p.planHash,grant:small})).errors[0].code,'RISK_BUDGET_EXHAUSTED');
 const other=f.grant(p,{planHash:hash('other',{})});assert.equal((await run(f,'execute','assisted',{planHash:p.planHash,grant:other})).errors[0].code,'PLAN_UNAUTHORIZED');
 assert.equal(f.orders.size,0);assert.equal(f.nonce,0);
 const autonomous=plan(await run(f,'prepare','autonomous',{intent:intent(f)}));const session=f.grant(autonomous);assert.equal(session.kind,'session');assert.equal(order(await run(f,'execute','autonomous',{planHash:autonomous.planHash,grant:session})).state,'filled');
 assert.throws(()=>verifyGrant({...f.config,limits:{...f.config.limits,maxDailyLossRaw:'1'}},session,'trade','autonomous',Date.now(),autonomous));
 marker('03');
});

test('EDGE-04 real SDK CLI restart, lost acceptance, delayed/partial fills and cancel race',async t=>{
 const f=await new FakeLimitlessExchange().start();t.after(()=>f.close());
 const p=plan(await cli(f,request('prepare','assisted',{intent:intent(f)})));f.dropSubmit=true;
 const first=await cli(f,request('execute','assisted',{planHash:p.planHash,grant:f.grant(p)}));assert.equal(first.outcome,'pending');assert.equal(f.orders.size,1);
 const recovered=await cli(f,request('reconcile','assisted',{clientOrderId:p.clientOrderId}));assert.equal(order(recovered).state,'filled');
 await cli(f,request('execute','assisted',{planHash:p.planHash}));assert.equal(f.requests.filter(r=>r.method==='POST'&&r.path==='/orders').length,1);
 assert(!JSON.stringify(recovered).includes(FIXTURE_KEY));assert(!JSON.stringify(recovered).includes(f.tokenSecret));assert(!JSON.stringify(recovered).includes('signature'));
 f.fillNumerator=1n;f.fillDenominator=2n;const partial=plan(await run(f,'prepare','assisted',{intent:intent(f)}));const pr=await run(f,'execute','assisted',{planHash:partial.planHash,grant:f.grant(partial)});assert.equal(order(pr).state,'cancelled');assert.equal(order(pr).fills[0].usdGrossRaw,'500000');
 f.fillDenominator=1n;f.delay=true;const delayed=plan(await run(f,'prepare','assisted',{intent:intent(f)}));assert.equal(order(await run(f,'execute','assisted',{planHash:delayed.planHash,grant:f.grant(delayed)})).settlement,'delayed');f.delay=false;f.fill(delayed.clientOrderId);await run(f,'reconcile','assisted');
 const resting:TradeIntent={schemaVersion:'prediction-intent/1',intentId:`intent-${++sequence}`,accountId:f.config.accountId,marketSlug:'fixture-market',outcome:'YES',side:'BUY',orderType:'GTC',sharesRaw:'1000000',limitPricePpm:300000,postOnly:true};
 const gtc=plan(await run(f,'prepare','assisted',{intent:resting}));const g=f.grant(gtc);assert.equal(order(await run(f,'execute','assisted',{planHash:gtc.planHash,grant:g})).state,'open');
 f.cancelRace=true;const cancelled=await run(f,'cancel','assisted',{clientOrderId:gtc.clientOrderId,grant:g});assert.equal(order(cancelled).state,'cancelled');assert(order(cancelled).fills.length>0);
 const state=await new PredictionRuntime(f.config).ledger('assisted').state();assert(positionsFrom(state).some(p=>BigInt(p.sharesRaw)>0n));
 marker('04');
});

test('EDGE-05 FIFO, receipt deduplication, redemption, corruption and evidence conflicts',async t=>{
 const f=await new FakeLimitlessExchange().start();t.after(()=>f.close());f.negrisk=true;
 const buy=plan(await run(f,'prepare','assisted',{intent:intent(f)}));await run(f,'execute','assisted',{planHash:buy.planHash,grant:f.grant(buy)});await run(f,'reconcile','assisted');
 let positions=(await run(f,'positions','assisted')).data as any;assert.equal(positions.positions[0].sharesRaw,'2500000');assert.equal(positions.positions[0].costBasisRaw,'1030000');
 const sell:TradeIntent={schemaVersion:'prediction-intent/1',intentId:`intent-${++sequence}`,accountId:f.config.accountId,marketSlug:'fixture-market',outcome:'YES',side:'SELL',orderType:'FAK',sharesCapRaw:'1000000',limitPricePpm:400000};
 f.bookBid=0.4;const sp=plan(await run(f,'prepare','assisted',{intent:sell}));assert.equal(order(await run(f,'execute','assisted',{planHash:sp.planHash,grant:f.grant(sp)})).state,'filled');
 positions=(await run(f,'positions','assisted')).data as any;assert.equal(positions.positions[0].realizedPnlRaw,'-24000');assert.equal(positions.positions[0].costBasisRaw,'618000');
 f.resolved=true;const claim=await run(f,'redeem','autonomous',{marketSlug:'fixture-market',grant:f.grant()});assert.equal((claim.data as any).kind,'chain',JSON.stringify(claim));await run(f,'reconcile','assisted');
 positions=(await run(f,'positions','assisted')).data as any;assert.equal(positions.positions[0].sharesRaw,'0');assert.equal(positions.positions[0].realizedPnlRaw,'858000');
 const ledger=new PredictionRuntime(f.config).ledger('assisted');const raw=await readFile(ledger.path,'utf8');assert(!raw.includes(FIXTURE_KEY));assert(!raw.includes(f.tokenSecret));
 await appendFile(ledger.path,'{');assert.equal((await run(f,'positions','assisted')).outcome,'blocked');await writeFile(ledger.path,raw);
 f.invalidStatus=true;await run(f,'reconcile','assisted');assert.equal((await ledger.state()).halted,false);assert.equal(f.orders.size,2); // Settled history is not queried again.
 marker('05');
});

test('recovery retains authority, restores dead locks and completes paper redemption',async t=>{
 const f=await new FakeLimitlessExchange().start();t.after(()=>f.close());
 f.allApproved=false;const p=plan(await run(f,'prepare','assisted',{intent:intent(f)}));const grant=f.grant(p);
 assert.equal((await run(f,'execute','assisted',{planHash:p.planHash,grant})).outcome,'pending');
 await run(f,'reconcile','assisted');
 const changed=f.grant(p,{grantId:'different-grant'});
 assert.equal((await run(f,'execute','assisted',{planHash:p.planHash,grant:changed})).errors[0].code,'RESERVATION_AUTHORITY_CHANGED');
 assert.equal(f.orders.size,0);
 const ledger=new PredictionRuntime(f.config).ledger('paper');
 await run(f,'halt','paper',{reason:'recovery-test'});await writeFile(ledger.path+'.lock','2147483647\n');
 assert.equal((await run(f,'resume','paper')).outcome,'ok');
 await writeFile(ledger.path+'.lock',`${process.pid}\n`);
 assert.equal((await run(f,'resume','paper')).outcome,'blocked');
 const {unlink}=await import('node:fs/promises');await unlink(ledger.path+'.lock');
 const paper=plan(await run(f,'prepare','paper',{intent:intent(f)}));await run(f,'execute','paper',{planHash:paper.planHash});
 f.resolved=true;const redeemed=await run(f,'redeem','paper',{marketSlug:'fixture-market'});
 assert.equal(redeemed.outcome,'ok',JSON.stringify(redeemed));assert((redeemed.data as any).positions.every((p:any)=>p.sharesRaw==='0'));
 assert.equal(f.orders.size,0);assert.equal(f.nonce,1);
 f.config.enabled=false;assert.equal((await run(f,'positions','paper')).outcome,'ok');
});

 test('unknown active status blocks exposure and requires owner recovery',async t=>{
 const f=await new FakeLimitlessExchange().start();t.after(()=>f.close());
 const resting={...intent(f),orderType:'GTC',postOnly:true,limitPricePpm:300000,sharesRaw:'1000000'}; delete (resting as Partial<TradeIntent>).spendCapRaw;
 const p=plan(await run(f,'prepare','assisted',{intent:resting}));
 await run(f,'execute','assisted',{planHash:p.planHash,grant:f.grant(p)});f.invalidStatus=true;
 await run(f,'reconcile','assisted');assert.equal((await new PredictionRuntime(f.config).ledger('assisted').state()).halted,true);
 });

test('installed skill carries the exact schema pin and prediction routing',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createHash}=await import('node:crypto');
 const target=await mkdtemp(join(tmpdir(),'prediction-skill-'));t.after(()=>rm(target,{recursive:true,force:true}));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../agent-cli.js',import.meta.url)),'install','--target',target],{stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',c=>stderr+=c);assert.equal(await new Promise(r=>child.on('close',r)),0,stderr);
 const schema=await readFile(join(target,'flashloan-agent/contracts/prediction-v1.schema.json'));
 const manifest=JSON.parse(await readFile(join(target,'flashloan-agent/contracts/prediction-schema-version.json'),'utf8'));
 assert.equal(createHash('sha256').update(schema).digest('hex'),manifest.sha256);
 assert.equal(Buffer.compare(schema,await readFile('schemas/prediction-v1.schema.json')),0);
 assert((await readFile(join(target,'flashloan-agent/SKILL.md'),'utf8')).includes('prediction.md'));
 assert((await readFile(join(target,'flashloan-agent/prediction.md'),'utf8')).includes('FAK'));
});

test('settled status requires canonical fills even without matched flag',async t=>{
 const f=await new FakeLimitlessExchange().start();t.after(()=>f.close());
 const resting={...intent(f),orderType:'GTC',postOnly:true,limitPricePpm:300000,sharesRaw:'1000000'};delete (resting as Partial<TradeIntent>).spendCapRaw;
 const p=plan(await run(f,'prepare','assisted',{intent:resting}));
 await run(f,'execute','assisted',{planHash:p.planHash,grant:f.grant(p)});
 const stored=f.orders.get(p.clientOrderId)!;stored.execution={settlementStatus:'CONFIRMED'};
 const result=await run(f,'reconcile','assisted',{clientOrderId:p.clientOrderId});assert.equal(result.outcome,'pending');
 const state=await new PredictionRuntime(f.config).ledger('assisted').state();assert.equal(state.orders.get(p.clientOrderId)!.submission,'acceptance-unknown');
});

test('losing resolved inventory burns for zero payout and realizes cost',async t=>{
 const f=await new FakeLimitlessExchange().start();t.after(()=>f.close());
 const p=plan(await run(f,'prepare','assisted',{intent:intent(f,{outcome:'NO',limitPricePpm:700000,spendCapRaw:'700000'})}));
 const fill=await run(f,'execute','assisted',{planHash:p.planHash,grant:f.grant(p)});assert.equal(order(fill).state,'filled');
 f.resolved=true;assert.equal((await run(f,'redeem','autonomous',{marketSlug:'fixture-market',grant:f.grant()})).outcome,'pending');
 await run(f,'reconcile','assisted');const positions=(await run(f,'positions','assisted')).data as any;
 assert.equal(positions.positions[0].sharesRaw,'0');assert(BigInt(positions.positions[0].realizedPnlRaw)<0n);
});

test('REST book raw units preserve depth and reward minimum never gates smaller trades',async t=>{
 const f=await new FakeLimitlessExchange().start();t.after(()=>f.close());
 const runtime=new PredictionRuntime(f.config),market=await runtime.provider.market('fixture-market');
 f.bookSizeRaw=150000000;f.minRewardSizeRaw='100000000';
 let book=await runtime.provider.book(market,'YES');
 assert.equal(book.asks[0].sharesRaw,'150000000');assert.equal(book.minRewardSharesRaw,'100000000');assert.equal(book.asks[0].pricePpm,400000);
 const no=await runtime.provider.book(market,'NO');assert.equal(no.bids[0].pricePpm,600000);assert.equal(no.bids[0].sharesRaw,'150000000');
 f.bookSizeRaw='9007199254740993';f.minRewardSizeRaw=100000000;
 book=await runtime.provider.book(market,'YES');assert.equal(book.asks[0].sharesRaw,'9007199254740993');assert.equal(book.minRewardSharesRaw,'100000000');
 f.bookSizeRaw=Number.MAX_SAFE_INTEGER+1;await assert.rejects(()=>runtime.provider.book(market,'YES'));
 f.bookSizeRaw='1.5';await assert.rejects(()=>runtime.provider.book(market,'YES'));
 f.bookSizeRaw='-1';await assert.rejects(()=>runtime.provider.book(market,'YES'));
 f.bookSizeRaw=(1n<<256n).toString();await assert.rejects(()=>runtime.provider.book(market,'YES'));
 f.bookSizeRaw=1000000; // Only one share visible, while the reward threshold is 100.
 const p=plan(await run(f,'prepare','paper',{intent:intent(f)}));
 const filled=order(await run(f,'execute','paper',{planHash:p.planHash}));assert.equal(filled.state,'cancelled');assert.equal(filled.fills[0].sharesGrossRaw,'1000000');assert.equal(filled.fills[0].usdGrossRaw,'400000');
});
