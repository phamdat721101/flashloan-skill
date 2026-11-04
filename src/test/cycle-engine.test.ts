import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseLender, clVirtualReserves, findCycles, foldCycle, hopCurve, maximizeConcave, pricedOut, refineBracket, seedPrincipal, solveSplitLambda, splitAmount, TokenBandit, type Edge } from '../evm/cycle-engine.js';

const cpmm = (rin: bigint, rout: bigint) => (x: bigint) => x * 997n * rout / (rin * 1000n + x * 997n);
const edge = (pool: string, tokenIn: string, tokenOut: string, rate: number): Edge => ({ pool, tokenIn, tokenOut, logRate: Math.log(rate) });

test('finds a positive triangle first and never reuses a pool or an intermediate token', () => {
  const edges = [edge('p1', 'W', 'U', 2000), edge('p2', 'U', 'B', 1 / 100_000), edge('p3', 'B', 'W', 50.02), edge('p3', 'W', 'B', 0.0199), edge('p4', 'U', 'W', 1 / 2001), edge('p1', 'U', 'W', 1 / 2003)];
  const cycles = findCycles(edges, ['W'], 4);
  assert.deepEqual(cycles[0].edges.map(e => e.pool), ['p1', 'p2', 'p3']);
  assert.ok(cycles[0].edgeBps > 0 && Math.abs(cycles[0].edgeBps - 4) < 0.01);
  for (const c of cycles) {
    assert.equal(new Set(c.edges.map(e => e.pool)).size, c.edges.length);
    assert.equal(c.edges[0].tokenIn, 'W'); assert.equal(c.edges.at(-1)!.tokenOut, 'W');
    assert.equal(new Set(c.edges.slice(0, -1).map(e => e.tokenOut)).size, c.edges.length - 1);
  }
  assert.ok(cycles.every(c => c.edges.length <= 4));
});

test('respects the hop limit and rejects an invalid one', () => {
  const ring = ['A', 'B', 'C', 'D', 'E'].map((t, i, a) => edge(`r${i}`, t, a[(i + 1) % a.length], 1.01));
  assert.equal(findCycles(ring, ['A'], 4).length, 0);
  assert.equal(findCycles(ring, ['A'], 5).length, 1);
  assert.throws(() => findCycles(ring, ['A'], 1), /INVALID_MAX_HOPS/);
});

test('keeps the best cycles even when far more are enumerated than kept', () => {
  const edges: Edge[] = [];
  for (let i = 0; i < 40; i++) { edges.push(edge(`a${i}`, 'W', 'U', 2000 * (1 - 0.001 * i))); edges.push(edge(`b${i}`, 'U', 'W', 1 / 2001)); }
  edges.push(edge('best', 'U', 'W', 1 / 1990));
  const stats = { found: 0 }, cycles = findCycles(edges, ['W'], 2, 5, stats);
  assert.equal(stats.found, 40 * 41);
  assert.equal(cycles.length, 5);
  assert.equal(cycles[0].edges.map(e => e.pool).join(), 'a0,best');
});

test('maximizeConcave matches a brute-force optimum for a two-pool CPMM arbitrage', async () => {
  const buy = cpmm(1_000_000n, 2_100_000n), sell = cpmm(2_000_000n, 1_000_000n);
  const net = async (x: bigint) => sell(buy(x)) - x;
  let brute = 0n; for (let x = 1n; x <= 200_000n; x += 1n) { const v = await net(x); if (v > brute) brute = v; }
  const found = await maximizeConcave(net, 1n, 10_000_000n, 40);
  assert.ok(found);
  assert.ok(brute - found.value <= 1n, `found ${found.value} brute ${brute}`);
  assert.ok(found.evaluations < 200);
});

test('maximizeConcave returns null when the smallest size cannot fill and rejects an empty domain', async () => {
  assert.equal(await maximizeConcave(async () => null, 1n, 10n), null);
  await assert.rejects(maximizeConcave(async () => 0n, 0n, 10n), /INVALID_SIZE_DOMAIN/);
});

test('splitAmount equals the best grid split across parallel pools and ignores a dominated pool', async () => {
  const a = cpmm(1_000_000n, 1_000_000n), b = cpmm(500_000n, 500_000n), q = [async (x: bigint) => a(x), async (x: bigint) => b(x)];
  const total = 160_000n, s = await splitAmount(q, total, 16);
  let best = 0n; for (let i = 0n; i <= 16n; i++) { const x = total * i / 16n, v = a(x) + b(total - x); if (v > best) best = v; }
  assert.equal(s.out, best);
  assert.equal(s.amounts.reduce((m, x) => m + x, 0n), total);
  const dominated = await splitAmount([async (x: bigint) => a(x), async () => 0n], 1000n, 4);
  assert.deepEqual(dominated.amounts, [1000n, 0n]);
  await assert.rejects(splitAmount([], 1n), /INVALID_SPLIT/);
});

