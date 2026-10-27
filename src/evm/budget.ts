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

export interface ReadinessChainContext {
  identity: import('../evidence/contracts.js').Identity;
  nativeBalance(address:string):Promise<string>;
  executorBalances(address:string):Promise<Array<{asset:import('../evidence/contracts.js').Asset;balanceRaw:string}>>;
  canonical():Promise<boolean>;
}
/** Read-only preflight. Failure to establish a balance or budget permits research, never admission. */
export async function assessReadiness(mode:'research'|'unsigned-simulation'|'authorized-execution',chain:ReadinessChainContext,operator:string|null,executor:string|null,manifest:{admitted:boolean},journal:import('../liquidity/journal.js').AttemptJournal,budget:EvmBudget|undefined,runId:string){
  const {validateRecord}=await import('../evidence/contracts.js');
  const reasons:string[]=[];let balance:string|null=null,gasBudget:string|null=null;
  let stray:Array<{asset:import('../evidence/contracts.js').Asset;balanceRaw:string}>=[],halt=true;
  try{const attempts=await journal.latest();halt=attempts.some(a=>!['reconciled','cancelled'].includes(a.state));}catch{reasons.push('ATTEMPT_JOURNAL_UNAVAILABLE');}
  if(operator)try{balance=await chain.nativeBalance(operator);}catch{reasons.push('GAS_BALANCE_UNAVAILABLE');}
  if(executor)try{stray=await chain.executorBalances(executor);}catch{reasons.push('EXECUTOR_BALANCES_UNAVAILABLE');}
  if(budget)try{await budget.load();const remaining=budget.remaining('trade');gasBudget=remaining>=0n?remaining.toString():null;if(budget.unresolved().length)halt=true;}catch{reasons.push('BUDGET_UNAVAILABLE');}
  let canonical=false;try{canonical=await chain.canonical();}catch{reasons.push('CANONICALITY_UNAVAILABLE');}
  if(!operator)reasons.push('OPERATOR_CONTEXT_UNAVAILABLE');if(!executor)reasons.push('EXECUTOR_CONTEXT_UNAVAILABLE');
  if(mode!=='authorized-execution')reasons.push('RESEARCH_MODE');
  if(!manifest.admitted)reasons.push('ADAPTER_NOT_ADMITTED');
  if(balance===null||!/^(0|[1-9][0-9]*)$/.test(balance)||BigInt(balance)===0n)reasons.push('GAS_UNAVAILABLE');
  if(gasBudget===null||BigInt(gasBudget)===0n)reasons.push('GAS_BUDGET_UNAVAILABLE');
  if(halt)reasons.push('PNL_UNKNOWN_HALT');if(!canonical)reasons.push('STATE_NOT_CANONICAL');
  return validateRecord('Readiness',{schemaVersion:'5.1',recordType:'readiness',runId,mode,state:chain.identity,operatorGasBalanceRaw:balance,gasBudgetRaw:gasBudget,executorStrayBalances:stray,adapterAdmitted:manifest.admitted,pnlUnknownHalt:halt,verdict:canonical?(reasons.length?'RESEARCH_ONLY':'READY'):'BLOCKED',reasons});
}
