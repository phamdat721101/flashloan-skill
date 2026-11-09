import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CONTRACT_DIGEST, FinanceError, canonicalDigest, checkAmount, checkPlan, grantId, intersectConstraints, isValid, issuedToDecimal, loadContract, localPlanHash, normalizeIssued,
  planHash, requestDigest, rippleTimeToIso, strictParse, validate, withinConstraints, xrplAccountId, xrplAddress, xrplAnnualRate,
  type Constraints, type LocalPlan, type Plan,
} from '../finance/contracts.js';
import { checkRequest } from '../finance/client.js';
import { compare } from '../finance/planner.js';

const root = new URL('../../', import.meta.url);
const vectors = JSON.parse(readFileSync(new URL('schemas/examples/finance-v1.vectors.json', root), 'utf8')) as Array<{ name: string; definition: string; valid: boolean; value: unknown }>;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof FinanceError ? e.code + (e.detail ? `:${e.detail}` : '') : String(e); } return 'OK'; };
const USDC = { kind: 'erc20' as const, network: 'arbitrum' as const, address: '0x2222222222222222222222222222222222222222', decimals: 6 };
const empty: Constraints = { maxSpend: [], maxCosts: [], minReceive: [], maxDebtAfter: [], minCollateralAfter: [], minSupplyAfter: [], maxSlippageBps: 50, maxStateAgeSeconds: 30 };

test('pinned contract digest matches the PRD and the packaged schema', () => {
  assert.equal(loadContract().digest, CONTRACT_DIGEST);
});

test('all shared vectors give the expected structural verdict', () => {
  assert.equal(vectors.length, 17);
  for (const v of vectors) assert.equal(isValid(v.definition, v.value), v.valid, v.name);
});

test('strict boundary rejects duplicate keys, prototype keys, invalid UTF-8, unsafe numbers and oversized input', () => {
  assert.equal(code(() => strictParse(Buffer.from('{"a":1,"a":2}'))), 'INVALID_INPUT:duplicate-key');
  assert.equal(code(() => strictParse(Buffer.from('{"x":{"b":1,"b":1}}'))), 'INVALID_INPUT:duplicate-key');
  assert.equal(code(() => strictParse(Buffer.from('{"__proto__":{"admin":true}}'))), 'INVALID_INPUT:prototype-key');
  assert.equal(code(() => strictParse(Buffer.from([0x7b, 0xff, 0x7d]))), 'INVALID_INPUT:invalid-utf8');
  assert.equal(code(() => strictParse(Buffer.from('{"v":9007199254740993}'))), 'INVALID_INPUT:unsafe-number');
  assert.equal(code(() => strictParse(Buffer.alloc(256 * 1024 + 1, 0x20))), 'INVALID_INPUT:input-too-large');
  assert.deepEqual(strictParse(Buffer.from('[{"a":"\\"a\\"","b":[{"a":1}]},{"a":2}]')), [{ a: '"a"', b: [{ a: 1 }] }, { a: 2 }]);
});

test('amount semantics keep native meaning: issued canonical form, widths and positivity', () => {
  assert.deepEqual(normalizeIssued('12500', -4), { coefficient: '125', exponent: -2 });
  assert.deepEqual(normalizeIssued('-0', 7), { coefficient: '0', exponent: 0 });
  assert.equal(code(() => normalizeIssued('12345678901234567', 0)), 'INVALID_INPUT:issued-range');
  assert.equal(code(() => normalizeIssued('1', 81)), 'INVALID_INPUT:issued-range');
  assert.equal(issuedToDecimal({ coefficient: '125', exponent: -2 }), '1.25');
  assert.equal(issuedToDecimal({ coefficient: '-5', exponent: -3 }), '-0.005');
  const issuer = xrplAddress(Buffer.alloc(20, 7));
  const issued = { kind: 'xrpl-issued' as const, network: 'xrpl' as const, currency: 'USD', issuer };
  assert.equal(code(() => checkAmount({ asset: issued, quantity: { kind: 'issued-decimal', coefficient: '1250', exponent: -3 } })), 'INVALID_INPUT:non-canonical-issued');
  assert.equal(code(() => checkAmount({ asset: { ...issued, currency: 'XRP' }, quantity: { kind: 'issued-decimal', coefficient: '1', exponent: 0 } })), 'INVALID_INPUT:reserved-currency');
  assert.equal(code(() => checkAmount({ asset: { kind: 'xrp', network: 'xrpl', decimals: 6 }, quantity: { kind: 'atomic', value: '100000000000000001' } })), 'INVALID_INPUT:amount-width');
  assert.equal(code(() => checkAmount({ asset: USDC, quantity: { kind: 'atomic', value: '0' } }, { positive: true })), 'INVALID_INPUT:amount-not-positive');
  assert.equal(code(() => checkAmount({ asset: USDC, quantity: { kind: 'atomic', value: (1n << 256n).toString() } })), 'INVALID_INPUT:amount-width');
});

