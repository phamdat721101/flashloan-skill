import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CONTRACT_DIGEST, FinanceError, grantId, grantSigningBytes, policyHash, sha256Hex,
  type Account, type Amount, type ApprovalGrant, type Constraints, type EvmPayload, type Intent, type LocalPlan, type Plan, type Profile, type XrplPayload,
} from '../finance/contracts.js';
import { loadProfile, type LoadedProfile } from '../finance/config.js';
import { FinanceClient, predictionHandoff } from '../finance/client.js';
import { EvmFinanceAdapter, adapterRef, localEvmSigner, type AaveMarket, type ProtectionAccount } from '../finance/evm.js';
import { XrplFinanceAdapter, admitSignHost, type XrplCodec, type XrplRpc } from '../finance/xrpl.js';
import { FinanceJournal } from '../finance/journal.js';
import { FinanceRuntime } from '../finance/runtime.js';
import { buildPlan } from '../finance/planner.js';
import { financeCli } from '../finance/cli.js';
import { grantSigningBytes as predictionGrantBytes } from '../prediction/config.js';
import type { FinanceAdapter, FinanceSigner } from '../finance/adapter.js';
import { xrplAddress } from '../finance/contracts.js';

// Public Anvil development keys. Local chain fixtures only: never mainnet, fork or funded evidence.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const USER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const user = privateKeyToAccount(USER_KEY), deployer = privateKeyToAccount(DEPLOYER);
const MARKERS: Record<string, string> = { 'EDGE-01': 'FINANCE_SKILL_EDGE-01_PROVEN', 'EDGE-02': 'FINANCE_SKILL_EDGE-02_PROVEN', 'EDGE-03': 'FINANCE_SKILL_EDGE-03_PROVEN', 'EDGE-04': 'FINANCE_SKILL_EDGE-04_PROVEN', 'EDGE-05': 'FINANCE_SKILL_EDGE-05_PROVEN' };
const proven = (edge: string) => console.log(MARKERS[edge]);
const errCode = async (p: Promise<unknown> | (() => unknown)) => { try { await (typeof p === 'function' ? p() : p); return 'OK'; } catch (e) { return e instanceof FinanceError ? e.code : String(e); } };

let anvil: ChildProcess | undefined, rpc = '', client: PublicClient, dir = '', approvalKey: KeyObject, otherKey: KeyObject;
let usdc: Address, weth: Address, pool: Address, vDebt: Address, aColl: Address, market: AaveMarket, protection: ProtectionAccount;
const anvilAvailable = spawnSync('anvil', ['--version']).status === 0;

const USDC_ASSET = () => ({ kind: 'erc20' as const, network: 'arbitrum' as const, address: usdc.toLowerCase(), decimals: 6 });
const ETH = { kind: 'evm-native' as const, network: 'arbitrum' as const, decimals: 18 as const };
const XRP = { kind: 'xrp' as const, network: 'xrpl' as const, decimals: 6 as const };
const amt = (asset: Amount['asset'], v: bigint | string): Amount => ({ asset, quantity: { kind: 'atomic', value: v.toString() } });
const eoa = (address: string): Account => ({ family: 'evm', address, chainId: 42161, model: 'eoa' });
const alice = xrplAddress(Buffer.alloc(20, 1)), bob = xrplAddress(Buffer.alloc(20, 2)), issuer = xrplAddress(Buffer.alloc(20, 3)), tagged = xrplAddress(Buffer.alloc(20, 4));

