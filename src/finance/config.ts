import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  CONTRACT_DIGEST, FinanceError, checkAccount, checkConstraints, grantId, grantSigningBytes, insist, parseTimestamp, policyHash, sameAccount, strictParse, validate,
  type ApprovalGrant, type Intent, type LocalPlan, type Network, type Profile,
} from './contracts.js';

export interface LoadedProfile { profile: Profile; path: string; stateDirectory: string; approvalKey: KeyObject | null }
export const MAX_GRANT_TTL_MS = 15 * 60_000;

/**
 * Local owner policy is authoritative. The profile is self-hashed: its policyHash must equal the
 * recomputed value, so a profile edit is visible as a new policy and invalidates prior grants.
 */
export async function loadProfile(path: string): Promise<LoadedProfile> {
  const profile = validate<Profile>('Profile', strictParse(await readFile(path)));
  insist(profile.contractDigest === CONTRACT_DIGEST, 'CONTRACT_MISMATCH', 'profile');
  insist(profile.policyHash === policyHash(profile), 'POLICY_REJECTED', 'policy-hash');
  insist(new Set(profile.networks).size === profile.networks.length, 'INVALID_INPUT', 'duplicate-network');
  for (const a of profile.accounts) { const n = a.family === 'xrpl' ? 'xrpl' : (Object.entries({ arbitrum: 42161, base: 8453, robinhood: 4663 }).find(([, id]) => id === a.chainId)![0] as Network); checkAccount(a, n); insist(profile.networks.includes(n), 'POLICY_REJECTED', 'account-network'); }
  for (const n of profile.networks) checkConstraints({ ...profile.constraints, ...filterNetwork(profile.constraints, n) }, n);
  const url = new URL(profile.mcpUrl);
  insist(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'POLICY_REJECTED', 'mcp-url-tls');
  const base = dirname(resolve(path));
  const stateDirectory = isAbsolute(profile.stateDirectory) ? profile.stateDirectory : resolve(base, profile.stateDirectory);
  let approvalKey: KeyObject | null = null;
  if (profile.approvalPublicKeyRef) {
    const ref = isAbsolute(profile.approvalPublicKeyRef) ? profile.approvalPublicKeyRef : resolve(base, profile.approvalPublicKeyRef);
    try { approvalKey = createPublicKey(await readFile(ref)); } catch { throw new FinanceError('POLICY_REJECTED', 'approval-key'); }
    insist(approvalKey.asymmetricKeyType === 'ed25519', 'POLICY_REJECTED', 'approval-key-type');
  }
  return { profile, path, stateDirectory, approvalKey };
}
const filterNetwork = (c: Profile['constraints'], n: Network) => ({
  maxSpend: c.maxSpend.filter(a => a.asset.network === n), maxCosts: c.maxCosts.filter(a => a.asset.network === n), minReceive: c.minReceive.filter(a => a.asset.network === n),
  maxDebtAfter: c.maxDebtAfter.filter(a => a.asset.network === n), minCollateralAfter: c.minCollateralAfter.filter(a => a.asset.network === n), minSupplyAfter: c.minSupplyAfter.filter(a => a.asset.network === n),
});
/** Policy constraints scoped to one network, for intersection with a request. */
export function policyConstraints(profile: Profile, network: Network): Profile['constraints'] { return { ...profile.constraints, ...filterNetwork(profile.constraints, network) }; }

export function admitAction(p: LoadedProfile, network: Network, intent: Intent, account: LocalPlan['account'], opts: { write: boolean }): void {
  insist(p.profile.enabled, 'FEATURE_DISABLED');
  insist(p.profile.networks.includes(network), 'POLICY_REJECTED', 'network');
  insist(p.profile.intents.includes(intent), 'POLICY_REJECTED', 'intent');
  insist(p.profile.accounts.some(a => sameAccount(a, account)), 'OWNER_SCOPE_MISMATCH');
  if (opts.write) {
    insist(p.profile.live, 'FEATURE_DISABLED', 'live');
    insist(p.profile.signer !== 'none', 'PERMISSION_MISSING', 'signer');
    insist(p.approvalKey, 'APPROVAL_REQUIRED', 'approval-key');
  }
}

/**
 * Finance-domain grant check. The trusted key comes only from the owner profile; replay is
 * prevented by the journal (nonce reservation), not here.
 */
export function verifyGrant(p: LoadedProfile, input: unknown, plan: LocalPlan, now: number): ApprovalGrant {
  insist(p.approvalKey, 'APPROVAL_REQUIRED');
  const g = validate<ApprovalGrant>('ApprovalGrant', input);
  insist(g.contractDigest === CONTRACT_DIGEST, 'CONTRACT_MISMATCH', 'grant');
  insist(g.grantId === grantId(g), 'APPROVAL_REQUIRED', 'grant-id');
  let valid = false;
  try { valid = verify(null, grantSigningBytes(g), p.approvalKey, Buffer.from(g.signature, 'base64')); } catch { /* malformed signature never leaks detail */ }
  insist(valid, 'APPROVAL_REQUIRED', 'grant-signature');
  insist(g.policyHash === p.profile.policyHash, 'APPROVAL_REQUIRED', 'grant-policy');
  insist(g.localPlanHash === plan.localPlanHash, 'APPROVAL_REQUIRED', 'grant-plan');
  insist(sameAccount(g.account, plan.account), 'APPROVAL_REQUIRED', 'grant-account');
  const issued = parseTimestamp(g.issuedAt), expires = parseTimestamp(g.expiresAt);
  insist(issued <= now && expires > issued && expires - issued <= MAX_GRANT_TTL_MS, 'APPROVAL_REQUIRED', 'grant-time');
  insist(now < expires, 'EXPIRED_PLAN', 'grant-expired');
  return g;
}
