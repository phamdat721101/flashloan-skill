// Offline verification of the specification package, not an Aero execution test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(new URL(path, `file://${root}`), 'utf8');
const spec = JSON.parse(read('docs/features/aero-split-routing.spec.json'));
const { inputs, outputs } = spec.data_contracts;
const ajv = new Ajv({ allErrors: true, strict: true });
const request = ajv.compile(inputs.requestSchema);
const result = ajv.compile(outputs.resultSchema);
const valid = (validator, value) => assert.ok(validator(value), JSON.stringify(validator.errors));
const ceil = (n, d) => (n + d - 1n) / d;
const digest = value => {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
};
const classic = (x, y, a, b) => {
  const fee = a * b / 10000n, net = a - fee;
  return { out: y * net / (x + net), nextX: x + net, fee };
};
const markers = ['AERO_SPEC_EDGE_01', 'AERO_SPEC_EDGE_02', 'AERO_SPEC_EDGE_03', 'AERO_SPEC_EDGE_04', 'AERO_SPEC_EDGE_05'];
const checks = [
  () => {
    valid(request, inputs.example);
    for (const example of [outputs.selectedExample, outputs.rejectedExample, outputs.noProfitExample]) valid(result, example);
    for (const mutate of [x => { x.identity.chainId = 10; }, x => { x.bounds.quantum = '0'; }, x => { x.bounds.maximum = 9007199254740992; }, x => { x.extra = true; }]) {
      const bad = structuredClone(inputs.example); mutate(bad); assert.equal(request(bad), false);
    }
    const bad = { ...outputs.rejectedExample, calldata: '0x' }; assert.equal(result(bad), false);
    const unknownFee = structuredClone(inputs.example); unknownFee.pools[0].state.feeBps = 10000;
    assert.equal(request(unknownFee), false);
    const stable = structuredClone(inputs.example);
    stable.pools[0].state.protocol = 'aero-stable'; stable.pools[0].state.stable = true;
    stable.pools[0].decimals0 = 6; stable.pools[0].decimals1 = 18;
    valid(request, stable);
    const cl = structuredClone(inputs.example);
    cl.pools[0].generation = 'cl-gauges-v3';
    cl.pools[0].state = { protocol: 'aero-slipstream', sqrtPriceX96: '79228162514264337593543950336',
      tick: 0, liquidity: '1000', tickSpacing: 1, feePips: 100, unlocked: true,
      lowerTick: -1, upperTick: 1, bitmapWords: [{ wordPosition: -1, bitmap: '0' }, { wordPosition: 0, bitmap: '0' }],
      initializedTicks: [], feeProfile: 'fixed-proven', feeEvidenceDigest: '2'.repeat(64) };
    valid(request, cl); // Shape-only example; coverage is a separate semantic check.
    cl.pools[0].state.sqrtPriceX96 = 2 ** 96; assert.equal(request(cl), false);
  },
  () => {
    assert.deepEqual(classic(1000n, 1000000n, 1n, 30n), { out: 999n, nextX: 1001n, fee: 0n });
    assert.equal(1n * 9970n * 1000000n / (1000n * 10000n + 9970n), 996n);
    assert.equal((1n << 96n).toString(), '79228162514264337593543950336');
    assert.equal((1n << 96n) ** 2n / (1n << 192n), 1n);
    // Independent continuous comparison: 2*1000*100/1100 > 1000*200/1200.
    assert.ok(200000n * 1200n > 200000n * 1100n);
    // Tiny exhaustive allocation oracle: exact native floors can create ties.
    const returns = Array.from({ length: 201 }, (_, i) => {
      const a = BigInt(i); return classic(1000n, 1000n, a, 0n).out + classic(1000n, 1000n, 200n - a, 0n).out;
    });
    const best = returns.reduce((a, b) => a > b ? a : b);
    assert.equal(returns[100], 180n); assert.equal(best, 181n);
    assert.ok(best > returns[0]); // The continuous stationary point is not an integer certificate.
    assert.equal(ceil(10n * 3n, 7n), 5n);
  },
  () => {
    const x = outputs.selectedExample, b = inputs.example;
    assert.equal(x.requestDigest, digest(b));
    assert.equal(x.snapshotDigest, digest({ identity: b.identity, pins: b.pins, pools: b.pools }));
    assert.equal(x.allocations.reduce((a, v) => a + BigInt(v.amountIn), 0n), BigInt(x.principal));
    assert.equal(x.allocations.reduce((a, v) => a + v.ratioBps, 0), 10000);
    assert.equal(BigInt(x.repayment), BigInt(x.principal) + BigInt(x.flashFee));
    assert.equal(BigInt(x.netProfit), BigInt(x.terminalReturn) - BigInt(x.repayment) - BigInt(x.costInBorrowAsset));
    assert.ok(BigInt(x.minProfit) >= BigInt(x.costInBorrowAsset) + BigInt(b.bounds.minNetProfit));
    assert.ok(BigInt(x.terminalReturn) >= BigInt(x.repayment) + BigInt(x.minProfit));
    const first = classic(1000n, 2000n, 100n, 30n);
    assert.equal(first.out.toString(), x.allocations[0].legs[0].amountOut);
    const back = first.out * 997n * 1000n / (1000n * 1000n + first.out * 997n);
    assert.equal(back.toString(), x.terminalReturn);
    assert.equal(x.allocations[0].legs[0].stateBeforeDigest, digest(b.pools[0].state));
    assert.equal(x.allocations[0].legs[0].stateAfterDigest, digest({ ...b.pools[0].state,
      reserve0: '1100', reserve1: '1819', balance0: '1100', balance1: '1819' }));
    assert.equal(x.allocations[0].legs[1].stateBeforeDigest, digest(b.pools[1].state));
    assert.equal(x.allocations[0].legs[1].stateAfterDigest, digest({ ...b.pools[1].state, reserve0: '848', reserve1: '1181' }));
    const second = classic(first.nextX, 2000n - first.out, 100n, 30n);
    assert.equal(first.out + second.out, 332n);
    assert.equal(first.out * 2n, 362n); // Reusing the initial snapshot overstates return.
    for (const branch of b.branches) {
      let token = b.borrowAsset;
      for (const leg of branch.legs) {
        const pool = b.pools.find(p => p.poolId === leg.poolId); assert.ok(pool);
        assert.equal(leg.tokenIn, token);
        token = token === pool.token0 ? pool.token1 : pool.token0;
      }
      assert.equal(token, b.borrowAsset);
    }
    const cost = b.cost;
    assert.equal(BigInt(cost.costInBorrowAsset), ceil(BigInt(cost.nativeCostWei) * BigInt(cost.conversionNumerator), BigInt(cost.conversionDenominator)));
  },
  () => {
    const abi = outputs.calldataContract;
    assert.deepEqual(abi.venueIds, { 'uniswap-v2': 2, 'uniswap-v3': 3, 'aero-classic': 6, 'aero-slipstream': 7 });
    assert.equal(new Set(Object.values(abi.generationIds)).size, 5);
    assert.equal(abi.legFieldOrder.length, 12);
    assert.ok(abi.legFieldOrder.includes('uint256 quotedAmountOut'));
    for (const dependency of spec.dependencies) {
      const evidence = spec.source_evidence.find(e => e.entity_id === dependency.symbol && e.source_uri === dependency.file_location);
      assert.ok(evidence, `missing evidence: ${dependency.symbol}`);
      const source = read(dependency.file_location);
      assert.equal(evidence.hash, `sha256:${createHash('sha256').update(source).digest('hex')}`);
      const ast = ts.createSourceFile(dependency.file_location, source, ts.ScriptTarget.Latest, true);
      const found = ast.statements.some(node => node.name?.text === dependency.symbol && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
      assert.ok(found, `missing exported declaration: ${dependency.symbol}`);
    }
  },
  () => {
    const mapText = read('docs/features/aero-split-routing-map.md');
    const maps = [...mapText.matchAll(/```json nim-deliver\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
    assert.equal(maps.length, 2); assert.equal(maps[0].status, 'Done'); assert.equal(maps[1].status, 'Done');
    for (const map of maps) {
      assert.deepEqual(map.edgeProofs.map(p => p.edgeId), ['EDGE-01', 'EDGE-02', 'EDGE-03', 'EDGE-04', 'EDGE-05']);
      for (const proof of map.edgeProofs) assert.ok(map.seams.some(s => s.id === proof.seamId));
    }
    assert.equal(maps[0].featureId, 'aero-split-routing-spec');
    assert.equal(maps[1].edgeProofs[4].command, 'node scripts/verify-aero-implementation.mjs');
    assert.equal(spec.test_criteria.length, 5);
    assert.ok(spec.test_criteria.every((c, i) => c.startsWith(`EDGE-0${i + 1}`)));
    const doc = read('docs/ratio.md');
    assert.ok(doc.includes('1ba30815bba620f7e9faa34769ffd00c214c9b82'));
    assert.ok(doc.includes('f8717faaae6e6717db3c8e3850149c01a79c0603'));
  }
];

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--edge' && /^EDGE-0[1-5]$/.test(args[1])), 'usage: node scripts/verify-aero-spec.mjs [--edge EDGE-01..EDGE-05]');
for (let i = 0; i < checks.length; i++) {
  if (args.length && args[1] !== `EDGE-0${i + 1}`) continue;
  checks[i]();
  console.log(JSON.stringify({ event: markers[i], success: true, scope: 'specification-only' }));
}
