import { readFile } from 'node:fs/promises';
import type { Address, Hex } from 'viem';
import { atomicJson } from './storage.js';

export const DEPLOYMENT_GAS_CAP = 10000000000000000n;
export const TRADING_GAS_CAP = 2000000000000000n;
export const TRADE_SUBMISSION_CAP = 3;
interface Reservation { kind: 'deployment' | 'trade'; hash: Hex; maximumWei: string; actualWei: string | null; cancelled: boolean }
interface BudgetState { chainId: number; signer: Address; reservations: Reservation[] }
/** Caller holds the canonical signer lock. No caller-selected run path can reset this ledger. */
export class EvmBudget {
  private state!: BudgetState;
  readonly path: string;
  constructor(private readonly chainId: number, private readonly signer: Address, root = '.nim/evm-budgets') {
    this.path = `${root}/${chainId}-${signer.toLowerCase()}.json`;
  }
  async load() {
    try { this.state = JSON.parse(await readFile(this.path, 'utf8')); }
    catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; this.state = { chainId:this.chainId,signer:this.signer,reservations:[] }; }
    if (this.state.chainId !== this.chainId || this.state.signer.toLowerCase() !== this.signer.toLowerCase() || !Array.isArray(this.state.reservations) || new Set(this.state.reservations.map(r=>r.hash)).size!==this.state.reservations.length) throw new Error('BUDGET_LEDGER_CORRUPT');
    for(const r of this.state.reservations) if (!['deployment','trade'].includes(r.kind) || !/^0x[0-9a-f]{64}$/.test(r.hash) || !/^[0-9]+$/.test(r.maximumWei) || (r.actualWei!==null && !/^[0-9]+$/.test(r.actualWei)) || typeof r.cancelled!=='boolean') throw new Error('BUDGET_LEDGER_CORRUPT');
  }
  private used(kind: Reservation['kind']) { return this.state.reservations.filter(r=>r.kind===kind && !r.cancelled).reduce((s,r)=>s+BigInt(r.actualWei??r.maximumWei),0n); }
  remaining(kind: Reservation['kind']) { return (kind==='deployment'?DEPLOYMENT_GAS_CAP:TRADING_GAS_CAP)-this.used(kind); }
  spent(kind: Reservation['kind']) { return this.state.reservations.filter(r=>r.kind===kind&&!r.cancelled).reduce((s,r)=>s+BigInt(r.actualWei??'0'),0n); }
  tradeCount() { return this.state.reservations.filter(r=>r.kind==='trade'&&!r.cancelled).length; }
  has(hash: Hex) { return this.state.reservations.some(r=>r.hash===hash); }
  unresolved() { return this.state.reservations.filter(r=>!r.cancelled && r.actualWei===null); }
  async reserve(kind: Reservation['kind'], hash: Hex, maximumWei: bigint) {
    const prior=this.state.reservations.find(r=>r.hash===hash);
    if(prior) {if(prior.kind!==kind || prior.maximumWei!==maximumWei.toString() || prior.cancelled)throw new Error('RESERVATION_CHANGED');return;}
    if(this.unresolved().length)throw new Error('UNRESOLVED_BUDGET_RESERVATION');
    if(maximumWei<=0n || maximumWei>this.remaining(kind) || (kind==='trade'&&this.tradeCount()>=TRADE_SUBMISSION_CAP))throw new Error('CHAIN_BUDGET_EXHAUSTED');
    this.state.reservations.push({kind,hash,maximumWei:maximumWei.toString(),actualWei:null,cancelled:false});await atomicJson(this.path,this.state);
  }
  async settle(hash: Hex, actualWei: bigint) {
    const r=this.state.reservations.find(r=>r.hash===hash);
    if(!r || r.cancelled || actualWei<0n || (r.actualWei!==null&&r.actualWei!==actualWei.toString()))throw new Error('INVALID_BUDGET_SETTLEMENT');
    r.actualWei=actualWei.toString();await atomicJson(this.path,this.state);
    if(actualWei>BigInt(r.maximumWei)||this.remaining(r.kind)<0n)throw new Error('ACTUAL_GAS_EXCEEDED_BUDGET');
  }
  /** Only for a local control path that proves submission was never invoked. */
  async cancelUnsent(hash: Hex) {
    const r=this.state.reservations.find(r=>r.hash===hash);
    if(!r || r.actualWei!==null)throw new Error('INVALID_BUDGET_CANCELLATION');
    r.cancelled=true;await atomicJson(this.path,this.state);
  }
}
