// Offline specification proof. Reference assertions here are NOT runtime admission.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
const historicalSource = file => execFileSync('git', ['show', `e5177c1224978aa28e8278e74da426cd6f5e7c5f:${file}`], { encoding: 'utf8' });

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFileSync(new URL(file, `file://${root}`), 'utf8');
const json = file => JSON.parse(read(file));
const prdPath = 'docs/PRD-flashloan-evidence-driven-execution-upgrade-2026-10-26.md';
const prd = read(prdPath);
const brief = read('docs/features/flashloan-evidence-driven-execution.md');
const spec = json('docs/features/flashloan-evidence-driven-execution.spec.json');
const schema = json('schemas/flashloan-evidence-v5.schema.json');
const examples = spec.data_contracts.outputs.fixtures;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => hashBytes(JSON.stringify(canonical(value)));
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const clone = value => structuredClone(value);
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(schema);
const validator = name => ajv.getSchema(`${schema.$id}#/$defs/${name}`);
const valid = (name, value) => assert.ok(validator(name)(value), JSON.stringify(validator(name).errors));
const invalid = (name, value) => assert.equal(validator(name)(value), false, `${name} unexpectedly accepted invalid input`);

// Contract oracles independently express required future behavior. No RPC or signer exists here.
function searchContract(result) {
  const s = result.search;
  assert.equal(s.accepted + s.rejected + s.inflight, s.attempted);
  assert.ok(s.attempted <= s.maxAttempts && s.uniqueAmounts <= s.attempted && s.retries <= s.attempted);
  assert.equal(s.rejections.reduce((sum, item) => sum + item.count, 0), s.rejected);
  assert.ok(BigInt(s.quantumRaw) > 0n && BigInt(s.domainMaximumRaw) >= BigInt(s.domainMinimumRaw));
  assert.equal(result.planRef !== null, result.status === 'CANDIDATE_FOUND');
  if (['NO_OPPORTUNITY_IN_GRID', 'CERTIFIED_NO_OPPORTUNITY'].includes(result.status)) {
    assert.ok(s.coverageComplete && s.rejected === 0 && s.inflight === 0);
    const optimality = result.status === 'NO_OPPORTUNITY_IN_GRID' ? 'grid-complete' : 'domain-certified';
    assert.equal(s.optimality, optimality);
    assert.equal(s.termination, optimality);
    if (optimality === 'grid-complete') {
      assert.notEqual(s.gridPointCount, null);
      assert.ok(BigInt(s.gridPointCount) > 0n);
      assert.equal(BigInt(s.accepted), BigInt(s.gridPointCount));
    } else if (s.certificateRef === null) {
      assert.equal(BigInt(s.accepted), (BigInt(s.domainMaximumRaw) - BigInt(s.domainMinimumRaw)) / BigInt(s.quantumRaw) + 1n);
    } else {
      // This offline oracle has no mathematical certificate host adapter.
      assert.fail('unsupported skipped-region certificate');
    }
  }
}
function ledgerContract(l) {
  const n = key => BigInt(l[key]);
  assert.equal(n('principalRaw'), n('deployedRaw') + n('unusedPrincipalRaw'));
  assert.equal(n('terminalBeforeDebtRaw'), n('swapProceedsRaw') + n('unusedPrincipalRaw'));
  assert.equal(n('surplusAfterDebtRaw'), n('terminalBeforeDebtRaw') - n('principalRaw') - n('flashFeeRaw'));
  assert.equal(n('simulatedNetRaw'), n('surplusAfterDebtRaw') - n('networkCostRaw') - n('otherExternalCostsRaw'));
}
function planContract(plan) {
  assert.equal(plan.planHash, digest(without(plan, ['planHash'])));
  assert.equal(plan.branches.reduce((sum, branch) => sum + BigInt(branch.allocatedRaw), BigInt(plan.unusedPrincipalRaw)), BigInt(plan.principalRaw));
  for (const branch of plan.branches) {
    assert.equal(branch.tokenPath.length, branch.poolPath.length + 1);
    assert.equal(branch.hopCount, branch.poolPath.length);
    assert.deepEqual(branch.tokenPath[0], plan.borrowAsset);
    assert.deepEqual(branch.tokenPath.at(-1), plan.borrowAsset);
  }
}
function nativeContract(proof, plan, expectedPayloadHash, nowNs) {
  for (const key of ['stateDigest', 'policyHash', 'executionContextHash']) assert.equal(proof[key], plan[key]);
  assert.equal(proof.candidateHash, plan.planHash);
  assert.equal(proof.payloadHash, expectedPayloadHash);
  assert.equal(proof.executorCodeOrPackageHash, examples.proof.executorCodeOrPackageHash);
  assert.equal(proof.adapterRevision, examples.proof.adapterRevision);
  assert.equal(proof.resultEvidence.kind, 'native-simulation');
  assert.equal(proof.fidelity, 'existing-native');
  assert.equal(proof.overrideRefs.length, 0);
  assert.ok(proof.success && proof.repaymentProven && proof.terminalBalanceBasis !== 'unknown');
  assert.notEqual(proof.resultEvidence.expiresAtNs, null);
  assert.ok(BigInt(proof.resultEvidence.observedAtNs) <= nowNs && BigInt(proof.resultEvidence.expiresAtNs) > nowNs);
  assert.ok(plan.unsignedPayloadRef);
  assert.ok(plan.costs.every(cost => cost.basis !== 'research-assumption' && cost.amountRaw.value !== null));
}