async function artifact(file: string, name: string) { return JSON.parse(await readFile(new URL(`../../out/${file}/${name}.json`, import.meta.url), 'utf8')) as { abi: unknown[]; bytecode: { object: Hex } }; }
async function deploy(from: Hex, file: string, name: string, args: unknown[] = []): Promise<Address> {
  const a = await artifact(file, name);
  const chain = defineChain({ id: 42161, name: 'local', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const wallet = createWalletClient({ account: privateKeyToAccount(from), chain, transport: http(rpc) });
  const hash = await wallet.deployContract({ abi: a.abi as never, bytecode: a.bytecode.object, args: args as never });
  const r = await client.waitForTransactionReceipt({ hash }); assert.equal(r.status, 'success'); return r.contractAddress!;
}
async function send(from: Hex, to: Address, abi: string[], fn: string, args: unknown[]) {
  const chain = defineChain({ id: 42161, name: 'local', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const wallet = createWalletClient({ account: privateKeyToAccount(from), chain, transport: http(rpc) });
  const hash = await wallet.writeContract({ address: to, abi: parseAbi(abi), functionName: fn, args } as never);
  assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
}
const codeHash = async (a: Address) => sha256Hex(Buffer.from((await client.getCode({ address: a }))!.slice(2), 'hex'));
const read = (a: Address, sig: string, args: unknown[] = []) => client.readContract({ address: a, abi: parseAbi([sig]), functionName: sig.match(/function (\w+)/)![1], args } as never) as Promise<bigint>;

function constraints(network?: 'arbitrum' | 'xrpl'): Constraints {
  const c: Constraints = { maxSpend: [amt(USDC_ASSET(), 1_000_000_000n), amt(XRP, 10_000_000n)], maxCosts: [amt(ETH, 10n ** 17n), amt(XRP, 1000n)], minReceive: [], maxDebtAfter: [amt(USDC_ASSET(), 1_000_000_000n)], minCollateralAfter: [], minSupplyAfter: [], maxSlippageBps: 50, maxStateAgeSeconds: 60 };
  if (!network) return c;
  const only = (l: Amount[]) => l.filter(a => a.asset.network === network);
  return { ...c, maxSpend: only(c.maxSpend), maxCosts: only(c.maxCosts), maxDebtAfter: only(c.maxDebtAfter) };
}
async function writeProfile(overrides: Partial<Profile> = {}, keyRef = 'approval.pem'): Promise<LoadedProfile> {
  const body: Omit<Profile, 'policyHash'> = {
    schemaVersion: 'finance.profile/1', enabled: true, live: true, networks: ['arbitrum', 'xrpl'], intents: ['earn', 'withdraw', 'borrow', 'repay', 'protect', 'payment'],
    accounts: [eoa(user.address), ...(protection ? [{ family: 'evm' as const, address: protection.account, chainId: 42161 as const, model: 'smart-account' as const }] : []), { family: 'xrpl', address: alice, model: 'native' }],
    contractDigest: CONTRACT_DIGEST, mcpUrl: 'http://127.0.0.1:9', mcpAuthTokenEnv: 'FINANCE_MCP_AUTH_TOKEN', stateDirectory: `state-${randomBytes(4).toString('hex')}`,
    signer: 'existing-evm-host', approvalPublicKeyRef: keyRef, constraints: constraints(), maxDailyNativeCost: [amt(ETH, 10n ** 18n), amt(XRP, 1_000_000n)], maxConcurrentWrites: 1, reconcileRequired: true,
    ...overrides,
  };
  const profile = { ...body, policyHash: policyHash(body) } as Profile;
  const path = join(dir, `profile-${randomBytes(4).toString('hex')}.json`);
  await writeFile(path, JSON.stringify(profile));
  return loadProfile(path);
}
function grant(p: LoadedProfile, local: LocalPlan, opts: { key?: KeyObject; account?: Account; policy?: string; ttlMs?: number; nonce?: string; issuedOffsetMs?: number } = {}): ApprovalGrant {
  const now = Date.now() + (opts.issuedOffsetMs ?? 0);
  const body = { schemaVersion: 'finance.approval/1' as const, contractDigest: CONTRACT_DIGEST, localPlanHash: local.localPlanHash, policyHash: opts.policy ?? p.profile.policyHash, account: opts.account ?? local.account, nonce: opts.nonce ?? randomBytes(32).toString('hex'), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + (opts.ttlMs ?? 120_000)).toISOString() };
  return { ...body, grantId: grantId(body), signature: edSign(null, grantSigningBytes(body), opts.key ?? approvalKey).toString('base64') };
}
const evmSigner = (key: Hex, counter?: { n: number }) => async (): Promise<FinanceSigner> => { const s = localEvmSigner(key); return { sign: l => { if (counter) counter.n++; return s.sign(l.nativePayload as EvmPayload); } }; };
const req = (command: string, extra: Record<string, unknown>) => ({ schemaVersion: 'finance.local-request/1', contractDigest: CONTRACT_DIGEST, requestId: `r-${command}-${randomBytes(3).toString('hex')}`, command, ...extra });

/** Research-side reference: builds an MCP-equivalent Plan from adapter-compiled bytes (no model text). */
async function researchPlan(adapter: EvmFinanceAdapter, account: Account, intent: Intent, draft: { from: string; to: string; data: Hex }, ref: string, permissions: Plan['permissions'] = []): Promise<Plan> {
  const fresh = await adapter.freshPayload({ kind: 'evm', chainId: 42161, from: draft.from, to: draft.to, data: draft.data, value: '0', nonce: '0', gasLimit: '0', maxFeePerGas: '0', maxPriorityFeePerGas: '0' });
  const c = constraints('arbitrum');
  return buildPlan({ request: { intent, draft }, network: 'arbitrum', account, positionRef: null, comparisonRef: null, intent, adapterRef: ref, observation: fresh.observation, requested: c, policy: c, permissions, costs: [{ ...fresh.cost, maximum: amt(ETH, BigInt((fresh.cost.maximum.quantity as { value: string }).value) * 2n) }], payload: fresh.payload as EvmPayload, expiresAt: new Date(Date.now() + 120_000).toISOString(), evidence: [] });
}
async function act(runtime: FinanceRuntime, p: LoadedProfile, plan: Plan) {
  const imported = await runtime.run(req('import-plan', { plan })); assert.equal(imported.outcome, 'ok', JSON.stringify(imported.errors));
  const sim = await runtime.run(req('simulate', { planRef: plan.planHash, policyRef: p.profile.policyHash })); assert.equal(sim.outcome, 'ok', JSON.stringify(sim.errors));
  const local = (await runtime.journal.state()).localPlans.get(sim.localPlanRef!)!.plan;
  const approvalRef = await runtime.recordGrant(grant(p, local));
  const exec = await runtime.run(req('execute', { localPlanRef: local.localPlanHash, policyRef: p.profile.policyHash, approvalRef }));
  return { sim, local, exec };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'finance-e2e-'));
  const kp = generateKeyPairSync('ed25519'); approvalKey = kp.privateKey; otherKey = generateKeyPairSync('ed25519').privateKey;
  await writeFile(join(dir, 'approval.pem'), kp.publicKey.export({ type: 'spki', format: 'pem' }));
  if (!anvilAvailable) return;
  const port = 20000 + Math.floor(Math.random() * 20000); rpc = `http://127.0.0.1:${port}`;
  anvil = spawn('anvil', ['--port', String(port), '--chain-id', '42161', '--silent'], { stdio: 'ignore' });
  client = createPublicClient({ transport: http(rpc) });
  for (let i = 0; i < 100; i++) { try { await client.getChainId(); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const M = 'FinanceMocks.sol';
  usdc = await deploy(DEPLOYER, M, 'FinMockToken'); weth = await deploy(DEPLOYER, M, 'FinMockToken');
  pool = await deploy(DEPLOYER, M, 'FinMockAavePool', [usdc, weth]);
  vDebt = await read(pool, 'function vDebt() view returns (address)') as unknown as Address; aColl = await read(pool, 'function aCollateral() view returns (address)') as unknown as Address;
  const aDebt = await read(pool, 'function aDebt() view returns (address)') as unknown as Address, vColl = await read(pool, 'function vCollateral() view returns (address)') as unknown as Address;
  const mint = ['function mint(address,uint256)'], approve = ['function approve(address,uint256) returns (bool)'];
  await send(DEPLOYER, usdc, mint, 'mint', [pool, 10_000_000_000n]); await send(DEPLOYER, weth, mint, 'mint', [user.address, 1_000_000_000n]);
  await send(USER_KEY, weth, approve, 'approve', [pool, 1_000_000_000n]);
  await send(USER_KEY, pool, ['function supply(address,uint256,address,uint16)'], 'supply', [weth, 1_000_000_000n, user.address, 0]);
  await send(USER_KEY, pool, ['function borrow(address,uint256,uint256,uint16,address)'], 'borrow', [usdc, 500_000_000n, 2n, 0, user.address]);
  const weth6 = { kind: 'erc20' as const, network: 'arbitrum' as const, address: weth.toLowerCase(), decimals: 6 };
  market = { protocol: 'aave-v3', network: 'arbitrum', pool: pool.toLowerCase(), poolCodeHash: await codeHash(pool), reserves: [{ asset: USDC_ASSET(), aToken: aDebt, debtToken: vDebt, reserveId: 0 }, { asset: weth6, aToken: aColl, debtToken: vColl, reserveId: 1 }] };
  // R3 fixture: user-owned protection account holding its own position.
  const lender = await deploy(DEPLOYER, M, 'FinMockMorphoFlash'), swap = await deploy(DEPLOYER, M, 'FinMockSwapAdapter');
  await send(DEPLOYER, usdc, mint, 'mint', [lender, 10_000_000_000n]); await send(DEPLOYER, usdc, mint, 'mint', [swap, 10_000_000_000n]);
  const account = await deploy(USER_KEY, 'FinanceProtectionAccount.sol', 'FinanceProtectionAccount', [pool, swap, lender, usdc, weth, vDebt, aColl]);
  await send(USER_KEY, account, ['function configureLender(uint8,address,bytes32,bool)'], 'configureLender', [1, lender, keccak256((await client.getCode({ address: lender }))!), true]);
  await send(DEPLOYER, weth, mint, 'mint', [account, 1_000_000_000n]);
  await send(USER_KEY, account, ['function supplyCollateral(uint256)'], 'supplyCollateral', [1_000_000_000n]);
  await send(USER_KEY, account, ['function borrowDebt(uint256)'], 'borrowDebt', [700_000_000n]);
  protection = { network: 'arbitrum', account: account.toLowerCase(), codeHash: await codeHash(account), owner: user.address.toLowerCase(), market, flashLender: lender, swapAdapter: swap };
});
after(() => { anvil?.kill(); });
const evmAdapter = (extra: Partial<{ markets: AaveMarket[]; client: PublicClient }> = {}) => new EvmFinanceAdapter('arbitrum', rpc, extra.markets ?? [market], protection ? [protection] : [], 'latest', Date.now, extra.client ?? client);

// ---------------------------------------------------------------- XRPL fake ledger (recorded shapes, not live evidence)
function xrplLedger(overrides: Record<string, (p: Record<string, unknown>) => Record<string, unknown>> = {}): XrplRpc & { calls: string[] } {
  const H = 'A'.repeat(64), at = { validated: true, ledger_hash: H, ledger_index: 100 };
  const accounts: Record<string, Record<string, unknown>> = { [alice]: { Balance: '50000000', OwnerCount: 2, Sequence: 7, Flags: 0 }, [bob]: { Balance: '30000000', OwnerCount: 0, Sequence: 1, Flags: 0 }, [issuer]: { Balance: '30000000', OwnerCount: 0, Sequence: 1, Flags: 0 }, [tagged]: { Balance: '30000000', OwnerCount: 0, Sequence: 1, Flags: 0x00020000 } };
  const loan = { index: 'B'.repeat(64), LoanBrokerID: 'C'.repeat(64), PrincipalOutstanding: '1000000', TotalValueOutstanding: '1050000', ManagementFeeOutstanding: '5000', PeriodicPayment: '87500', InterestRate: 500, PaymentRemaining: 12, NextPaymentDueDate: 0, GracePeriod: 86400, Flags: 0x00020000 };
  const handlers: Record<string, (p: Record<string, unknown>) => Record<string, unknown>> = {
    server_info: () => ({ info: { network_id: 0 } }), ledger: () => ({ ...at }),
    account_info: p => accounts[p.account as string] ? { ...at, account_data: { ...accounts[p.account as string], Account: p.account } } : { error: 'actNotFound' },
    account_lines: p => ({ ...at, lines: p.account === alice ? [{ account: issuer, currency: 'USD', balance: '50' }] : p.account === bob ? [{ account: issuer, currency: 'USD', balance: '0' }] : [] }),
    server_state: () => ({ state: { validated_ledger: { reserve_base: 1_000_000, reserve_inc: 200_000, seq: 100 } } }),
    fee: () => ({ drops: { open_ledger_fee: '12', base_fee: '10' } }),
    feature: () => ({ ABC: { name: 'LendingProtocol', enabled: true } }),
    account_objects: () => ({ ...at, account_objects: [loan] }),
    ledger_entry: p => p.index === 'C'.repeat(64) ? { ...at, node: { index: p.index, VaultID: 'D'.repeat(64) } } : p.index === 'D'.repeat(64) ? { ...at, node: { Asset: { currency: 'XRP' } } } : { error: 'entryNotFound' },
    simulate: () => ({ engine_result: 'tesSUCCESS' }),
    submit: p => ({ engine_result: 'tesSUCCESS', tx_json: { hash: createHash('sha256').update(String(p.tx_blob)).digest('hex').toUpperCase() } }),
    tx: () => ({ error: 'txnNotFound' }),
    ...overrides,
  };
  const calls: string[] = [];
  return { calls, async request(method, params) { calls.push(method); const h = handlers[method]; if (!h) return { error: 'unknownCmd' }; return h(params); } };
}
const fakeCodec: XrplCodec = { version: 'fixture', decode: b => JSON.parse(Buffer.from(b, 'hex').toString('utf8')), hashSigned: b => createHash('sha256').update(b).digest('hex'), verifySignature: b => JSON.parse(Buffer.from(b, 'hex').toString('utf8')).TxnSignature === 'SIG' };
const blob = (tx: Record<string, unknown>) => Buffer.from(JSON.stringify(tx)).toString('hex').toUpperCase();

// ================================================================= EDGE-01 boundary
test('EDGE-01 boundary: disabled profile, raw input faults and MCP transport stay typed and side-effect free', async () => {
  // E2E-01: Finance disabled → typed block, no journal or network.
  const off = await writeProfile({ enabled: false });
  let out = ''; const code = await financeCli(['--config', off.path], [Buffer.from(JSON.stringify(req('reconcile', { actionId: 'a'.repeat(64), policyRef: off.profile.policyHash })))], l => { out += l; });
  assert.equal(code, 2); assert.equal(JSON.parse(out).errors[0].code, 'FEATURE_DISABLED');
  await assert.rejects(stat(off.stateDirectory));
  // E2E-07: duplicate key / owner injection / invalid UTF-8 before any side effect.
  const on = await writeProfile();
  for (const bad of [Buffer.from('{"schemaVersion":"finance.local-request/1","schemaVersion":"x"}'), Buffer.from([0x7b, 0xc3, 0x28, 0x7d]), Buffer.from(JSON.stringify({ ...req('reconcile', { actionId: 'a'.repeat(64), policyRef: on.profile.policyHash }), owner: 'attacker' }))]) {
    out = ''; assert.equal(await financeCli(['--config', on.path], [bad], l => { out += l; }), 2);
    const r = JSON.parse(out); assert.equal(r.outcome, 'blocked'); assert.equal(r.errors[0].code, 'INVALID_INPUT'); assert.ok(!out.includes('attacker'));
  }
  await assert.rejects(stat(on.stateDirectory), 'no journal written for rejected input');
  assert.equal(await financeCli(['--config', on.path, '--rpc', 'http://evil'], [Buffer.from('{}')], () => {}), 2, 'intent cannot add endpoints');
  // MCP loopback: auth, contract binding, execution escalation and the R4 handoff.
  let forged = false;
  const server: Server = createServer(async (rq, rs) => {
    const auth = rq.headers.authorization; let body = ''; for await (const c of rq) body += c;
    if (auth !== 'Bearer good') { rs.statusCode = 401; return rs.end(); }
    const { params } = JSON.parse(body) as { params: { name: string; arguments: { requestId: string; network: string } } };
    const base = { schemaVersion: 'finance.response/1', contractDigest: CONTRACT_DIGEST, requestId: params.arguments.requestId, network: params.arguments.network, warnings: [], execution: forged, errors: [] };
    const data = params.name === 'finance_prediction_context'
      ? { status: 'success', kind: 'prediction-context', data: { venue: 'limitless', network: 'base', marketRef: 'btc-above-100k', eligible: 'UNKNOWN', operatingState: 'ACTIVE', resolutionRuleRef: { id: 'a'.repeat(64), contentHash: 'a'.repeat(64), expiresAt: null }, bookRef: { id: 'a'.repeat(64), contentHash: 'a'.repeat(64), expiresAt: null }, handoffRef: null, execution: false } }
      : { status: 'success', kind: 'capabilities', data: [] };
    rs.setHeader('content-type', 'application/json'); rs.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ...base, ...data }) }] } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const capReq = { schemaVersion: 'finance.request/1', requestId: 'cap-1', idempotency_key: 'finance:capabilities:1', network: 'xrpl', operation: 'capabilities' };
  assert.equal(await errCode(new FinanceClient(url, 'bad').call(capReq)), 'AUTH_REQUIRED');
  assert.equal(await errCode(new FinanceClient(url, undefined).call(capReq)), 'AUTH_REQUIRED');
  assert.equal((await new FinanceClient(url, 'good').call(capReq)).kind, 'capabilities');
  assert.equal(await errCode(() => new FinanceClient('http://evil.example/mcp', 'good').call(capReq)), 'POLICY_REJECTED', 'plain HTTP only on loopback');
  const ctx = await new FinanceClient(url, 'good').call({ schemaVersion: 'finance.request/1', requestId: 'pc-1', idempotency_key: 'finance:prediction-context:1', network: 'base', operation: 'prediction-context', venue: 'limitless', marketSlug: 'btc-above-100k', contractDigest: CONTRACT_DIGEST });
  const handoff = predictionHandoff(ctx, 'pc-1');
  assert.deepEqual(handoff.payload, { mode: 'paper', marketSlug: 'btc-above-100k' }, 'R4 handoff is read-only paper context');
  assert.ok(!JSON.stringify(handoff).includes('grant'), 'no Finance authority crosses into prediction');
  forged = true;
  assert.equal(await errCode(new FinanceClient(url, 'good').call(capReq)), 'INVALID_INPUT', 'MCP execution escalation rejected');
  server.close();
  proven('EDGE-01');
});