test('XRPL loan units: rate tenths of bps, Ripple epoch and classic address checksum', () => {
  assert.equal(xrplAnnualRate(500), '0.005');
  assert.equal(xrplAnnualRate(100000), '1');
  assert.equal(xrplAnnualRate(0), '0');
  assert.equal(rippleTimeToIso(0), '2000-01-01T00:00:00.000Z');
  const id = Buffer.from('0123456789abcdef0123456789abcdef01234567', 'hex');
  const addr = xrplAddress(id);
  assert.ok(xrplAccountId(addr).equals(id));
  assert.equal(xrplAddress(Buffer.alloc(20)), 'rrrrrrrrrrrrrrrrrrrrrhoLvTp');
  const tampered = addr.slice(0, -1) + (addr.endsWith('r') ? 'p' : 'r');
  assert.match(code(() => xrplAccountId(tampered)), /^INVALID_INPUT:xrpl-address/);
});

test('hash domains are separate and every field mutation changes the plan and local hashes', () => {
  const plan = vectors.find(v => v.definition === 'Plan')!.value as Plan;
  const local = vectors.find(v => v.definition === 'LocalPlan')!.value as LocalPlan;
  const p = planHash(plan), l = localPlanHash(local);
  assert.equal(p, plan.planHash, 'golden research-plan hash parity with the PRD producer');
  assert.equal(l, local.localPlanHash, 'golden local-plan hash parity with the PRD producer');
  assert.notEqual(p, l);
  assert.equal(planHash({ ...plan, planHash: '0'.repeat(64) }), p, 'planHash ignores its own field');
  assert.equal(planHash({ ...plan, account: { ...plan.account, address: plan.account.address.toUpperCase().replace('0X', '0x') } } as Plan), p, 'EVM addresses are normalized after validation');
  const mutations: Array<(x: Plan) => void> = [
    x => { x.network = 'base'; }, x => { (x.nativePayload as { nonce: string }).nonce = '2'; }, x => { x.expiresAt = '2026-11-09T08:00:31.000Z'; },
    x => { x.effectiveConstraints.maxSlippageBps = 49; }, x => { x.permissions = [{ kind: 'native-signature', target: 'x', asset: null, maximum: null }]; },
    x => { (x.nativePayload as { data: string }).data = '0x00'; }, x => { x.adapterRef = 'b'.repeat(64); },
  ];
  for (const m of mutations) { const x = structuredClone(plan); m(x); assert.notEqual(planHash(x), p); }
  const lm = structuredClone(local); (lm.nativePayload as { maxFeePerGas: string }).maxFeePerGas = '2'; assert.notEqual(localPlanHash(lm), l);
  assert.notEqual(requestDigest({ a: 1 }), canonicalDigest({ a: 1 }));
  assert.equal(grantId({ schemaVersion: 'finance.approval/1', contractDigest: CONTRACT_DIGEST, localPlanHash: l, policyHash: 'a'.repeat(64), account: local.account, nonce: 'c'.repeat(64), issuedAt: '2026-11-09T08:00:00.000Z', expiresAt: '2026-11-09T08:05:00.000Z' }).length, 64);
});

test('plan semantic check rejects a hash mismatch, wrong chain and loosened effective bounds', () => {
  const plan = structuredClone(vectors.find(v => v.definition === 'Plan')!.value as Plan);
  const now = Date.parse('2026-11-09T08:00:10.000Z');
  assert.equal(plan.planHash, planHash(plan), 'shared vector carries its real research hash');
  assert.equal(code(() => checkPlan({ ...plan, planHash: 'a'.repeat(64) }, now)), 'INVALID_INPUT:plan-hash');
  const ok = plan;
  assert.equal(code(() => checkPlan(ok, now)), 'OK');
  const wrong = structuredClone(ok); (wrong.nativePayload as { chainId: number }).chainId = 8453; wrong.planHash = planHash(wrong);
  assert.equal(code(() => checkPlan(wrong, now)), 'WRONG_CHAIN:payload-chain');
  const loose = structuredClone(ok); loose.effectiveConstraints.maxSlippageBps = 60; loose.planHash = planHash(loose);
  assert.equal(code(() => checkPlan(loose, now)), 'POLICY_REJECTED:effective-looser-than-requested');
});