test('splitAmount does not open an extra pool whose gain is below the leg cost', async () => {
  const a = cpmm(1_000_000n, 1_000_000n), b = cpmm(1_000_000n, 1_000_000n), q = [async (x: bigint) => a(x), async (x: bigint) => b(x)];
  const free = await splitAmount(q, 100_000n, 8), costly = await splitAmount(q, 100_000n, 8, 10_000n);
  assert.ok(free.amounts.every(x => x > 0n));
  assert.deepEqual(costly.amounts, [100_000n, 0n]);
});

test('token bandit ranks the rewarded token first and round-trips its state', () => {
  let seed = 7; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bandit = new TokenBandit(undefined, random);
  for (let i = 0; i < 30; i++) { bandit.update('hot', true); bandit.update('cold', false); }
  const wins = Array.from({ length: 50 }, () => bandit.rank(['cold', 'hot'])[0].token).filter(t => t === 'hot').length;
  assert.ok(wins >= 48);
  const restored = new TokenBandit(JSON.parse(JSON.stringify(bandit.state)), random);
  assert.deepEqual(restored.state.arms.hot, { alpha: 31, beta: 1 });
  assert.deepEqual(new TokenBandit({ schemaVersion: 'wrong' } as never).state.arms, {});
});

test('RPC limiter never exceeds its concurrency and releases a slot when a task fails', async () => {
  const { limiter } = await import('../evm/cycle-watch.js');
  const gate = limiter(3); let active = 0, peak = 0;
  const task = (fail: boolean) => gate(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 2)); active--; if (fail) throw new Error('THROTTLED'); return 1; });
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => task(i % 4 === 0)));
  assert.equal(peak, 3);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 15);
  assert.equal(await gate(async () => 'still-open'), 'still-open');
});

// ---- FLV8_EDGE_03: allocation (PRD §6, §17 A1/A3/A8) ----
/** Deterministic LCG so property cases replay exactly. */
const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

test('FLV8_EDGE_03 fold seed brackets the brute-force optimum for 2-4 CPMM hops and refine reaches it', async () => {
  const random = rng(7); let withEdge = 0;
  for (let trial = 0; trial < 24; trial++) {
    const hops = 2 + (trial % 3), e18 = 10n ** 18n;
    // Reserves are mispriced on the last hop so the cycle has an edge; sizes stay in raw 18-decimal units.
    const reserves = Array.from({ length: hops }, (_, i) => {
      const rin = BigInt(Math.floor(50 + random() * 950)) * e18, skew = i === hops - 1 ? 1.02 + random() * 0.08 : 1;
      return [rin, BigInt(Math.floor(Number(rin / e18) * skew)) * e18] as const;
    });
    const out = (x: bigint) => reserves.reduce((a, [rin, rout]) => cpmm(rin, rout)(a), x), profit = (x: bigint) => out(x) - x;
    const curve = foldCycle(reserves.map(([rin, rout]) => hopCurve(rin, rout, 3000)));
    assert.ok(curve, 'all-CPMM cycle folds');
    const dStar = seedPrincipal(curve!, 0n);
    // Brute force on a 4,000-point grid over [0, first-hop reserve / 2].
    const top = reserves[0][0] / 2n; let best = 0n, bestX = 0n;
    for (let i = 1n; i <= 4000n; i++) { const x = top * i / 4000n, p = profit(x); if (p > best) { best = p; bestX = x; } }
    if (best === 0n) { assert.equal(dStar, 0n, 'no grid edge means no closed-form edge'); continue; }
    withEdge++;
    const bracket = refineBracket({ method: 'fold_closed_form', dStar, allCpmm: true });
    assert.ok(bracket && bracket.min <= bestX && bestX <= bracket.max, `trial ${trial}: grid optimum ${bestX} inside [${bracket?.min}, ${bracket?.max}]`);
    const refined = await maximizeConcave(async x => profit(x), bracket!.min, bracket!.max, 20);
    assert.ok(refined && refined.value >= best, `trial ${trial}: exact refine ${refined?.value} >= grid ${best}`);
  }
  assert.ok(withEdge >= 20, `property cases with an edge: ${withEdge}/24`);
});