// ================================================================= EDGE-02 state
test('EDGE-02 state: pinned EVM reads, reorg rejection and XRPL loan joins keep native meaning', async t => {
  // XRPL (E2E-08/09/10, fixture ledger).
  const xa = new XrplFinanceAdapter(xrplLedger(), 0, fakeCodec);
  const acct: Account = { family: 'xrpl', address: alice, model: 'native' };
  const report = await xa.readPositions(acct);
  assert.equal(report.coverage.complete, true);
  const loan = report.positions[0] as Extract<typeof report.positions[number], { kind: 'xrpl-loan' }>;
  assert.equal(loan.interestRateTenthsBps, 500); assert.equal(loan.nextDueAt, '2000-01-01T00:00:00.000Z'); assert.equal(loan.loanScale, null);
  assert.deepEqual(loan.flags, ['impaired']); assert.equal((loan.principalOutstanding.quantity as { value: string }).value, '1000000');
  const bal = await xa.readAccount(acct);
  assert.equal((bal.reservedXrp!.quantity as { value: string }).value, '1400000', 'reserve read live: base + 2 * inc');
  const off = await new XrplFinanceAdapter(xrplLedger({ feature: () => ({ ABC: { name: 'LendingProtocol', enabled: false } }) }), 0).readPositions(acct);
  assert.equal(off.coverage.complete, false); assert.equal(off.positions.length, 0, 'unavailable amendment never becomes zero debt');
  const mpt = await new XrplFinanceAdapter(xrplLedger({ ledger_entry: p => p.index === 'C'.repeat(64) ? { validated: true, ledger_hash: 'A'.repeat(64), ledger_index: 100, node: { VaultID: 'D'.repeat(64) } } : { validated: true, ledger_hash: 'A'.repeat(64), ledger_index: 100, node: { Asset: { mpt_issuance_id: '0'.repeat(48) } } } }), 0).readPositions(acct);
  assert.equal(mpt.coverage.complete, false); assert.equal(mpt.positions.length, 0, 'MPT vault asset is a v2 capability gap');
  assert.equal(await errCode(new XrplFinanceAdapter(xrplLedger({ account_info: () => ({ validated: true, ledger_hash: 'E'.repeat(64), ledger_index: 100, account_data: {} }) }), 0).readAccount(acct)), 'STALE_STATE', 'mixed ledger rejected');
  assert.equal(await errCode(new XrplFinanceAdapter(xrplLedger(), 1).readAccount(acct)), 'WRONG_CHAIN', 'network identity mismatch');
  if (!anvilAvailable) { t.diagnostic('BLOCKED: anvil unavailable; EVM state rows not proven'); return; }
  // EVM (E2E-05/06, local chain).
  const a = evmAdapter();
  const pos = await a.readPositions(eoa(user.address));
  assert.equal(pos.coverage.complete, true); const p = pos.positions[0] as Extract<typeof pos.positions[number], { kind: 'evm-collateralized' }>;
  assert.equal((p.debt[0].quantity as { value: string }).value, '500000000'); assert.equal((p.collateral[0].quantity as { value: string }).value, '1000000000'); assert.equal(p.healthFactor, '1.6');
  const empty = (await a.readPositions(eoa(deployer.address))).positions[0] as typeof p;
  assert.equal(empty.noDebt, true); assert.equal(empty.healthFactor, null, 'no Infinity/uint256 sentinel as a risk score');
  let flip = 0;
  const reorging = new Proxy(client, { get(target, prop) { if (prop === 'getBlock') return async (args: unknown) => { const b = await target.getBlock(args as never); return flip++ % 2 ? { ...b, hash: ('0x' + 'f'.repeat(64)) as Hex } : b; }; return Reflect.get(target, prop); } });
  assert.equal(await errCode(evmAdapter({ client: reorging as PublicClient }).readPositions(eoa(user.address))), 'STALE_STATE');
  const drifted = await evmAdapter({ markets: [{ ...market, poolCodeHash: '0'.repeat(64) }] }).readPositions(eoa(user.address));
  assert.equal(drifted.coverage.complete, false); assert.equal(drifted.coverage.missing[0].reasonCode, 'CODE_DRIFT');
  proven('EDGE-02');
});

