import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toBase58 } from '@mysten/sui/utils';
import { digest, isSuiDigest, parseSnapshot, SnapshotStore, uint, type LiquiditySnapshot, type StateIdentity } from '../liquidity/state.js';
import { AttemptJournal } from '../liquidity/journal.js';
import { LiquidityRuntime, type LiquidityExecutionAdapter, type RouteCandidate, type RuntimePolicy, type SimulationProof } from '../liquidity/runtime.js';

const now = 1000;
const identities: StateIdentity[] = [
  { chain: 'arbitrum', network: '42161', height: '1', blockHash: `0x${'a'.repeat(64)}` },
  { chain: 'sui', network: 'mainnet', height: '1', checkpointDigest: toBase58(new Uint8Array(32).fill(1)) }
];
function snapshot(identity: StateIdentity, cursor = '1'): LiquiditySnapshot {
  return { schemaVersion: '3.0', identity, sourceId: 'test-source', cursor, observedAtMs: now, complete: true, poolIds: [`${identity.chain}:${identity.network}:pool`], stateDigest: digest({ cursor, identity }) };
}
function candidate(s: LiquiditySnapshot, suffix = ''): RouteCandidate {
  return { identity: s.identity, stateDigest: s.stateDigest, poolIds: s.poolIds, adapterId: s.identity.chain, adapterRevision: 'test-revision', payloadDigest: digest(suffix), borrowAmount: '100', profitAsset: `${s.identity.chain}:${s.identity.network}:profit-asset`, minProfit: '10', maxGasCost: '5', expiresAtMs: now + 1000 };
}
function proof(c: RouteCandidate): SimulationProof {
  return { candidateDigest: digest(c), payloadDigest: c.payloadDigest, stateDigest: c.stateDigest, success: true, profitAfterDebt: '20', conservativeGasCostInProfitAsset: '5' };
}
const policy: RuntimePolicy = { mode: 'auto', concurrency: 2, maxCandidates: 10, maxDailyLoss: '100', minProfit: '10', budgetAssets: { 'arbitrum:42161': 'arbitrum:42161:profit-asset', 'sui:mainnet': 'sui:mainnet:profit-asset' } };
function adapter(identity: StateIdentity, counters: { signs: number; sends: number }): LiquidityExecutionAdapter {
  const transactionId = identity.chain === 'arbitrum' ? `0x${'b'.repeat(64)}` : toBase58(new Uint8Array(32).fill(2));
  return {
    admission: { chain: identity.chain, network: identity.network, revision: 'test-revision', expiresAtMs: 10000, evidence: { schema: 'local-test', math: 'local-test', simulation: 'local-test', canary: 'local-test-not-live' } },
    simulate: async c => proof(c), preflight: async c => proof(c), resource: async () => 'nonce-or-gas-version-1',
    sign: async (c, resource) => { counters.signs++; return { transactionId, signedBytes: new Uint8Array([1]), resource, payloadDigest: c.payloadDigest }; },
    submit: async () => { counters.sends++; return transactionId; },
    receipt: async transactionId => ({ transactionId, source: 'local-test-endpoint', executionStatus: 'success', repaymentProven: true, profitTransferProven: true, profitAfterDebt: '20', gasCostInProfitAsset: '5' })
  };
}
async function fixture(identity: StateIdentity, run: (state: SnapshotStore, journal: AttemptJournal, c: RouteCandidate, a: LiquidityExecutionAdapter, counters: { signs: number; sends: number }, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'liquid-pattern-'));
  try {
    const state = new SnapshotStore(100), s = snapshot(identity), path = join(directory, 'attempts.jsonl'); state.apply(s);
    const counters = { signs: 0, sends: 0 };
    await run(state, new AttemptJournal(path), candidate(s), adapter(identity, counters), counters, path);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('independent chain lanes submit concurrently while journal writes remain serialized', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'liquid-pattern-'));
  try {
    const state = new SnapshotStore(100), counters = { signs: 0, sends: 0 };
    const candidates = identities.map(identity => { const s = snapshot(identity); state.apply(s); return candidate(s); });
    let release!: () => void;
    const bothSubmitted = new Promise<void>(resolve => { release = resolve; });
    const adapters = new Map(identities.map(identity => {
      const a = adapter(identity, counters), submit = a.submit, receipt = a.receipt;
      a.submit = async bytes => { const id = await submit(bytes); if (counters.sends === 2) release(); return id; };
      a.receipt = async id => { await bothSubmitted; return receipt(id); };
      return [identity.chain, a] as const;
    }));
    const journal = new AttemptJournal(join(directory, 'attempts.jsonl'));
    const decisions = await new LiquidityRuntime(state, journal, adapters, () => now).run(candidates, { ...policy, stepTimeoutMs: 1000 });
    assert.equal(decisions.filter(d => d.status === 'reconciled').length, 2);
    assert.equal(counters.sends, 2);
    assert.equal((await journal.latest()).filter(r => r.state === 'reconciled').length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('EDGE-01 source gap recovery, strict identity and stale snapshots for both chains', () => {
  assert.equal(isSuiDigest('1'.repeat(43)), false);
  assert.equal(isSuiDigest(toBase58(new Uint8Array(32))), true);
  for (const identity of identities) {
    const store = new SnapshotStore(100), s = snapshot(identity);
    assert.equal(store.apply(s), 'accepted'); assert.equal(store.apply(s), 'duplicate');
    assert.throws(() => parseSnapshot({ ...s, secret: 'must-not-enter' }), /INVALID_FIELDS/);
    assert.throws(() => store.apply(snapshot({ ...identity, height: '3' }, '3')), /SOURCE_GAP/);
    assert.throws(() => store.current(identity, now), /RESYNC/);
    const recovered = snapshot({ ...identity, height: '3' }, '3'); store.apply(recovered, true);
    assert.deepEqual(store.current(recovered.identity, now), recovered);
    assert.throws(() => store.current(recovered.identity, now + 101), /STALE/);
    assert.throws(() => parseSnapshot({ ...s, identity: { ...identity, blockHash: 'mixed' } }), /INVALID_FIELDS|INVALID_ARBITRUM/);
    assert.throws(() => uint('01'), /INVALID_DECIMAL/); assert.throws(() => uint((1n << 256n).toString()), /OUT_OF_RANGE/);
  }
  console.log(JSON.stringify({ edgeId: 'EDGE-01', marker: 'source_snapshot_recovered_or_rejected', evidence: 'local-runtime-only' }));
});

test('EDGE-02 rejects unknown adapters, insufficient profit, unproven admission and missing pools', async () => {
  for (const identity of identities) await fixture(identity, async (state, journal, c, a, counters) => {
    const runtime = new LiquidityRuntime(state, journal, new Map([[c.adapterId, a]]), () => now);
    assert.equal((await runtime.run([{ ...c, adapterId: 'unknown' }], policy))[0].code, 'UNSUPPORTED_CAPABILITY');
    assert.equal((await runtime.run([{ ...c, poolIds: ['missing'] }], policy))[0].code, 'STATE_COVERAGE_INCOMPLETE');
    assert.equal((await runtime.run([{ ...c, profitAsset: `${identity.chain}:${identity.network}:another-token` }], policy))[0].code, 'BUDGET_ASSET_MISMATCH');
    a.simulate = async c => ({ ...proof(c), profitAfterDebt: '14' });
    assert.equal((await runtime.run([c], policy))[0].code, 'INSUFFICIENT_NET_PROFIT');
    a.admission.evidence.canary = '';
    assert.equal((await runtime.run([c], policy))[0].code, 'UNPROVEN_CAPABILITY');
    assert.equal(counters.signs, 0);
  });
});

test('EDGE-03 changed state or preflight payload rejects before signing', async () => {
  for (const identity of identities) await fixture(identity, async (state, journal, c, a, counters) => {
    const runtime = new LiquidityRuntime(state, journal, new Map([[c.adapterId, a]]), () => now);
    a.preflight = async c => ({ ...proof(c), payloadDigest: digest('different') });
    assert.ok((await runtime.run([c], policy)).some(d => d.code === 'SIMULATION_PROOF_MISMATCH'));
    a.preflight = async c => { state.apply(snapshot({ ...identity, height: '2' }, '2')); return proof(c); };
    assert.ok((await runtime.run([c], policy)).some(d => d.code === 'STATE_CHANGED'));
    assert.equal(counters.signs, 0); assert.deepEqual(await journal.latest(), []);
  });
  console.log(JSON.stringify({ edgeId: 'EDGE-03', marker: 'exact_payload_preflight_rejected_on_change', evidence: 'local-runtime-only' }));
});

test('EDGE-04 timeout retains exclusive resource across process restart and never resends a new attempt', async () => {
  for (const identity of identities) await fixture(identity, async (state, journal, c, a, counters, path) => {
    a.submit = async () => { counters.sends++; throw new Error('NETWORK_TIMEOUT'); };
    const first = new LiquidityRuntime(state, journal, new Map([[c.adapterId, a]]), () => now);
    assert.ok((await first.run([c], policy)).some(d => d.status === 'halted'));
    const restarted = new LiquidityRuntime(state, new AttemptJournal(path), new Map([[c.adapterId, a]]), () => now);
    assert.ok((await restarted.run([{ ...c, payloadDigest: digest('new') }], policy)).some(d => d.code === 'UNRESOLVED_ATTEMPT'));
    assert.equal(counters.sends, 1); assert.equal(counters.signs, 1);
    assert.equal((await new AttemptJournal(path).latest())[0].state, 'halted');
  });
  console.log(JSON.stringify({ edgeId: 'EDGE-04', marker: 'exclusive_attempt_survives_timeout_and_restart', evidence: 'local-runtime-only' }));
});

test('EDGE-05 receipt accounting releases successful attempts; absent evidence persists halt across days', async () => {
  for (const identity of identities) {
    await fixture(identity, async (state, journal, c, a) => {
      const runtime = new LiquidityRuntime(state, journal, new Map([[c.adapterId, a]]), () => now);
      assert.ok((await runtime.run([c], policy)).some(d => d.status === 'reconciled'));
      assert.equal((await journal.latest())[0].loss, '0');
    });
    await fixture(identity, async (state, journal, c, a) => {
      a.receipt = async () => null;
      const runtime = new LiquidityRuntime(state, journal, new Map([[c.adapterId, a]]), () => now);
      assert.ok((await runtime.run([c], policy)).some(d => d.code === 'PNL_UNKNOWN'));
      const r = (await journal.latest())[0];
      await assert.rejects(() => journal.prepare({ ...r, id: 'tomorrow', day: '2026-10-14', state: 'prepared', transactionId: null }, 100n, 5n), /UNRESOLVED/);
    });
  }
  console.log(JSON.stringify({ edgeId: 'EDGE-05', marker: 'receipt_accounted_or_execution_halted', evidence: 'local-runtime-only' }));
});

test('bounded simulation and shadow mode do not construct signing resources', async () => {
  await fixture(identities[0], async (state, journal, c, a, counters) => {
    let active = 0, peak = 0;
    a.simulate = async c => { active++; peak = Math.max(active, peak); await new Promise(resolve => setTimeout(resolve, 2)); active--; return proof(c); };
    const runtime = new LiquidityRuntime(state, journal, new Map([[c.adapterId, a]]), () => now);
    const input = Array.from({ length: 6 }, (_, i) => ({ ...c, payloadDigest: digest(i) }));
    assert.equal((await runtime.run(input, { ...policy, mode: 'shadow' })).length, 6);
    assert.equal(peak, 2); assert.equal(counters.signs, 0); assert.deepEqual(await journal.latest(), []);
  });
});

test('a hung simulation aborts the source batch without spawning unbounded replacement work', async () => {
  await fixture(identities[0], async (state, journal, c, a, counters) => {
    let calls = 0, aborted = false;
    a.simulate = async (_, signal) => {
      calls++; signal!.addEventListener('abort', () => { aborted = true; });
      return new Promise(() => undefined);
    };
    const runtime = new LiquidityRuntime(state, journal, new Map([[c.adapterId, a]]), () => now);
    const decisions = await runtime.run(Array.from({ length: 6 }, (_, i) => ({ ...c, payloadDigest: digest(i) })), { ...policy, stepTimeoutMs: 5 });
    assert.equal(decisions.length, 6); assert.equal(calls, 2); assert.ok(aborted);
    assert.ok(decisions.some(d => d.code === 'SIMULATION_BATCH_ABORTED')); assert.equal(counters.signs, 0);
  });
});

test('signed resource or payload drift cannot reach submission', async () => {
  for (const identity of identities) await fixture(identity, async (state, journal, c, a, counters) => {
    const original = a.sign;
    a.sign = async (c, resource) => ({ ...await original(c, resource), resource: 'another-resource' });
    const runtime = new LiquidityRuntime(state, journal, new Map([[c.adapterId, a]]), () => now);
    assert.ok((await runtime.run([c], policy)).some(d => d.code === 'INVALID_SIGNED_TRANSACTION'));
    assert.equal(counters.sends, 0); assert.equal((await journal.latest())[0].state, 'halted');
  });
});

test('wrong decoded Sui transaction digest width cannot reach submission', async () => {
  await fixture(identities[1], async (state, journal, c, a, counters) => {
    const original = a.sign;
    a.sign = async (candidate, resource) => ({ ...await original(candidate, resource), transactionId: '1'.repeat(43) });
    const runtime = new LiquidityRuntime(state, journal, new Map([[c.adapterId, a]]), () => now);
    assert.ok((await runtime.run([c], policy)).some(decision => decision.code === 'INVALID_SIGNED_TRANSACTION'));
    assert.equal(counters.sends, 0); assert.equal((await journal.latest())[0].state, 'halted');
  });
});

test('reverted gas is charged and actually exceeded budgets halt with measured loss', async () => {
  for (const identity of identities) {
    await fixture(identity, async (state, journal, c, a) => {
      a.receipt = async transactionId => ({ transactionId, source: 'local-test', executionStatus: 'revert', repaymentProven: false, profitTransferProven: false, profitAfterDebt: '0', gasCostInProfitAsset: '5' });
      const runtime = new LiquidityRuntime(state, journal, new Map([[c.adapterId, a]]), () => now);
      assert.ok((await runtime.run([c], policy)).some(d => d.code === 'REVERT_GAS_ACCOUNTED'));
      assert.equal((await journal.latest())[0].loss, '5');
    });
    await fixture(identity, async (state, journal, c, a) => {
      a.receipt = async transactionId => ({ transactionId, source: 'local-test', executionStatus: 'revert', repaymentProven: false, profitTransferProven: false, profitAfterDebt: '0', gasCostInProfitAsset: '6' });
      const runtime = new LiquidityRuntime(state, journal, new Map([[c.adapterId, a]]), () => now);
      assert.ok((await runtime.run([c], policy)).some(d => d.code === 'ACTUAL_GAS_EXCEEDED_BUDGET'));
      assert.equal((await journal.latest())[0].loss, '6'); assert.equal((await journal.latest())[0].state, 'halted');
    });
  }
});
