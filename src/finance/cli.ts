import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTRACT_DIGEST, FinanceError, insist, strictParse, toErrorRecord, type EvmNetwork, type LocalPlan, type Network } from './contracts.js';
import { loadProfile, type LoadedProfile } from './config.js';
import { FinanceClient } from './client.js';
import { EvmFinanceAdapter, loadEvmSigner, type EvmMarket, type ProtectionAccount } from './evm.js';
import { XrplFinanceAdapter, admitSignHost, httpXrplRpc, loadXrplCodec } from './xrpl.js';
import { FinanceRuntime } from './runtime.js';
import type { FinanceAdapter, FinanceSigner } from './adapter.js';

/** Host-owned adapter manifest (never part of a request): admitted markets, RPC env names, optional XRPL codec pin. */
export interface AdapterManifest {
  schemaVersion: 'finance.adapters/1';
  evm?: Partial<Record<EvmNetwork, { rpcUrlEnv: string; finality: 'safe' | 'finalized' | 'latest'; markets: EvmMarket[]; protection?: ProtectionAccount[] }>>;
  xrpl?: { rpcUrlEnv: string; networkId: number; codecVersion: string | null; signHostModule: string | null };
}

export async function buildAdapters(manifest: AdapterManifest, env: NodeJS.ProcessEnv = process.env): Promise<Partial<Record<Network, FinanceAdapter>>> {
  insist(manifest.schemaVersion === 'finance.adapters/1', 'CONTRACT_MISMATCH', 'adapter-manifest');
  const out: Partial<Record<Network, FinanceAdapter>> = {};
  for (const [network, cfg] of Object.entries(manifest.evm ?? {}) as Array<[EvmNetwork, NonNullable<AdapterManifest['evm']>[EvmNetwork]]>) {
    const url = env[cfg!.rpcUrlEnv]; if (!url) continue; // missing provider is a capability gap, not an error for other lanes
    out[network] = new EvmFinanceAdapter(network, url, cfg!.markets, cfg!.protection ?? [], cfg!.finality);
  }
  if (manifest.xrpl) { const url = env[manifest.xrpl.rpcUrlEnv]; if (url) out.xrpl = new XrplFinanceAdapter(httpXrplRpc(url), manifest.xrpl.networkId, await loadXrplCodec(manifest.xrpl.codecVersion)); }
  return out;
}

function signerFactory(p: LoadedProfile, manifest: AdapterManifest): (plan: LocalPlan) => Promise<FinanceSigner> {
  return async plan => {
    if (plan.nativePayload.kind === 'evm') {
      insist(p.profile.signer === 'existing-evm-host', 'PERMISSION_MISSING', 'evm-signer');
      const s = await loadEvmSigner();
      insist(s.address.toLowerCase() === plan.nativePayload.from.toLowerCase(), 'PERMISSION_MISSING', 'signer-account');
      return { sign: l => s.sign(l.nativePayload as never) };
    }
    insist(p.profile.signer === 'external-xrpl-host' && manifest.xrpl?.signHostModule && isAbsolute(manifest.xrpl.signHostModule), 'PERMISSION_MISSING', 'xrpl-sign-host');
    const mod = await import(pathToFileURL(manifest.xrpl.signHostModule).href) as { default: unknown };
    const host = admitSignHost(mod.default, manifest.xrpl.networkId);
    return { sign: l => { insist(l.nativePayload.kind === 'xrpl-payment', 'WRONG_CHAIN'); return host.sign(l.nativePayload.tx); } };
  };
}

/**
 * One bounded JSON object in, one typed JSON object out. Exit 0 ok/partial, 2 blocked/unknown, 1 failure.
 * No implicit dotenv, shell execution, endpoint or key from the request.
 */
export async function financeCli(args: string[], input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, output: (line: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  try {
    const allowed = new Set(['--config', '--adapters', '--record-grant']);
    insist(args.every((a, i) => allowed.has(a) || allowed.has(args[i - 1] ?? '') && args[i - 1] !== '--record-grant'), 'INVALID_INPUT', 'cli-arguments');
    const configPath = flag('--config'); insist(configPath, 'INVALID_INPUT', 'config-required');
    const profile = await loadProfile(configPath);
    let bytes = Buffer.alloc(0);
    for await (const chunk of input) { insist(bytes.length + chunk.length <= 256 * 1024, 'INVALID_INPUT', 'input-too-large'); bytes = Buffer.concat([bytes, chunk]); }
    const request = strictParse(bytes) as { schemaVersion?: string };
    if (!profile.profile.enabled) throw new FinanceError('FEATURE_DISABLED');
    if (request.schemaVersion === 'finance.request/1') {
      const response = await new FinanceClient(profile.profile.mcpUrl, env[profile.profile.mcpAuthTokenEnv]).call(request);
      output(JSON.stringify(response) + '\n');
      return response.kind === 'error' ? (response.status === 'failed' ? 1 : 2) : 0;
    }
    const manifestPath = flag('--adapters');
    const manifest: AdapterManifest = manifestPath ? strictParse(await readFile(manifestPath)) as AdapterManifest : { schemaVersion: 'finance.adapters/1' };
    const runtime = new FinanceRuntime({ profile, adapters: await buildAdapters(manifest, env), signer: signerFactory(profile, manifest) });
    if (args.includes('--record-grant')) {
      const approvalRef = await runtime.recordGrant(request);
      output(JSON.stringify({ schemaVersion: 'finance.grant-recorded/1', contractDigest: CONTRACT_DIGEST, approvalRef }) + '\n');
      return 0;
    }
    const result = await runtime.run(request);
    output(JSON.stringify(result) + '\n');
    return result.outcome === 'ok' ? 0 : result.outcome === 'failed' ? 1 : 2;
  } catch (e) {
    output(JSON.stringify({ schemaVersion: 'finance.local-result/1', contractDigest: CONTRACT_DIGEST, requestId: 'invalid', outcome: 'blocked', planRef: null, localPlanRef: null, simulation: null, receipt: null, errors: [toErrorRecord(e)] }) + '\n');
    return e instanceof FinanceError ? 2 : 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await financeCli(process.argv.slice(2), process.stdin, line => process.stdout.write(line));