// ================================================================= EDGE-03 authority
test('EDGE-03 authority: grants bind key/policy/plan/account/time, are one-use, and writes hold one lease', async t => {
  if (!anvilAvailable) { t.skip('BLOCKED: anvil unavailable'); return; }
  const p = await writeProfile(), counter = { n: 0 };
  const a = evmAdapter(), runtime = new FinanceRuntime({ profile: p, adapters: { arbitrum: a }, signer: evmSigner(USER_KEY, counter) });
  const plan = await researchPlan(a, eoa(user.address), 'repay', { from: user.address, ...a.compileApproval(USDC_ASSET(), market.pool, 5_000_000n) }, adapterRef(market), [{ kind: 'erc20-allowance', target: market.pool, asset: USDC_ASSET(), maximum: { kind: 'atomic', value: '5000000' } }]);
  await runtime.run(req('import-plan', { plan }));
  const sim = await runtime.run(req('simulate', { planRef: plan.planHash, policyRef: p.profile.policyHash })); assert.equal(sim.outcome, 'ok', JSON.stringify(sim.errors));
  const local = (await runtime.journal.state()).localPlans.get(sim.localPlanRef!)!.plan;
  const pg = { kind: 'order', planHash: 'sha256:' + local.localPlanHash };
  const cases: Array<[string, () => ApprovalGrant]> = [
    ['wrong key', () => grant(p, local, { key: otherKey })],
    ['wrong policy', () => grant(p, local, { policy: 'f'.repeat(64) })],
    ['wrong account', () => grant(p, local, { account: eoa(deployer.address) })],
    ['wrong plan', () => grant(p, { ...local, localPlanHash: 'e'.repeat(64) })],
    ['expired', () => grant(p, local, { issuedOffsetMs: -10 * 60_000, ttlMs: 60_000 })],
    ['over-long ttl', () => grant(p, local, { ttlMs: 60 * 60_000 })],
    ['prediction-domain signature', () => { const g = grant(p, local); return { ...g, signature: edSign(null, predictionGrantBytes(pg as never), approvalKey).toString('base64') }; }],
  ];
  for (const [name, make] of cases) assert.notEqual(await errCode(runtime.recordGrant(make())), 'OK', name);
  const g = grant(p, local), approvalRef = await runtime.recordGrant(g);
  assert.equal(await errCode(runtime.recordGrant(g)), 'APPROVAL_REPLAY');
  assert.equal(await errCode(runtime.recordGrant(grant(p, local, { nonce: g.nonce }))), 'APPROVAL_REPLAY', 'nonce reserved atomically');
  // Concurrent process holds the account lease → the second writer is blocked, not queued.
  const blocked = await runtime.journal.lease(local.account, local.network, () => runtime.run(req('execute', { localPlanRef: local.localPlanHash, policyRef: p.profile.policyHash, approvalRef })));
  assert.equal(blocked.outcome, 'blocked'); assert.equal(blocked.errors[0].code, 'IDEMPOTENCY_CONFLICT'); assert.equal(counter.n, 0, 'no signer access');
  const readOnly = await writeProfile({ live: false }); // live=false must block writes
  const ro = new FinanceRuntime({ profile: { ...readOnly, stateDirectory: p.stateDirectory }, adapters: { arbitrum: a }, signer: evmSigner(USER_KEY, counter) });
  assert.equal((await ro.run(req('execute', { localPlanRef: local.localPlanHash, policyRef: readOnly.profile.policyHash, approvalRef }))).errors[0].code, 'FEATURE_DISABLED');
  const ok = await runtime.run(req('execute', { localPlanRef: local.localPlanHash, policyRef: p.profile.policyHash, approvalRef }));
  assert.equal(ok.outcome, 'ok', JSON.stringify(ok.errors)); assert.equal(counter.n, 1);
  const again = await runtime.run(req('execute', { localPlanRef: local.localPlanHash, policyRef: p.profile.policyHash, approvalRef }));
  assert.equal(again.errors[0].code, 'APPROVAL_REPLAY'); assert.equal(counter.n, 1, 'one-use grant');
  await runtime.run(req('reconcile', { actionId: ok.receipt!.actionId, policyRef: p.profile.policyHash }));
  proven('EDGE-03');
});

