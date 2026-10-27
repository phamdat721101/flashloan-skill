// Local implementation evidence only. Public runtime admission is a separate gate.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Ajv2020} from 'ajv/dist/2020.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
const edges=[
 ['REORG','completed observations receive durable invalidation|source divergence|canonical ancestry'],
 ['DEADLINE','rejected, thrown, hanging|deadline and mismatched|watch operation deadlines'],
 ['BAND_INVALIDATION','band cache invalidates|band cache binds'],
 ['EVIDENCE_CLASS','pre-save gate|historical empty|coverage exhaustion|fabricated negative|fresh native results'],
 ['LESSON_GATE','integrity, reuse and approved lesson gate']
];
const markers=['FLASHLOAN_LOCAL_EDGE_01_REORG','FLASHLOAN_LOCAL_EDGE_02_DEADLINE','FLASHLOAN_LOCAL_EDGE_03_BAND_INVALIDATION','FLASHLOAN_LOCAL_EDGE_04_EVIDENCE_CLASS','FLASHLOAN_LOCAL_EDGE_05_LESSON_GATE'];
const args=process.argv.slice(2);assert.ok(!args.length||args.length===2&&args[0]==='--edge'&&/^EDGE-0[1-5]$/.test(args[1]));
const run=(cmd,args)=>{const p=spawnSync(cmd,args,{encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});assert.equal(p.status,0,p.stdout+p.stderr);return p.stdout;};
run('npm',['run','build']);
const ajv=new Ajv2020({strict:true,allErrors:true});
for(const path of ['schemas/flashloan-evidence-v5.schema.json','schemas/flashloan-evidence-v5.1.schema.json','schemas/flashloan-evidence-v5.1-additions.schema.json'])ajv.addSchema(JSON.parse(readFileSync(path,'utf8')));
for(const schema of Object.values(ajv.schemas))if(schema.schema.$id)ajv.getSchema(schema.schema.$id);
const results=[];
for(const [i,[name,pattern]]of edges.entries()){
 const edge=`EDGE-0${i+1}`;if(args.length&&args[1]!==edge)continue;
 const output=run('node',['--test','--test-reporter=tap',`--test-name-pattern=${pattern}`,'dist/test/flashloan-evidence.test.js','dist/test/flashloan-evidence-watcher.test.js']);
 assert.ok(new RegExp('^# Subtest: .*('+pattern+')','m').test(output),'no matching test assertions');
 const pass=Number(output.match(/^# pass (\d+)$/m)?.[1]);assert.ok(pass>0,'proof must execute assertions');assert.match(output,/^# fail 0$/m);
 const result={event:markers[i],success:true,scope:'local-implementation-only',testsPassed:pass,logHash:hash(output),publicNetworkAdmission:false};results.push(result);console.log(JSON.stringify(result));
}
mkdirSync('.nim/flashloan-implementation',{recursive:true});writeFileSync(`.nim/flashloan-implementation/edges-${args[1]??'all'}.json`,JSON.stringify(results,null,2));