test('FLV8_EDGE_03 CL virtual reserves match independent decimal vectors and round against the seed', () => {
  const Q96 = 2n ** 96n, L = 10n ** 18n;
  // sqrtP = 1 (P = 1): both reserves equal L.
  assert.deepEqual(clVirtualReserves(L, Q96, true), { reserveIn: L, reserveOut: L });
  // sqrtP = 2 (P = 4): token0 reserve L/2 = 5e17, token1 reserve 2L = 2e18 (hand-computed, not from the code path).
  assert.deepEqual(clVirtualReserves(L, 2n * Q96, true), { reserveIn: 500000000000000000n, reserveOut: 2000000000000000000n });
  assert.deepEqual(clVirtualReserves(L, 2n * Q96, false), { reserveIn: 2000000000000000000n, reserveOut: 500000000000000000n });
  // L = 3, sqrtP = 3.5: token0 = 0.857… and token1 = 10.5. Input rounds up, output rounds down (A8).
  assert.deepEqual(clVirtualReserves(3n, 7n * Q96 / 2n, true), { reserveIn: 1n, reserveOut: 10n });
  assert.deepEqual(clVirtualReserves(3n, 7n * Q96 / 2n, false), { reserveIn: 11n, reserveOut: 0n });
  assert.throws(() => clVirtualReserves(0n, Q96, true), /ZERO_ACTIVE_LIQUIDITY/);
});

test('FLV8_EDGE_03 lambda split is within one chunk of the exhaustive optimum', () => {
  const curves = [hopCurve(500n, 700n, 3000).curve, hopCurve(200n, 300n, 3000).curve, hopCurve(90n, 120n, 3000).curve], total = 60n;
  const value = (amounts: bigint[]) => amounts.reduce((s, x, i) => s + Number(curves[i].a * x) / Number(curves[i].b + curves[i].c * x), 0);
  let best = -Infinity, bestSplit: bigint[] = [];
  for (let a = 0n; a <= total; a++) for (let b = 0n; a + b <= total; b++) { const s = [a, b, total - a - b], v = value(s); if (v > best) { best = v; bestSplit = s; } }
  const solved = solveSplitLambda(curves, total, 1n);
  assert.equal(solved.reduce((s, x) => s + x, 0n), total);
  assert.ok(solved.every((x, i) => (x > bestSplit[i] ? x - bestSplit[i] : bestSplit[i] - x) <= 1n), `${solved} vs exhaustive ${bestSplit}`);
  assert.deepEqual(solveSplitLambda([curves[0]], total, 1n), [total], 'a single pool takes everything');
});

test('FLV8_EDGE_03 priced output, probe bracket, lender choice and boundary cases', () => {
  assert.equal(pricedOut(100n, 90n), 90n); assert.equal(pricedOut(90n, 100n), 90n);
  assert.equal(foldCycle([hopCurve(10n, 11n, 3000), { ...hopCurve(10n, 11n, 100), cpmm: false }]), null, 'a stable hop has no closed form');
  assert.deepEqual(refineBracket({ method: 'probe_bracket', probe: 100n, shallowDepth: 1_000n }), { min: 100n, max: 500n });
  assert.equal(refineBracket({ method: 'probe_bracket', probe: 100n, shallowDepth: 150n }), null, 'pool shallower than twice the probe');
  // Lender fee above the edge: d* = 0, no bracket, nothing to size.
  const thin = foldCycle([hopCurve(1000n * 10n ** 18n, 1001n * 10n ** 18n, 0), hopCurve(10n ** 21n, 10n ** 21n, 0)])!;
  assert.ok(seedPrincipal(thin, 0n) > 0n); assert.equal(seedPrincipal(thin, 50n), 0n);
  assert.equal(refineBracket({ method: 'fold_closed_form', dStar: 0n, allCpmm: true }), null);
  assert.deepEqual(refineBracket({ method: 'fold_closed_form', dStar: 400n, allCpmm: false }), { min: 100n, max: 1600n });
  assert.throws(() => hopCurve(0n, 1n, 3000), /INVALID_RESERVES/); assert.throws(() => hopCurve(1n, 1n, 1_000_000), /INVALID_FEE/);
  const lenders = [{ id: 'aave', feeBps: 5, available: 10n ** 24n, gasRaw: 0n, rooted: true }, { id: 'morpho', feeBps: 0, available: 10n ** 20n, gasRaw: 10n, rooted: true },
    { id: 'rogue', feeBps: 0, available: 10n ** 30n, gasRaw: 0n, rooted: false }];
  assert.equal(chooseLender(lenders, 10n ** 19n)!.lender.id, 'morpho');
  assert.deepEqual(chooseLender(lenders, 10n ** 26n), { lender: lenders[0], principal: 10n ** 24n }, 'capped at the deepest rooted lender; unrooted ignored (B3)');
  assert.equal(chooseLender([], 1n), null);
});