// ================================================================= EDGE-04 native
test('EDGE-04 native: exact EVM approve+repay and R3 protect on a local chain, XRPL Payment via sign-only host', async t => {
  // XRPL Payment (E2E-08/20) with fixture codec/host; never live evidence.
  const xp = await writeProfile({ signer: 'external-xrpl-host' });
  const xrplHost = { networkId: 0, sign: async (tx: XrplPayload['tx']) => blob({ ...tx, SigningPubKey: 'ED00', TxnSignature: 'SIG' }) };
  assert.equal(await errCode(() => admitSignHost({ ...xrplHost, signAndSend: () => null }, 0)), 'POLICY_REJECTED');
  assert.equal(await errCode(() => admitSignHost({ ...xrplHost, networkId: 1 }, 0)), 'WRONG_CHAIN', 'testnet host for mainnet profile');
  let submitted = '';
  const ledger = xrplLedger({ tx: () => submitted ? { validated: true, Account: alice, Sequence: 7, Fee: '12', meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '1000000' } } : { error: 'txnNotFound' } });
  const xa = new XrplFinanceAdapter(ledger, 0, fakeCodec);
  const acct: Account = { family: 'xrpl', address: alice, model: 'native' };
  assert.equal(await errCode(xa.buildPayment(acct, tagged, amt(XRP, 1_000_000n), null)), 'DESTINATION_TAG_REQUIRED');
  assert.equal(await errCode(xa.buildPayment(acct, bob, amt(XRP, 49_000_000n), null)), 'RESERVE_INSUFFICIENT');
  assert.equal(await errCode(xa.buildPayment(acct, tagged, { asset: { kind: 'xrpl-issued', network: 'xrpl', currency: 'USD', issuer }, quantity: { kind: 'issued-decimal', coefficient: '5', exponent: 0 } }, 1)), 'TRUSTLINE_REQUIRED');
  const issuedOk = await xa.buildPayment(acct, bob, { asset: { kind: 'xrpl-issued', network: 'xrpl', currency: 'USD', issuer }, quantity: { kind: 'issued-decimal', coefficient: '125', exponent: -2 } }, null);
  assert.deepEqual(issuedOk.payload.tx.Amount, { currency: 'USD', issuer, value: '1.25' });
  const built = await xa.buildPayment(acct, bob, amt(XRP, 1_000_000n), null);
  assert.equal(built.payload.tx.Fee, '12'); assert.equal(built.payload.tx.Sequence, 7); assert.equal(built.payload.tx.LastLedgerSequence, 120); assert.equal(built.payload.tx.Flags, 0);
  const xplan = buildPlan({ request: { payment: 1 }, network: 'xrpl', account: acct, positionRef: null, comparisonRef: null, intent: 'payment', adapterRef: xa.identityHash, observation: built.observation, requested: constraints('xrpl'), policy: constraints('xrpl'), permissions: [{ kind: 'native-signature', target: alice, asset: null, maximum: null }], costs: built.costs, payload: built.payload, expiresAt: new Date(Date.now() + 60_000).toISOString(), evidence: [] });
  const xrt = new FinanceRuntime({ profile: xp, adapters: { xrpl: xa }, signer: async () => ({ sign: l => xrplHost.sign((l.nativePayload as XrplPayload).tx) }) });
  // Rejections of the signed artifact before any submit.
  const wrongHost = new FinanceRuntime({ profile: xp, adapters: { xrpl: xa }, journal: xrt.journal, signer: async () => ({ sign: async () => '' }) });
  await xrt.run(req('import-plan', { plan: xplan }));
  const xs = await xrt.run(req('simulate', { planRef: xplan.planHash, policyRef: xp.profile.policyHash })); assert.equal(xs.outcome, 'ok', JSON.stringify(xs.errors));
  const xlocal = (await xrt.journal.state()).localPlans.get(xs.localPlanRef!)!.plan;
  const g1 = await xrt.recordGrant(grant(xp, xlocal));
  const empty = await wrongHost.run(req('execute', { localPlanRef: xlocal.localPlanHash, policyRef: xp.profile.policyHash, approvalRef: g1 }));
  assert.equal(empty.errors[0].code, 'SIMULATION_FAILED', 'empty blob is not a transaction hash'); assert.ok(!ledger.calls.includes('submit'));
  const g2 = await xrt.recordGrant(grant(xp, xlocal));
  const xe = await xrt.run(req('execute', { localPlanRef: xlocal.localPlanHash, policyRef: xp.profile.policyHash, approvalRef: g2 }));
  assert.equal(xe.outcome, 'ok', JSON.stringify(xe.errors)); submitted = xe.receipt!.transactionId!;
  const xr = await xrt.run(req('reconcile', { actionId: xe.receipt!.actionId, policyRef: xp.profile.policyHash }));
  assert.equal(xr.receipt!.state, 'FINALIZED'); assert.equal(xr.receipt!.reconciliation, 'MATCH'); assert.equal(xr.receipt!.verification, 'local-reported');
  const nosim = new FinanceRuntime({ profile: xp, adapters: { xrpl: new XrplFinanceAdapter(xrplLedger({ simulate: () => ({ error: 'unknownCmd' }) }), 0, fakeCodec) } });
  await nosim.run(req('import-plan', { plan: xplan }));
  assert.equal((await nosim.run(req('simulate', { planRef: xplan.planHash, policyRef: xp.profile.policyHash }))).errors[0].code, 'SIMULATION_UNAVAILABLE', 'no estimate labelled native');
  if (!anvilAvailable) { t.diagnostic('BLOCKED: anvil unavailable; EVM native rows not proven'); return; }
  // EVM ordinary approve + repay (E2E-18) — exact calldata, real caller, receipt + position reconciliation.
  const p = await writeProfile(), a = evmAdapter();
  const runtime = new FinanceRuntime({ profile: p, adapters: { arbitrum: a }, signer: evmSigner(USER_KEY) });
  const me = eoa(user.address);
  const debtBefore = await read(vDebt, 'function balanceOf(address) view returns (uint256)', [user.address]);
  const approve = await researchPlan(a, me, 'repay', { from: user.address, ...a.compileApproval(USDC_ASSET(), market.pool, 100_000_000n) }, adapterRef(market));
  const ap = await act(runtime, p, approve); assert.equal(ap.exec.outcome, 'ok', JSON.stringify(ap.exec.errors));
  assert.equal((await runtime.run(req('reconcile', { actionId: ap.exec.receipt!.actionId, policyRef: p.profile.policyHash }))).receipt!.state, 'CONFIRMED');
  const repayDraft = a.compileAction(me, 'repay', market, USDC_ASSET(), 100_000_000n);
  const repay = await researchPlan(a, me, 'repay', { from: user.address, to: repayDraft.to, data: repayDraft.data }, adapterRef(market), repayDraft.permissions);
  const rp = await act(runtime, p, repay); assert.equal(rp.exec.outcome, 'ok', JSON.stringify(rp.exec.errors));
  const rr = await runtime.run(req('reconcile', { actionId: rp.exec.receipt!.actionId, policyRef: p.profile.policyHash }));
  assert.equal(rr.receipt!.state, 'CONFIRMED'); assert.equal(rr.receipt!.reconciliation, 'MATCH');
  assert.equal(await read(vDebt, 'function balanceOf(address) view returns (uint256)', [user.address]), debtBefore - 100_000_000n);
  // Tampered calldata / unbounded approval / unadmitted target never reach simulation (E2E-13/14).
  const foreign = a.compileAction(eoa(deployer.address), 'repay', market, USDC_ASSET(), 1n);
  for (const [name, draft, expect] of [
    ['foreign beneficiary', { from: user.address, to: foreign.to, data: foreign.data }, 'OWNER_SCOPE_MISMATCH'],
    ['unbounded approval', { from: user.address, ...a.compileApproval(USDC_ASSET(), market.pool, (1n << 256n) - 1n) }, 'POLICY_REJECTED'],
    ['foreign spender', { from: user.address, ...a.compileApproval(USDC_ASSET(), deployer.address, 1n) }, 'POLICY_REJECTED'],
  ] as const) {
    const bad = buildPlan({ request: { name }, network: 'arbitrum', account: me, positionRef: null, comparisonRef: null, intent: 'repay', adapterRef: adapterRef(market), observation: repay.observation, requested: constraints('arbitrum'), policy: constraints('arbitrum'), permissions: [], costs: repay.costs, payload: { ...(repay.nativePayload as EvmPayload), to: draft.to, data: draft.data }, expiresAt: repay.expiresAt, evidence: [] });
    await runtime.run(req('import-plan', { plan: bad }));
    assert.equal((await runtime.run(req('simulate', { planRef: bad.planHash, policyRef: p.profile.policyHash }))).errors[0].code, expect, name);
  }
  // R3 protect via the position-owning smart account (E2E-19 TS path; Forge covers each revert).
  const prot = protection, accountRef: Account = { family: 'evm', address: prot.account, chainId: 42161, model: 'smart-account' };
  const draft = a.compileProtect(prot, { flashAmount: 300_000_000n, withdrawAmount: 300_000_000n, minSwapOut: 300_000_000n, maxDebtAfter: 400_000_000n, minCollateralAfter: 700_000_000n, nonce: ('0x' + randomBytes(32).toString('hex')) as Hex, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) });
  const pp = await act(runtime, p, await researchPlan(a, accountRef, 'protect', draft, adapterRef(prot)));
  assert.equal(pp.exec.outcome, 'ok', JSON.stringify(pp.exec.errors));
  assert.ok(pp.local.pins.some(x => x.kind === 'owner-model') && pp.local.pins.some(x => x.kind === 'bytecode'));
  assert.equal(await read(vDebt, 'function balanceOf(address) view returns (uint256)', [prot.account as Address]), 400_000_000n, 'debt reduced atomically');
  proven('EDGE-04');
});

