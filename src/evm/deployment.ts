import { atomicJson } from './storage.js';
import { AERO_EXECUTOR_ABI, AERO_V2_EXECUTOR_ABI } from '../aero/execution.js';
export { atomicJson } from './storage.js';
import { EvmBudget } from './budget.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createPublicClient, http, keccak256, encodeFunctionData, parseAbi, type Address, type Hex, type LocalAccount, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { evmProfile } from '../evm-chains.js';
import { estimateEvmFees, receiptNativeCost } from '../evm-fees.js';
import { ExecutionLock } from '../execution-lock.js';

export const CONTRACTS = ['MultiVenueArbitrageExecutor', 'PortableMultiSplitFlashExecutor', 'V4StateQuoter', 'ImmutableArbitrageExecutor', 'AeroSplitFlashExecutor', 'AeroSplitFlashExecutorV2'] as const;
export type ContractName = typeof CONTRACTS[number];
/** AeroSplitFlashExecutorV2 roots: aero-factory generation 5/6/7 = Uniswap V2/V3/V4 manager; v4-manager = V4 lender;
 * v2-fee = a V2 factory's fixed fee (feePips); v4-pool = a trusted hookless PoolKey id on that manager. */
export interface RootPin { role: 'morpho' | 'balancer-v2' | 'aave-provider' | 'v2-factory' | 'v3-factory' | 'algebra-factory' | 'v4-manager' | 'aero-factory' | 'aero-pool' | 'v2-fee' | 'v4-pool'; address: Address; codeHash: Hex; source: string; generation?: number; implementation?: Address; implementationCodeHash?: Hex; maxFee?: string; feePips?: number; poolId?: Hex }
export interface DeploymentManifest { schemaVersion: '1.0'; chainId: number; roots: RootPin[]; contracts: ContractName[]; exclusions: Array<{ contract: string; reason: string }> }
export interface ForgeArtifact { abi: readonly unknown[]; bytecode: { object: Hex }; deployedBytecode: { object: Hex; immutableReferences?: Record<string, Array<{ start: number; length: number }>> }; metadata?: string }
export interface DeploymentEntry { contract: ContractName; address: Address; txHash: Hex; blockNumber: string; runtimeCodeHash: Hex; artifactHash: string; owner: Address | null; status: 'deployed' | 'configured' | 'verified'; configurations: Array<{ role: string; txHash: Hex }> }
interface SendRecord { label: string; hash: Hex; nonce: number; reservedWei: string; costWei?: string; status: 'signed' | 'submitted' | 'confirmed' | 'reverted' | 'cancelled'; submissionStarted: boolean; contractAddress?: Address; blockNumber?: string }
export interface DeploymentState { schemaVersion: '1.0'; chainId: number; owner: Address; manifestHash: string; spentWei: string; budgetWei: string; transactions: SendRecord[]; deployments: DeploymentEntry[] }
const rootAbi = parseAbi([
  'function owner() view returns(address)', 'function configureLender(uint8,address,bytes32,bool)',
  'function configureRoot(uint8,address,bytes32,bool,bool)', 'function configureAaveProvider(address,bytes32,bool)',
  'function configurePoolManager(address,bytes32,bool,bool)',
  'function trustedLenderCodeHash(uint8,address) view returns(bytes32)',
  'function trustedAaveProviderCodeHash(address) view returns(bytes32)',
  'function trustedV2FactoryCodeHash(address) view returns(bytes32)', 'function trustedV3FactoryCodeHash(address) view returns(bytes32)', 'function trustedAlgebraFactoryCodeHash(address) view returns(bytes32)',
  'function trustedV4ManagerCodeHash(address) view returns(bytes32)', 'function trustedPoolManagerCodeHash(address) view returns(bytes32)'
]);
export function secureEndpoint(input: string): string {
  const u = new URL(input);
  if (u.username || u.password || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))) throw new Error('INSECURE_EVM_ENDPOINT');
  return input;
}
const FACTORY_ROLES=['v2-factory','v3-factory','algebra-factory'];
/** Unique per configuration: Aero pools/factories/fees by address, V4 pools by PoolKey id.
 * Factory roles are keyed by address only when a manifest pins several of one role, so existing single-root ledgers keep their labels. */
