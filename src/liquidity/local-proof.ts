// Fresh subprocess evidence for the local delivery profile. This never signs or
// submits and must not be substituted for protocol-wide/live canary admission.
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const files = ['src/liquidity/v2.ts','src/liquidity/cetus-math.ts','src/liquidity/clmm.ts','src/liquidity/algebra.ts','src/liquidity/v4-simulation.ts','src/liquidity/projection.ts','src/liquidity/sizing.ts','src/liquidity/arbitrum.ts','src/liquidity/analytics.ts','src/liquidity/sources.ts','src/liquidity/ingestion.ts','src/liquidity/cli.ts','src/liquidity/state.ts','src/liquidity/runtime.ts','src/state-adapters.ts','src/sui/cetus.ts','src/sui/deepbook.ts','src/sui/route.ts','src/sui/flash-lenders.ts','contracts/V4StateQuoter.sol','contracts/MultiVenueArbitrageExecutor.sol','schemas/liquidity-analytics.schema.json','schemas/examples/cetus-reference-vectors.json'];
const sourceDigest = createHash('sha256').update(files.map(file => file + '\0' + readFileSync(file)).join('\0')).digest('hex');
const compiledDigest = createHash('sha256').update(files.filter(file => file.endsWith('.ts')).map(file => readFileSync(file.replace(/^src\//,'dist/').replace(/\.ts$/,'.js'))).join('\0')).digest('hex');
const result = spawnSync(process.execPath,['--test','--test-reporter=tap','dist/test/liquidity-analytics.test.js','dist/test/liquidity-sources.test.js','dist/test/liquidity-sui-analytics.test.js','dist/test/liquidity-algebra.test.js','dist/test/liquidity-clmm.test.js','dist/test/state-adapters.test.js'],{ encoding: 'utf8',timeout: 60000,maxBuffer: 4 * 1024 * 1024 });
const contracts = spawnSync('forge',['test','--match-contract','(MultiVenueArbitrageExecutorTest|V4StateQuoterTest)'],{ encoding: 'utf8',timeout: 60000,maxBuffer: 4 * 1024 * 1024 });
mkdirSync('.nim/e2e',{ recursive: true });
writeFileSync('.nim/e2e/liquid-formula-local.tap',result.stdout + result.stderr);
writeFileSync('.nim/e2e/liquid-formula-contracts.txt',contracts.stdout + contracts.stderr);
const pass = Number(result.stdout?.match(/# pass (\d+)/)?.[1] ?? 0), fail = Number(result.stdout?.match(/# fail (\d+)/)?.[1] ?? 1), skip = Number(result.stdout?.match(/# skipped (\d+)/)?.[1] ?? 1);
if (result.status !== 0 || !pass || fail || skip || contracts.status !== 0 || !/10 tests passed, 0 failed, 0 skipped/.test(contracts.stdout)) {
  console.error('LOCAL_EVIDENCE_TESTS_FAILED: inspect .nim/e2e/liquid-formula-local.tap'); process.exitCode = 1;
} else {
  const evidence = { source: 'fresh node --test and forge test subprocesses: .nim/e2e/liquid-formula-local.tap and liquid-formula-contracts.txt',buildId: 'sha256:' + sourceDigest,compiledDigest: 'sha256:' + compiledDigest,target: 'local analytics CLI/schema/math/source and EVM fixtures; production admission excluded',timestamp: new Date().toISOString(),health: `${pass} Node and 10 Solidity passed, 0 failed, 0 skipped`,clientAcceptance: 'Independent fixtures prove exact outputs, schema compatibility, BCS integrity, checkpoint bounds, quoter rollback, authenticated lender/Algebra callbacks and unsigned no-send handoff',testArtifactSha256: createHash('sha256').update(result.stdout + result.stderr + contracts.stdout + contracts.stderr).digest('hex'),scope: 'local-only',productionAdmitted: false };
  writeFileSync('.nim/e2e/liquid-formula-local-evidence.json',JSON.stringify(evidence,null,2) + '\n');
  console.log(JSON.stringify(evidence));
}