// ================================================================= EDGE-05 recovery
test('EDGE-05 recovery: ambiguous send stays UNKNOWN, reconciles by known hash, mismatches halt, torn journal fails closed', async t => {
  if (!anvilAvailable) { t.skip('BLOCKED: anvil unavailable'); return; }
  const p = await writeProfile(), real = evmAdapter(), me = eoa(user.address);
  let drop = true;
  const flaky = new Proxy(real, { get(target, prop) { if (prop === 'submitKnownArtifact') return async (s: string) => { if (drop) throw new Error('socket hang up'); return target.submitKnownArtifact(s); }; const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v; } }) as FinanceAdapter;
  const runtime = new FinanceRuntime({ profile: p, adapters: { arbitrum: flaky }, signer: evmSigner(USER_KEY) });
  const plan = await researchPlan(real, me, 'repay', { from: user.address, ...real.compileApproval(USDC_ASSET(), market.pool, 7n) }, adapterRef(market));
  const first = await act(runtime, p, plan);
  assert.equal(first.exec.outcome, 'unknown'); assert.equal(first.exec.errors[0].code, 'SUBMISSION_UNKNOWN'); assert.equal(first.exec.receipt!.state, 'UNKNOWN');
  const actionId = first.exec.receipt!.actionId;
  // A second write for the account is blocked until the known reference is reconciled (no resend, no nonce reuse).
  const second = await researchPlan(real, me, 'repay', { from: user.address, ...real.compileApproval(USDC_ASSET(), market.pool, 8n) }, adapterRef(market));
  const blocked = await act(runtime, p, second).catch(e => e);
  assert.equal(blocked.exec?.errors?.[0]?.code ?? (blocked as FinanceError).code, 'SUBMISSION_UNKNOWN');
  // Restart: a fresh runtime reconciles only by the stored hash; nothing on chain yet → still UNKNOWN.
  const restarted = new FinanceRuntime({ profile: p, adapters: { arbitrum: real }, signer: evmSigner(USER_KEY) });
  assert.equal((await restarted.run(req('reconcile', { actionId, policyRef: p.profile.policyHash }))).outcome, 'unknown');
  // The lost broadcast actually landed (ack lost): the stored artifact is the one that confirms.
  const signed = await restarted.journal.readSigned(actionId); assert.ok(signed);
  assert.equal((await stat(join(p.stateDirectory, 'signed', actionId))).mode & 0o077, 0, 'signed material owner-only');
  await real.submitKnownArtifact(signed!);
  const rec = await restarted.run(req('reconcile', { actionId, policyRef: p.profile.policyHash }));
  assert.equal(rec.receipt!.state, 'CONFIRMED'); assert.equal(rec.receipt!.verification, 'local-reported');
  // Economic mismatch halts new writes even though the transaction succeeded (E2E-22).
  const mismatching = new Proxy(real, { get(target, prop) { if (prop === 'reconcileKnownReference') return async (...args: Parameters<FinanceAdapter['reconcileKnownReference']>) => ({ ...(await target.reconcileKnownReference(...args)), reconciliation: 'MISMATCH' }); const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v; } }) as FinanceAdapter;
  const halting = new FinanceRuntime({ profile: p, adapters: { arbitrum: mismatching }, signer: evmSigner(USER_KEY) });
  drop = false;
  const third = await researchPlan(real, me, 'repay', { from: user.address, ...real.compileApproval(USDC_ASSET(), market.pool, 9n) }, adapterRef(market));
  const t3 = await act(halting, p, third); assert.equal(t3.exec.outcome, 'ok', JSON.stringify(t3.exec.errors));
  const h = await halting.run(req('reconcile', { actionId: t3.exec.receipt!.actionId, policyRef: p.profile.policyHash }));
  assert.equal(h.outcome, 'blocked'); assert.equal(h.receipt!.state, 'HALTED'); assert.equal(h.errors[0].code, 'RECONCILIATION_MISMATCH');
  const fourth = await researchPlan(real, me, 'repay', { from: user.address, ...real.compileApproval(USDC_ASSET(), market.pool, 10n) }, adapterRef(market));
  const afterHalt = await act(halting, p, fourth).catch(e => e);
  assert.equal(afterHalt.exec?.errors?.[0]?.code ?? (afterHalt as FinanceError).code, 'RECONCILIATION_MISMATCH');
  // Torn or edited journal fails closed.
  const j = new FinanceJournal(p.stateDirectory);
  await appendFile(j.path, '{"sequence":');
  assert.equal(await errCode(j.state()), 'RECONCILIATION_MISMATCH');
  proven('EDGE-05');
});
