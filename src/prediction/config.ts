import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { addr, canonicalBytes, date, insist, policyHash, raw, unsigned, validate, type Action, type ExecutionGrant, type Limits, type Mode, type PredictionConfig, type TradePlan } from './contracts.js';

export function endpoint(value: string, profile: PredictionConfig['transportProfile'], expectedHost?: string): URL {
  let u: URL; try { u = new URL(value); } catch { throw new Error('TRANSPORT_INVALID'); }
  insist(!u.username && !u.password && !u.hash && !u.search, 'TRANSPORT_INVALID');
  const local = ['127.0.0.1', '[::1]'].includes(u.hostname);
  insist(profile === 'fixture' ? local && ['http:', 'ws:'].includes(u.protocol) : !local && ['https:', 'wss:'].includes(u.protocol), 'TRANSPORT_INVALID');
  if (profile === 'production' && expectedHost) insist(u.hostname === expectedHost, 'TRANSPORT_HOST_UNAPPROVED');
  return u;
}
export async function loadPredictionConfig(path: string): Promise<PredictionConfig> {
  const c = validate<PredictionConfig>('PredictionConfig', JSON.parse(await readFile(path, 'utf8')));
  c.address = addr(c.address); c.stateDir = resolve(c.stateDir);
  endpoint(c.apiUrl, c.transportProfile, 'api.limitless.exchange'); endpoint(c.rpcUrl, c.transportProfile); endpoint(c.wsUrl, c.transportProfile, 'ws.limitless.exchange');
  insist(!c.apiUrl.endsWith('/') && new URL(c.apiUrl).pathname === '/', 'TRANSPORT_INVALID');
  insist(new Set(c.allowedMarkets).size === c.allowedMarkets.length, 'CONFIG_DUPLICATE_MARKET');
  insist(new Set(c.pins.map(p => p.address.toLowerCase())).size === c.pins.length, 'CONFIG_DUPLICATE_PIN');
  for (const p of c.pins) p.address = addr(p.address);
  raw(c.paperCashRaw);
  if (c.live) { insist(c.enabled && c.eligible && c.eligibilityEvidence.length > 0, 'LIVE_CONFIG_INCOMPLETE'); insist(c.approvalPublicKey.length > 0 && c.allowedMarkets.length > 0 && c.pins.length > 0, 'LIVE_CONFIG_INCOMPLETE'); }
  return c;
}
export function effectiveLimits(a: Limits, b: Limits): Limits {
  const result = {} as Record<keyof Limits, string | number>;
  for (const key of Object.keys(a) as Array<keyof Limits>) result[key] = typeof a[key] === 'number' ? Math.min(a[key] as number, b[key] as number) : (raw(a[key] as string) < raw(b[key] as string) ? a[key] : b[key]);
  return result as unknown as Limits;
}
export function grantSigningBytes(grant: Omit<ExecutionGrant, 'signature'>): Buffer { return Buffer.concat([Buffer.from('prediction/grant/1\n'), canonicalBytes(grant)]); }
export function verifyGrant(config: PredictionConfig, input: unknown, action: Action, mode: Mode, now: number, plan?: TradePlan, cleanup = false): ExecutionGrant {
  const g = validate<ExecutionGrant>('ExecutionGrant', input);
  insist(g.accountId === config.accountId && g.policyHash === policyHash(config), 'AUTHORITY_BINDING_MISMATCH');
  let valid = false;
  try { valid = verify(null, grantSigningBytes(unsigned(g)), createPublicKey(config.approvalPublicKey), Buffer.from(g.signature, 'base64')); } catch { /* Untrusted key/signature never escapes as provider detail. */ }
  insist(valid, 'AUTHORITY_INVALID_SIGNATURE');
  const issued = date(g.issuedAt), expires = date(g.expiresAt);
  insist(issued <= now && expires > issued && expires - issued <= config.grantMaxTtlMs, 'AUTHORITY_INVALID_TIME');
  insist(now < expires || (cleanup && action === 'cancel' && g.cleanupCancel), 'AUTHORITY_EXPIRED');
  insist(g.actions.includes(action), 'ACTION_UNAUTHORIZED');
  if (plan) {
    insist(g.marketSlugs.includes(plan.market.slug), 'MARKET_UNAUTHORIZED');
    if (mode === 'assisted') insist(g.kind === 'order' && g.planHash === plan.planHash, 'PLAN_UNAUTHORIZED');
    else insist(mode === 'autonomous' && g.kind === 'session' && g.planHash === null, 'SESSION_UNAUTHORIZED');
  }
  return g;
}
export interface PredictionSecrets { tokenId: string; tokenSecret: string }
/** Called only by the trusted live adapter, never by paper/public commands. */
export function hmacSecrets(config: PredictionConfig): PredictionSecrets {
  const tokenId = process.env[config.tokenIdEnv], tokenSecret = process.env[config.tokenSecretEnv];
  insist(tokenId && tokenSecret && /^[A-Za-z0-9+/]+={0,2}$/.test(tokenSecret), 'CREDENTIALS_UNAVAILABLE');
  return { tokenId, tokenSecret };
}
export async function loadTradingAccount(config: PredictionConfig): Promise<ReturnType<typeof privateKeyToAccount>> {
  const path = process.env[config.signerKeyFileEnv]; insist(path, 'SIGNER_UNAVAILABLE');
  const s = await stat(path); insist(s.isFile() && (s.mode & 0o077) === 0, 'SIGNER_FILE_PERMISSIONS');
  const key = (await readFile(path, 'utf8')).trim(); insist(/^0x[a-fA-F0-9]{64}$/.test(key), 'SIGNER_INVALID');
  const account = privateKeyToAccount(key as Hex); insist(account.address === config.address, 'SIGNER_ACCOUNT_MISMATCH'); return account;
}
export function sameAddress(a: string, b: Address): boolean { return addr(a) === b; }
