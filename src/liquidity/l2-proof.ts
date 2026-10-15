// Local, independently executed proof. This never reads a signer or sends a trade.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const files = [...readdirSync('src/liquidity').filter(f => f.startsWith('l2-') && f.endsWith('.ts')).map(f => `src/liquidity/${f}`),
  'src/liquidity/runtime.ts','src/liquidity/ingestion.ts','src/liquidity/state.ts','src/liquidity/journal.ts','src/liquidity/clmm.ts','src/liquidity/cetus-math.ts','src/liquidity/projection.ts','src/liquidity/v2.ts','src/execution-lock.ts','src/state-adapters.ts','src/sui/deepbook.ts','src/test/level-2-e2e.test.ts','schemas/level-2.schema.json','schemas/liquidity-analytics.schema.json','package.json','package-lock.json','tsconfig.json'].sort();
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const sourceDigest = hash(files.map(f => f+'\0'+readFileSync(f,'utf8')).join('\0'));
const compiled = files.filter(f => f.endsWith('.ts')).map(f => f.replace(/^src\//,'dist/').replace(/\.ts$/,'.js'));
const compiledDigest = hash(compiled.map(f => f+'\0'+readFileSync(f,'utf8')).join('\0'));
const run = spawnSync(process.execPath,['--test','--test-reporter=tap','dist/test/level-2-e2e.test.js'],{ encoding: 'utf8',timeout: 120000,maxBuffer: 8*1024*1024 });
mkdirSync('.nim/e2e',{ recursive: true });
const transcript = (run.stdout ?? '')+(run.stderr ?? '');
writeFileSync('.nim/e2e/level-2-local.tap',transcript);
const pass = Number(transcript.match(/# pass (\d+)/)?.[1] ?? 0), fail = Number(transcript.match(/# fail (\d+)/)?.[1] ?? 1), skip = Number(transcript.match(/# skipped (\d+)/)?.[1] ?? 1);
const unchanged = sourceDigest === hash(files.map(f => f+'\0'+readFileSync(f,'utf8')).join('\0')) && compiledDigest === hash(compiled.map(f => f+'\0'+readFileSync(f,'utf8')).join('\0'));
if (!unchanged || run.status !== 0 || !pass || fail || skip || !['EDGE-01','EDGE-02','EDGE-03','EDGE-04','EDGE-05'].every(id => transcript.includes(id))) {
  process.stderr.write('L2_LOCAL_PROOF_FAILED: inspect .nim/e2e/level-2-local.tap\n'); process.exitCode = 1;
} else {
  const evidence = { source: 'fresh node --test subprocess: .nim/e2e/level-2-local.tap',buildId: `sha256:${sourceDigest}`,compiledDigest: `sha256:${compiledDigest}`,target: 'Level 2 local contracts/replay/math/MCP/model/risk integration; public source and live execution admission excluded',timestamp: new Date().toISOString(),health: `${pass} passed, ${fail} failed, ${skip} skipped`,clientAcceptance: 'Executable assertions prove five local seam outcomes, receipt deduplication, chronological calibration/purge and exact unit/coverage boundaries',testArtifactSha256: hash(transcript),scope: 'local-only',productionAdmitted: false };
  writeFileSync('.nim/e2e/level-2-local-evidence.json',JSON.stringify(evidence,null,2)+'\n'); console.log(JSON.stringify(evidence));
}