export function rootKey(r: RootPin, roots: readonly RootPin[] = []): string {
  if(FACTORY_ROLES.includes(r.role)&&roots.filter(o=>o.role===r.role).length>1)return `${r.role}:${r.address.toLowerCase()}`;
  return r.role==='v4-pool'?`${r.role}:${r.poolId}`:r.role==='aero-pool'||r.role==='v2-fee'?`${r.role}:${r.address.toLowerCase()}`:r.role==='aero-factory'?`${r.role}:${r.generation}:${r.address.toLowerCase()}`:r.role;
}
export function parseManifest(input: unknown): DeploymentManifest {
  const m = input as DeploymentManifest;
  if (!m || Object.keys(m).sort().join(',') !== 'chainId,contracts,exclusions,roots,schemaVersion' || m.schemaVersion !== '1.0' || !Number.isInteger(m.chainId) || ![42161, 8453, 4663].includes(m.chainId) || !Array.isArray(m.roots) || !Array.isArray(m.contracts) || !m.contracts.length || new Set(m.contracts).size !== m.contracts.length || m.contracts.some(c => !CONTRACTS.includes(c)) || !Array.isArray(m.exclusions)) throw new Error('INVALID_DEPLOYMENT_MANIFEST');
  const aero2=m.contracts.includes('AeroSplitFlashExecutorV2'),aero=aero2||m.contracts.includes('AeroSplitFlashExecutor');
  if(aero&&(m.chainId!==8453||m.contracts.length!==1))throw new Error('AERO_MANIFEST_ISOLATION_REQUIRED');
  for (const r of m.roots) {
    if(!r||typeof r!=='object')throw new Error('INVALID_ROOT_PIN');
    const extra=r.role==='aero-factory'?['generation']:r.role==='aero-pool'?['implementation','implementationCodeHash']:aero&&r.role==='balancer-v2'?['maxFee']:r.role==='v2-fee'?['feePips']:r.role==='v4-pool'?['poolId']:[];
    if(!r||Object.keys(r).sort().join(',')!==['address','codeHash','role','source',...extra].sort().join(',')||!['morpho','balancer-v2','aave-provider','v2-factory','v3-factory','algebra-factory','v4-manager','aero-factory','aero-pool','v2-fee','v4-pool'].includes(r.role)||!/^0x[0-9a-fA-F]{40}$/.test(r.address)||!/^0x[0-9a-f]{64}$/.test(r.codeHash)||!/^https:\/\//.test(r.source))throw new Error('INVALID_ROOT_PIN');
    if(((r.role.startsWith('aero-')||r.role==='v2-fee'||r.role==='v4-pool')&&!aero)||(aero&&!['morpho','balancer-v2','aero-factory','aero-pool',...(aero2?['v4-manager','v2-fee','v4-pool']:[])].includes(r.role)))throw new Error('INVALID_ROOT_PIN');
    if(r.role==='aero-factory'&&(!Number.isInteger(r.generation)||r.generation!<1||r.generation!>(aero2?7:6)))throw new Error('INVALID_ROOT_PIN');
    if(r.role==='v2-fee'&&(!Number.isInteger(r.feePips)||r.feePips!<0||r.feePips!>=1000000))throw new Error('INVALID_ROOT_PIN');
    if(r.role==='v4-pool'&&!/^0x[0-9a-f]{64}$/.test(r.poolId??''))throw new Error('INVALID_ROOT_PIN');
    if(r.role==='aero-pool'&&(!/^0x[0-9a-fA-F]{40}$/.test(r.implementation??'')||!/^0x[0-9a-f]{64}$/.test(r.implementationCodeHash??'')))throw new Error('INVALID_ROOT_PIN');
    if(aero&&r.role==='balancer-v2'&&!/^(0|[1-9][0-9]*)$/.test(r.maxFee??''))throw new Error('INVALID_ROOT_PIN');
  }
  const rootKeys=m.roots.map(r=>rootKey(r,m.roots));
  if(new Set(rootKeys).size!==rootKeys.length)throw new Error('DUPLICATE_ROOT_ROLE');
  for (const e of m.exclusions) if (!e || Object.keys(e).sort().join(',') !== 'contract,reason' || typeof e.contract !== 'string' || typeof e.reason !== 'string' || !e.reason) throw new Error('INVALID_EXCLUSION');
  if (m.contracts.includes('ImmutableArbitrageExecutor') && !m.roots.some(r => r.role === 'aave-provider')) throw new Error('AAVE_REQUIRED_FOR_V4_EXECUTOR');
  return structuredClone(m);
}
export async function loadSigner(path: string): Promise<LocalAccount> {
  // Parse only the named binding; do not execute dotenv content or print its values.
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  const values = lines.map(l => /^\s*(?:export\s+)?OPERATOR_PRIVATE_KEY\s*=\s*(.*?)\s*$/.exec(l)?.[1]).filter(v => v !== undefined);
  if (values.length !== 1) throw new Error('SIGNER_BINDING_MISSING_OR_DUPLICATE');
  const key = values[0]!.replace(/^(["'])(.*)\1$/, '$2');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('INVALID_SIGNER_BINDING');
  return privateKeyToAccount(key as Hex);
}
export function verifyRuntime(artifact: ForgeArtifact, actual: Hex, owner: Address): void {
  let expected = artifact.deployedBytecode.object.replace(/^0x/, '').toLowerCase(), normalized = actual.slice(2).toLowerCase();
  for (const ref of Object.values(artifact.deployedBytecode.immutableReferences ?? {}).flat()) {
    const begin = ref.start * 2, size = ref.length * 2;
    if (size !== 64 || normalized.slice(begin, begin + size) !== owner.slice(2).toLowerCase().padStart(64, '0')) throw new Error('RUNTIME_OWNER_IMMUTABLE_MISMATCH');
    expected = expected.slice(0, begin) + '0'.repeat(size) + expected.slice(begin + size);
    normalized = normalized.slice(0, begin) + '0'.repeat(size) + normalized.slice(begin + size);
  }
  if (!expected || expected !== normalized) throw new Error('DEPLOYED_ARTIFACT_MISMATCH');
}
/** Fixed release lanes preserve prior deployment receipts; signer locks and budgets remain shared. */
export function deploymentLedgerPath(manifest:DeploymentManifest,owner:Address):string {
  const suffix=manifest.contracts.includes('AeroSplitFlashExecutorV2')?'-aero-v2':manifest.contracts.includes('AeroSplitFlashExecutor')?'-aero':manifest.contracts.length===1&&manifest.contracts[0]==='PortableMultiSplitFlashExecutor'?'-portable-split':'';
  return `.nim/deployment-ledger/${manifest.chainId}-${owner.toLowerCase()}${suffix}.json`;
}
export class EvmDeployment {
  readonly client: PublicClient;
  private readonly submission;
  private state!: DeploymentState;
  private budget!: EvmBudget;
  private readonly authorityPath: string;
  constructor(readonly manifest: DeploymentManifest, rpc: string, submission: string, private readonly account: LocalAccount, private readonly statePath: string, private readonly artifactRoot = 'out') {
    evmProfile(manifest.chainId);
    this.authorityPath = deploymentLedgerPath(manifest,account.address);
    this.client = createPublicClient({ transport: http(secureEndpoint(rpc), { timeout: 20000, retryCount: 0 }) });
    this.submission = createPublicClient({ transport: http(secureEndpoint(submission), { timeout: 20000, retryCount: 0 }) });
  }
  private async save() { await atomicJson(this.authorityPath, this.state); if (this.statePath !== this.authorityPath) await atomicJson(this.statePath, this.state); }
  private async roots() {
    if (await this.client.getChainId() !== this.manifest.chainId || await this.submission.getChainId() !== this.manifest.chainId) throw new Error('CHAIN_MISMATCH');
    const block = await this.client.getBlock({ blockTag: 'latest' });
    for (const root of this.manifest.roots) {
      const code = await this.client.getCode({ address: root.address, blockNumber: block.number });
      if (!code || code === '0x' || keccak256(code) !== root.codeHash) throw new Error(`ROOT_CODE_CHANGED:${root.role}`);
      if(root.role==='aero-pool') {
        const implementation=await this.client.getCode({address:root.implementation!,blockNumber:block.number});
        if(!implementation||keccak256(implementation)!==root.implementationCodeHash)throw new Error('AERO_IMPLEMENTATION_CHANGED');
      }
    }
    if ((await this.client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('BLOCK_REORG');
  }
  private async reconcile(record: SendRecord) {
    let receipt = await this.client.waitForTransactionReceipt({ hash: record.hash, confirmations: 2, timeout: 60000 });
    // Base Flashblocks may expose a preconfirmation receipt with no canonical hash.
    // Wait for the actual receipt; never treat the zero hash as reorg evidence.
    const until=Date.now()+60000;
    while(/^0x0{64}$/.test(receipt.blockHash)) {
      if(Date.now()>=until)throw new Error('DEPLOYMENT_PRECONFIRMATION_PENDING');
      await new Promise(r=>setTimeout(r,1000));
      receipt=await this.client.getTransactionReceipt({hash:record.hash});
    }
    if(await this.client.getBlockNumber({cacheTime:0})<receipt.blockNumber+1n)throw new Error('DEPLOYMENT_CONFIRMATIONS_PENDING');
    const canonical = await this.client.getBlock({ blockNumber: receipt.blockNumber });
    if (canonical.hash !== receipt.blockHash) {
      await atomicJson(`.nim/deployment-receipt-mismatch/${this.manifest.chainId}-${record.hash}.json`, {
        transactionHash: record.hash, receiptBlock: receipt.blockNumber.toString(), receiptBlockHash: receipt.blockHash,
        canonicalBlock: canonical.number.toString(), canonicalBlockHash: canonical.hash
      });
      throw new Error('RECEIPT_REORG');
    }
    const raw = await this.client.request({ method: 'eth_getTransactionReceipt', params: [record.hash] });
    const cost = receiptNativeCost(this.manifest.chainId, receipt, raw);
    await this.budget.settle(record.hash, cost);
    record.costWei = cost.toString(); record.status = receipt.status === 'success' ? 'confirmed' : 'reverted';
    record.contractAddress = receipt.contractAddress ?? undefined; record.blockNumber = receipt.blockNumber.toString();
    this.state.spentWei = this.state.transactions.reduce((sum, tx) => sum + BigInt(tx.costWei ?? '0'), 0n).toString();
    await this.save();
    if (receipt.status !== 'success') throw new Error('DEPLOYMENT_TRANSACTION_REVERTED');
    if (BigInt(this.state.spentWei) > BigInt(this.state.budgetWei)) throw new Error('DEPLOYMENT_BUDGET_EXCEEDED');
    return record;
  }
  private async send(label: string, data: Hex, to?: Address): Promise<SendRecord> {
    const prior = this.state.transactions.find(t => t.label === label && t.status !== 'cancelled');
    if (prior) {
      if (prior.status === 'reverted') throw new Error('PREVIOUS_TRANSACTION_REVERTED');
      if(prior.status==='signed' && !prior.submissionStarted) {
        if(this.budget.has(prior.hash))await this.budget.cancelUnsent(prior.hash);
        prior.status='cancelled';await this.save();
      } else {
        if(!this.budget.has(prior.hash))await this.budget.reserve('deployment',prior.hash,BigInt(prior.reservedWei));
        return this.reconcile(prior);
      }
    }
    await this.roots();
    const estimate = await estimateEvmFees(this.client, this.manifest.chainId, this.account.address, to, data);
    const remaining = this.budget.remaining('deployment');
    if (this.budget.unresolved().length) throw new Error('UNRESOLVED_BUDGET_RESERVATION');
    if (estimate.nativeCost > remaining || await this.client.getBalance({ address: this.account.address }) < estimate.nativeCost) throw new Error('DEPLOYMENT_BUDGET_OR_BALANCE_INSUFFICIENT');
    const nonce = await this.client.getTransactionCount({ address: this.account.address, blockTag: 'pending' });
    const bytes = await this.account.signTransaction!({ chainId: this.manifest.chainId, type: 'eip1559', nonce, to, data, value: 0n, gas: estimate.gas, maxFeePerGas: estimate.fees.maxFeePerGas, maxPriorityFeePerGas: estimate.fees.maxPriorityFeePerGas });
    const record: SendRecord = { label, hash: keccak256(bytes), nonce, reservedWei: estimate.nativeCost.toString(), status: 'signed', submissionStarted: false };
    this.state.transactions.push(record); await this.save();
    await this.budget.reserve('deployment', record.hash, estimate.nativeCost);
    record.submissionStarted=true;await this.save();
    // A timeout here is acceptance-unknown. Persisted hash is reconciled on restart; never blind-retry a send.
    const returned = await this.submission.sendRawTransaction({ serializedTransaction: bytes });
    if (returned !== record.hash) throw new Error('SUBMISSION_HASH_MISMATCH');
    record.status = 'submitted'; await this.save();
    return this.reconcile(record);
  }
  private rootConfiguration(contract: ContractName, root: RootPin): Hex | null {
    if(contract==='AeroSplitFlashExecutorV2') {
      const abi=AERO_V2_EXECUTOR_ABI;
      if(root.role==='morpho'||root.role==='balancer-v2'||root.role==='v4-manager')return encodeFunctionData({abi,functionName:'configureLender',args:[root.role==='morpho'?1:root.role==='balancer-v2'?2:3,root.address,root.codeHash,BigInt(root.maxFee??'0')]});
      if(root.role==='aero-factory')return encodeFunctionData({abi,functionName:'configureFactory',args:[root.generation!,root.address,root.codeHash]});
      if(root.role==='aero-pool')return encodeFunctionData({abi,functionName:'configurePool',args:[root.address,root.codeHash,root.implementation!,root.implementationCodeHash!]});
      if(root.role==='v2-fee')return encodeFunctionData({abi,functionName:'configureV2Fee',args:[root.address,root.feePips!,true]});
      if(root.role==='v4-pool')return encodeFunctionData({abi,functionName:'configureV4Pool',args:[root.poolId!,true]});
      throw new Error('INVALID_ROOT_PIN');
    }
    if(contract==='AeroSplitFlashExecutor') {
      if(root.role==='morpho'||root.role==='balancer-v2')return encodeFunctionData({abi:AERO_EXECUTOR_ABI,functionName:'configureLender',args:[root.role==='morpho'?1:2,root.address,root.codeHash,BigInt(root.maxFee??'0')]});
      if(root.role==='aero-factory')return encodeFunctionData({abi:AERO_EXECUTOR_ABI,functionName:'configureFactory',args:[root.generation!,root.address,root.codeHash]});
      if(root.role==='aero-pool')return encodeFunctionData({abi:AERO_EXECUTOR_ABI,functionName:'configurePool',args:[root.address,root.codeHash,root.implementation!,root.implementationCodeHash!]});
      throw new Error('INVALID_ROOT_PIN');
    }
    if (contract === 'V4StateQuoter') return null;
    if (root.role === 'aave-provider') return encodeFunctionData({ abi: rootAbi, functionName: 'configureAaveProvider', args: [root.address, root.codeHash, true] });
    if (root.role === 'algebra-factory' && !['MultiVenueArbitrageExecutor','PortableMultiSplitFlashExecutor'].includes(contract)) return null;
    if (contract === 'ImmutableArbitrageExecutor') return root.role === 'v4-manager' ? encodeFunctionData({ abi: rootAbi, functionName: 'configurePoolManager', args: [root.address, root.codeHash, true, false] }) : null;
    if (root.role === 'morpho' || root.role === 'balancer-v2') return encodeFunctionData({ abi: rootAbi, functionName: 'configureLender', args: [root.role === 'morpho' ? 1 : 2, root.address, root.codeHash, true] });
    return encodeFunctionData({ abi: rootAbi, functionName: 'configureRoot', args: [root.role === 'v2-factory' ? 2 : root.role === 'v3-factory' ? 3 : root.role === 'algebra-factory' ? 5 : 4, root.address, root.codeHash, true, false] });
  }
  private async verifyRoot(entry: DeploymentEntry, root: RootPin) {
    if (!this.rootConfiguration(entry.contract, root)) return;
    if(entry.contract==='AeroSplitFlashExecutorV2') {
      const read=(functionName:string,args:readonly unknown[])=>this.client.readContract({address:entry.address,abi:AERO_V2_EXECUTOR_ABI,functionName,args} as never) as Promise<unknown>;
      let ok:boolean;
      if(root.role==='aero-pool'){const pin=await read('trustedPool',[root.address]) as readonly [Hex,Address,Hex];ok=pin[0]===root.codeHash&&pin[1].toLowerCase()===root.implementation!.toLowerCase()&&pin[2]===root.implementationCodeHash;}
      else if(root.role==='aero-factory')ok=await read('trustedFactory',[root.generation!,root.address])===root.codeHash;
      else if(root.role==='v2-fee'){const fee=await read('v2Fee',[root.address]) as readonly [boolean,number];ok=fee[0]&&fee[1]===root.feePips;}
      else if(root.role==='v4-pool')ok=await read('trustedV4Pool',[root.poolId!])===true;
      else {const kind=root.role==='morpho'?1:root.role==='balancer-v2'?2:3;ok=await read('trustedLender',[kind,root.address])===root.codeHash&&await read('maxLenderFee',[root.address])===BigInt(root.maxFee??'0');}
      if(!ok)throw new Error('ROOT_CONFIGURATION_READBACK_MISMATCH');
      return;
    }
    if(entry.contract==='AeroSplitFlashExecutor') {
      if(root.role==='aero-pool') {
        const pin=await this.client.readContract({address:entry.address,abi:AERO_EXECUTOR_ABI,functionName:'trustedPool',args:[root.address]});
        if(pin[0]!==root.codeHash||pin[1].toLowerCase()!==root.implementation!.toLowerCase()||pin[2]!==root.implementationCodeHash)throw new Error('ROOT_CONFIGURATION_READBACK_MISMATCH');
      } else if(root.role==='aero-factory') {
        if(await this.client.readContract({address:entry.address,abi:AERO_EXECUTOR_ABI,functionName:'trustedFactory',args:[root.generation!,root.address]})!==root.codeHash)throw new Error('ROOT_CONFIGURATION_READBACK_MISMATCH');
      } else {
        if(await this.client.readContract({address:entry.address,abi:AERO_EXECUTOR_ABI,functionName:'trustedLender',args:[root.role==='morpho'?1:2,root.address]})!==root.codeHash||await this.client.readContract({address:entry.address,abi:AERO_EXECUTOR_ABI,functionName:'maxLenderFee',args:[root.address]})!==BigInt(root.maxFee??'0'))throw new Error('ROOT_CONFIGURATION_READBACK_MISMATCH');
      }
      return;
    }
    const hash = root.role === 'morpho' || root.role === 'balancer-v2'
      ? await this.client.readContract({ address: entry.address, abi: rootAbi, functionName: 'trustedLenderCodeHash', args: [root.role === 'morpho' ? 1 : 2, root.address] })
      : await this.client.readContract({ address: entry.address, abi: rootAbi, functionName: root.role === 'aave-provider' ? 'trustedAaveProviderCodeHash' : root.role === 'v2-factory' ? 'trustedV2FactoryCodeHash' : root.role === 'v3-factory' ? 'trustedV3FactoryCodeHash' : root.role === 'algebra-factory' ? 'trustedAlgebraFactoryCodeHash' : entry.contract === 'ImmutableArbitrageExecutor' ? 'trustedPoolManagerCodeHash' : 'trustedV4ManagerCodeHash', args: [root.address] });
    if (hash !== root.codeHash) throw new Error('ROOT_CONFIGURATION_READBACK_MISMATCH');
  }
  async run(): Promise<DeploymentState> {
    return new ExecutionLock(`.nim/signing/${this.manifest.chainId}-${this.account.address.toLowerCase()}.lock`).runExclusive(async () => {
      this.budget = new EvmBudget(this.manifest.chainId, this.account.address); await this.budget.load();
      const manifestHash = createHash('sha256').update(JSON.stringify(this.manifest)).digest('hex');
      try { this.state = JSON.parse(await readFile(this.authorityPath, 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; this.state = { schemaVersion: '1.0', chainId: this.manifest.chainId, owner: this.account.address, manifestHash, spentWei: '0', budgetWei: '10000000000000000', transactions: [], deployments: [] }; }
      if (this.state.chainId !== this.manifest.chainId || this.state.owner !== this.account.address || this.state.manifestHash !== manifestHash || this.state.budgetWei !== '10000000000000000') throw new Error('DEPLOYMENT_STATE_BINDING_MISMATCH');
      await this.roots();
      for (const contract of this.manifest.contracts) {
        const artifactBytes = await readFile(resolve(this.artifactRoot, `${contract}.sol`, `${contract}.json`));
        const artifact: ForgeArtifact = JSON.parse(artifactBytes.toString());
        const artifactHash = createHash('sha256').update(artifactBytes).digest('hex');
        let entry = this.state.deployments.find(e => e.contract === contract);
        if (entry && entry.artifactHash !== artifactHash) throw new Error('DEPLOYMENT_ARTIFACT_CHANGED');
        if (!entry) {
          const tx = await this.send(`deploy:${contract}`, artifact.bytecode.object);
          if (!tx.contractAddress || !tx.blockNumber) throw new Error('DEPLOYMENT_ADDRESS_MISSING');
          entry = { contract, address: tx.contractAddress, txHash: tx.hash, blockNumber: tx.blockNumber, runtimeCodeHash: '0x', artifactHash, owner: contract === 'V4StateQuoter' ? null : this.account.address, status: 'deployed', configurations: [] };
          this.state.deployments.push(entry); await this.save();
        }
        const code = await this.client.getCode({ address: entry.address });
        if (!code) throw new Error('DEPLOYED_CODE_MISSING');
        verifyRuntime(artifact, code, this.account.address); entry.runtimeCodeHash = keccak256(code);
        if (entry.owner && (await this.client.readContract({ address: entry.address, abi: rootAbi, functionName: 'owner' })).toLowerCase() !== entry.owner.toLowerCase()) throw new Error('DEPLOYED_OWNER_MISMATCH');
        for (const root of this.manifest.roots) {
          const data = this.rootConfiguration(contract, root); if (!data) continue;
          // V1 labels are unchanged so existing ledgers keep reconciling.
          const key=contract==='AeroSplitFlashExecutorV2'?rootKey(root):root.role.startsWith('aero-')?`${root.role}:${root.generation??''}:${root.address.toLowerCase()}`:rootKey(root,this.manifest.roots);
          const tx = await this.send(`configure:${contract}:${key}`, data, entry.address);
          if (!entry.configurations.some(c => c.role === key)) entry.configurations.push({ role: key, txHash: tx.hash });
          await this.verifyRoot(entry, root); await this.save();
        }
        entry.status = 'verified'; await this.save();
      }
      await this.roots(); return structuredClone(this.state);
    });
  }
}