const checks = [
  async () => {
    const defs = { request: 'RunRequest', policy: 'Policy', state: 'StateBundle', inventory: 'Inventory', plan: 'Plan', solver: 'SolverResult', proof: 'NativeProof', ledger: 'Ledger', report: 'Report', event: 'StageEvent' };
    const rootValidator = ajv.getSchema(schema.$id);
    for (const [name, def] of Object.entries(defs)) {
      valid(def, examples[name]);
      assert.ok(rootValidator(examples[name]), JSON.stringify(rootValidator.errors));
      invalid(def, { ...examples[name], unexpected: true });
      invalid(def, { ...examples[name], schemaVersion: '4.0' });
    }
    invalid('Ledger', { ...examples.ledger, principalRaw: 1000 });
    invalid('Ledger', { ...examples.ledger, principalRaw: '01' });
    invalid('Ratio', { numerator: '1', denominator: '0' });
    invalid('RunRequest', { ...examples.request, mode: 'authorized-execution' });
    const missingContext = clone(examples.request); delete missingContext.executor;
    invalid('RunRequest', missingContext);
    valid('Report', { ...examples.report, policyHash: null });
    valid('Inventory', examples.inventory); // Unknown metadata is structurally representable.
    invalid('Asset', { ...examples.plan.borrowAsset, decimals: null });
    invalid('Plan', { ...examples.plan, netProfitRaw: { value: null, reason: null } });
    invalid('Search', { ...examples.solver.search, inflight: -1 });
  },
  async () => {
    const source = historicalSource('src/adaptive-sizing.ts'); // Preserve the original defect reproduction after migration.
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    const { optimizeTradeSize } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
    const seen = [];
    await assert.rejects(optimizeTradeSize({ minAmount: 1n, maxAmount: 100n, maxEvaluations: 6, maxPriceImpactBps: 100 }, async amountIn => {
      seen.push(String(amountIn));
      if (seen.length > 12) throw new Error('SPEC_HOST_GUARD');
      if (amountIn === 62n) return undefined;
      return { amountIn, netProfitUsd: 100 - Math.abs(Number(amountIn) - 50), priceImpactBps: 1, quoteBlock: 1n };
    }), /SPEC_HOST_GUARD/);
    assert.equal(seen.length, 13);
    assert.equal(seen.filter(amount => amount === '62').length, 8);
    searchContract(examples.solver);
    const negative = { ...clone(examples.solver), status: 'INCONCLUSIVE', planRef: null };
    searchContract(negative);
    for (const [status, optimality] of [['NO_OPPORTUNITY_IN_GRID', 'grid-complete'], ['CERTIFIED_NO_OPPORTUNITY', 'domain-certified']]) {
      const result = { ...clone(negative), status };
      assert.throws(() => searchContract(result));
      Object.assign(result.search, { optimality, termination: optimality, gridPointCount: '1', domainMaximumRaw: result.search.domainMinimumRaw });
      searchContract(result);
      Object.assign(result.search, { accepted: 0, rejected: 1, rejections: [{ code: 'COVERAGE_BLOCKED', count: 1 }] });
      assert.throws(() => searchContract(result));
    }
    for (const mutation of [{ attempted: 7 }, { inflight: 1 }, { retries: 2 }, { quantumRaw: '0' }]) {
      const result = clone(examples.solver); Object.assign(result.search, mutation);
      assert.throws(() => searchContract(result));
    }
  },
  async () => {
    const l = clone(examples.ledger);
    ledgerContract(l);
    assert.equal(l.simulatedNetRaw, '8500000');
    assert.equal(l.realizedNetRaw.value, null);
    for (const field of ['operatorPrefundRaw', 'executorOpeningBalanceRaw']) {
      const prefunded = { ...l, [field]: '100000000' };
      ledgerContract(prefunded); assert.equal(prefunded.simulatedNetRaw, l.simulatedNetRaw);
    }
    assert.throws(() => ledgerContract({ ...l, terminalBeforeDebtRaw: '1060000000' }));
    assert.equal(45000000000000000000n - 43118208000000000000n - (45000000000000000000n - 43118208000000000000n - 1800000000000000000n), 1800000000000000000n);
    for (const [hn, hd, ln, ld, decimals] of [[10n, 1n, 1n, 1n, 6n], [10n, 1n, 3n, 1n, 6n], [1n, 3n, 2n, 7n, 18n]]) {
      const numerator = hn * ld * 10n ** decimals, denominator = hd * ln;
      const exclusive = numerator / denominator, inclusive = exclusive + 1n;
      assert.ok(exclusive * denominator <= numerator && inclusive * denominator > numerator);
    }
    planContract(examples.plan);
    assert.throws(() => planContract({ ...examples.plan, unusedPrincipalRaw: '0' }));
    const policy = examples.policy;
    assert.equal(policy.policyHash, digest(without(policy, ['policyHash', 'runId'])));
    assert.notEqual(policy.policyHash, digest({ ...without(policy, ['policyHash', 'runId']), maxAttempts: 5 }));
    assert.throws(() => nativeContract(examples.proof, examples.plan, examples.proof.payloadHash, 2n));
    // Synthetic contract oracle only: this does not authenticate any native source.
    const plan = clone(examples.plan); plan.costs[0].basis = 'fee-estimate';
    const proof = { ...clone(examples.proof), fidelity: 'existing-native', overrideRefs: [], resultEvidence: { ...examples.proof.resultEvidence, expiresAtNs: '3' } };
    nativeContract(proof, plan, proof.payloadHash, 2n);
    for (const field of ['stateDigest', 'policyHash', 'executionContextHash', 'candidateHash', 'payloadHash', 'executorCodeOrPackageHash', 'adapterRevision']) {
      assert.throws(() => nativeContract({ ...proof, [field]: '0'.repeat(64) }, plan, proof.payloadHash, 2n));
    }
    assert.throws(() => nativeContract(proof, plan, proof.payloadHash, 3n));
    assert.throws(() => nativeContract({ ...proof, resultEvidence: { ...proof.resultEvidence, kind: 'counterfactual-model' } }, plan, proof.payloadHash, 2n));
  },
  async () => {
    let baselineCount = 0;
    for (const match of prd.matchAll(/\| `([^`]+)` \|[^\n]+\| `([a-f0-9]{64})` \|/g)) {
      assert.equal(hashBytes(historicalSource(match[1])), match[2], `Historical PRD baseline drift: ${match[1]}`); baselineCount++;
    }
    assert.equal(baselineCount, 23);
    for (const dependency of spec.dependencies) {
      const evidence = spec.source_evidence.find(e => e.source_uri === dependency.file_location && e.entity_id === dependency.symbol);
      assert.ok(evidence, `missing citation for ${dependency.symbol}`);
      const source = read(dependency.file_location);
      assert.equal(evidence.hash, `sha256:${hashBytes(source)}`);
      const ast = ts.createSourceFile(dependency.file_location, source, ts.ScriptTarget.Latest, true);
      assert.ok(ast.statements.some(node => node.name?.text === dependency.symbol && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)), `missing file-specific exported symbol: ${dependency.symbol}`);
    }
    const baseline = spec.source_evidence.find(e => e.source_uri === prdPath);
    assert.equal(baseline.hash, `sha256:${hashBytes(prd)}`);
    const { requirements, acceptance } = spec.data_contracts.inputs;
    assert.deepEqual(requirements.map(r => r.id), Array.from({ length: 16 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`));
    assert.deepEqual(acceptance.map(t => t.id), Array.from({ length: 42 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`));
    for (const r of requirements) {
      assert.equal(r.acceptanceStatus, 'pending'); assert.ok(acceptance.some(t => t.requirement === r.id));
      for (const field of ['stage', 'ownerRole', 'input', 'output', 'existingSeam', 'contract']) assert.ok(r[field]);
    }
    for (const t of acceptance) {
      assert.ok(requirements.some(r => r.id === t.requirement)); assert.equal(t.status, 'pending');
      assert.ok(t.plannedCommand.includes(t.requiredMarker) && t.plannedCommand.startsWith('node --test'));
      assert.ok(t.evidence.includes('non-skipped'));
      assert.ok(existsSync(new URL(t.testFile, `file://${root}`)) || t.testFile === 'src/test/flashloan-evidence-e2e.test.ts');
    }
    assert.equal(spec.data_contracts.outputs.runtimeAcceptance, 'pending');
    assert.ok(spec.dependencies.every(d => !spec.data_contracts.inputs.futureInterfaces.includes(d.symbol)));
  },
  async () => {
    const text = read('docs/features/flashloan-evidence-driven-execution-map.md');
    const maps = [...text.matchAll(/```json nim-deliver\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
    assert.equal(maps.length, 2);
    assert.equal(maps[0].featureId, 'flashloan-evidence-spec'); assert.equal(maps[0].status, 'Done');
    assert.equal(maps[1].featureId, 'flashloan-evidence-runtime'); assert.equal(maps[1].status, 'Draft');
    assert.deepEqual(maps[1].edgeProofs, []);
    for (let i = 0; i < 5; i++) {
      const proof = maps[0].edgeProofs[i];
      assert.equal(proof.edgeId, `EDGE-0${i + 1}`);
      assert.equal(proof.command, `node scripts/verify-flashloan-evidence-spec.mjs --edge EDGE-0${i + 1}`);
      assert.ok(proof.logMarker.startsWith(`FLASHLOAN_SPEC_EDGE_0${i + 1}_`));
      assert.ok(maps[0].seams.some(s => s.id === proof.seamId));
      assert.ok(proof.sourceFiles.every(file => existsSync(new URL(file, `file://${root}`))));
    }
    assert.equal(maps[0].edgeProofs.length, 5);
    for (const phrase of ['caller', 'executorMode', 'rotationMode', 'requestedMinBranchUsd', 'inventoryMinLiquidityUsd']) {
      assert.ok(schema.$defs.RunRequest.required.includes(phrase)); assert.ok(brief.includes(phrase));
    }
    assert.ok(brief.includes('deployment-only') || brief.includes('Deployment-only'));
    assert.ok(brief.includes('non-skipped') || spec.data_contracts.inputs.acceptance.every(t => t.evidence.includes('non-skipped')));
    assert.ok(brief.includes('linea_estimateGas') && brief.includes('`from`'));
    assert.ok(brief.includes('HANDOFF_REQUIRED') && brief.includes('owner approval'));
    assert.equal(brief.match(/^## .+$/gm).at(-1), '## GSTACK REVIEW REPORT');
    assert.equal(brief.trim().split('\n').at(-1), 'NO UNRESOLVED DECISIONS');
    for (const strategy of ['immutable', 'mutable', 'query -> hydrate', 'provisional', 'byte-identical']) assert.ok(brief.includes(strategy));
  }
];

const markers = ['SCHEMA', 'SEARCH', 'ECONOMICS', 'DEPENDENCIES', 'HANDOFF'];
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--edge' && /^EDGE-0[1-5]$/.test(args[1]), 'usage: verify-flashloan-evidence-spec.mjs [--edge EDGE-01..EDGE-05]');
for (let i = 0; i < checks.length; i++) {
  if (args.length && args[1] !== `EDGE-0${i + 1}`) continue;
  await checks[i]();
  console.log(JSON.stringify({ event: `FLASHLOAN_SPEC_EDGE_0${i + 1}_${markers[i]}`, success: true, scope: 'specification-only', runtimeAcceptance: 'pending' }));
}