test('constraint intersection only tightens', () => {
  const a = (v: string) => ({ asset: USDC, quantity: { kind: 'atomic' as const, value: v } });
  const policy = { ...empty, maxSpend: [a('100')], minReceive: [a('5')], maxStateAgeSeconds: 20 };
  const request = { ...empty, maxSpend: [a('500')], minReceive: [a('9')], maxSlippageBps: 10 };
  const e = intersectConstraints(policy, request);
  assert.equal((e.maxSpend[0].quantity as { value: string }).value, '100');
  assert.equal((e.minReceive[0].quantity as { value: string }).value, '9');
  assert.equal(e.maxSlippageBps, 10); assert.equal(e.maxStateAgeSeconds, 20);
  assert.ok(withinConstraints(e, request)); assert.ok(!withinConstraints(request, policy));
});

test('requests: namespaced idempotency, owner injection and numeric amounts are rejected before transport', () => {
  const ok = vectors[1].value as Record<string, unknown>;
  assert.equal(code(() => checkRequest(ok)), 'OK');
  assert.equal(code(() => checkRequest({ ...ok, idempotency_key: 'positions:1' })), 'INVALID_INPUT:idempotency-namespace');
  assert.equal(code(() => checkRequest({ ...ok, owner: 'someone-else' })), 'INVALID_INPUT:schema:Request');
  assert.equal(code(() => checkRequest({ ...ok, network: 'base' })), 'WRONG_CHAIN');
  assert.equal(code(() => checkRequest({ ...ok, contractDigest: 'f'.repeat(64) })), 'CONTRACT_MISMATCH');
  assert.equal(code(() => validate('Quantity', { kind: 'atomic', value: 1000000 })), 'INVALID_INPUT:schema:Quantity');
});

test('E2E-11 comparison: hold baseline, unknown cost and empty bounds block without fabricated savings', () => {
  const position = (strictParse(Buffer.from(JSON.stringify(vectors[14].value))) as { data: { positions: unknown[] } }).data.positions[0] as Parameters<typeof compare>[0];
  const c = compare(position, 'repay', empty, { costs: null, amount: { asset: USDC, quantity: { kind: 'atomic', value: '1000000' } }, complete: true });
  assert.equal(c.actions[0].intent, 'hold'); assert.equal(c.actions[0].admissible, true); assert.deepEqual(c.actions[0].costs, []);
  const repay = c.actions[1];
  assert.equal(repay.admissible, false);
  assert.ok(repay.blockedReasons.includes('COST_UNKNOWN') && repay.blockedReasons.includes('MISSING_BOUND:maxSpend') && repay.blockedReasons.includes('MISSING_BOUND:maxDebtAfter'));
  assert.deepEqual(repay.costs, []);
  assert.ok(isValid('Comparison', c));
  const protect = compare(position, 'protect', empty, { costs: [], amount: null, complete: true }).actions[1];
  assert.ok(protect.blockedReasons.some(r => r.startsWith('UNSUPPORTED_ACCOUNT_MODEL')), 'EOA position cannot be flash-protected');
});

test('E2E-27 isolated install carries the exact pinned Finance contract, instructions and no local state', async t => {
  const { mkdtemp, rm, readdir } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { spawn } = await import('node:child_process'); const { createHash } = await import('node:crypto'); const { fileURLToPath } = await import('node:url');
  const target = await mkdtemp(join(tmpdir(), 'finance-skill-')); t.after(() => rm(target, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../agent-cli.js', import.meta.url)), 'install', '--target', target], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', c => { stderr += c; }); assert.equal(await new Promise(r => child.on('close', r)), 0, stderr);
  const dir = join(target, 'flashloan-agent'), schema = readFileSync(join(dir, 'contracts/finance-v1.schema.json'));
  const pin = JSON.parse(readFileSync(join(dir, 'contracts/finance-schema-version.json'), 'utf8')) as { contractDigest: string; fileSha256: string };
  assert.equal(createHash('sha256').update(schema).digest('hex'), pin.fileSha256);
  assert.equal(pin.contractDigest, CONTRACT_DIGEST);
  assert.equal(Buffer.compare(schema, readFileSync(new URL('schemas/finance-v1.schema.json', root))), 0);
  const tampered = Buffer.from(schema); tampered[tampered.length - 3] ^= 1;
  assert.notEqual(createHash('sha256').update(tampered).digest('hex'), pin.fileSha256, 'one-byte tamper fails the pin');
  assert.ok(readFileSync(join(dir, 'SKILL.md'), 'utf8').includes('finance.md'));
  assert.ok(readFileSync(join(dir, 'finance.md'), 'utf8').includes('SUBMISSION_UNKNOWN'));
  const all = (await readdir(target, { recursive: true })).map(String);
  assert.ok(!all.some(f => /(^|\/)\.env$|\.nim\/|journal\.jsonl|signed\//.test(f)), 'no env, nim state, journal or signed material');
});
