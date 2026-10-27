import type { ExecutionOutcome, ExecutionStage } from './types.js';

const RETRYABLE = /timeout|rate limit|429|network|temporar|socket|fetch/i;

export function executionOutcome(stage: ExecutionStage, error: unknown, fallbackCode = 'EXECUTION_FAILED'): ExecutionOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const known = [
    ['stale', 'STALE_PROPOSAL'], ['owner', 'SIGNER_NOT_OWNER'], ['selector', 'UNSUPPORTED_CAPABILITY'],
    ['bytecode', 'EXECUTOR_NOT_DEPLOYED'], ['chain', 'CHAIN_MISMATCH'], ['daily loss', 'DAILY_LOSS_STOP']
  ].find(([pattern]) => message.toLowerCase().includes(pattern));
  return { stage, code: known?.[1] ?? fallbackCode, retryable: RETRYABLE.test(message), message: message.slice(0, 240) };
}

export const ROUND_ROW_COLUMNS_V1 = ['date','round_id','chain','phase','strategy','route','deployed_notional','tx','block_or_checkpoint','status','swap_legs_or_events','distinct_pools','borrow','swept','prefund','trade_pnl_usd','gas','net_usd','flags','log_claim','verdict','evidence_class','hops','branches','split_weights','artifact_path'] as const;
export interface RoundRow {
  schemaVersion:'5.1';recordType:'round-row';date:string;round_id:string;chain:string;phase:string;strategy:string;route:string;
  deployed_notional:string|null;tx:string|null;block_or_checkpoint:string;status:string;swap_legs_or_events:number;distinct_pools:number;
  borrow:string|null;swept:string|null;prefund:string|null;trade_pnl_usd:import('./evidence/contracts.js').Ratio|null;gas:string|null;net_usd:import('./evidence/contracts.js').Ratio|null;
  flags:string[];log_claim:string;verdict:string;evidence_class:import('./evidence/contracts.js').EvidenceClass;hops:number|null;branches:number|null;split_weights:number[];artifact_path:string;integrityRef:string;
}
export function projectRoundRow(report:import('./evidence/contracts.js').Report,integrity:import('./evidence/integrity.js').Integrity,records:{state:import('./evidence/contracts.js').StateBundle;plan?:import('./evidence/contracts.js').Plan;ledger?:import('./evidence/contracts.js').Ledger;policy?:import('./evidence/contracts.js').Policy;transactionId?:string;recall?:import('./evidence/integrity.js').RecallApplication},meta:{date:string;roundId:string;strategy:string;artifactPath:string}):RoundRow {
  const {plan,ledger,state,policy}=records;
  if(report.runId!==integrity.runId||state.runId!==report.runId||report.stateDigest!==state.stateDigest||plan&&plan.stateDigest!==state.stateDigest||ledger&&ledger.runId!==report.runId||records.recall&&records.recall.runId!==report.runId)throw new Error('REPORT_JOIN_MISMATCH');
  const receipt=integrity.evidenceClass==='RECEIPT',flags=[...integrity.flags,...(records.recall?.results.filter(c=>c.result==='VIOLATION').map(c=>`LESSON_${c.checkId}`)??[])];
  const pools=plan?.branches.flatMap(b=>b.poolPath)??[];
  return {schemaVersion:'5.1',recordType:'round-row',date:meta.date,round_id:meta.roundId,chain:`${state.identity.namespace}:${state.identity.networkId}`,phase:policy?.mode??'research',strategy:meta.strategy,route:plan?.branches.map(b=>b.poolPath.join(' -> ')).join(' | ')??'',deployed_notional:receipt&&ledger?ledger.deployedRaw:null,tx:receipt?records.transactionId??null:null,block_or_checkpoint:state.identity.height,status:report.outcome,swap_legs_or_events:pools.length,distinct_pools:new Set(pools).size,borrow:receipt&&ledger?ledger.principalRaw:null,swept:null,prefund:receipt&&ledger?ledger.operatorPrefundRaw:null,trade_pnl_usd:null,gas:null,net_usd:null,flags,log_claim:report.reasons.join('; '),verdict:integrity.verdict,evidence_class:integrity.evidenceClass,hops:plan?Math.max(...plan.branches.map(b=>b.hopCount)):null,branches:plan?.branches.length??null,split_weights:plan?.branches.map(b=>b.weightBps)??[],artifact_path:meta.artifactPath,integrityRef:integrityDigest(integrity)};
}
function integrityDigest(value:unknown):string {return createEvidenceDigest(value);}
import { digest as createEvidenceDigest } from './liquidity/state.js';
import { validateRecord as validateEvidenceRecord } from './evidence/contracts.js';
export function roundRowCsv(rows:RoundRow[]):string {
  const cell=(v:unknown)=>{const text=v===null?'':typeof v==='object'?JSON.stringify(v):String(v);return /[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;};
  for(const row of rows)validateEvidenceRecord('RoundRow',row);
  return [ROUND_ROW_COLUMNS_V1.join(','),...rows.map(row=>ROUND_ROW_COLUMNS_V1.map(key=>cell(row[key])).join(','))].join('\n')+'\n';
}
export function projectSheetSections(records:{row:RoundRow;pattern?:unknown;band?:unknown;attribution?:unknown;recall?:unknown}):string {
  validateEvidenceRecord('RoundRow',records.row);
  return [['0b Evidence class',{evidenceClass:records.row.evidence_class,integrityRef:records.row.integrityRef}],['6c Pattern and band',{pattern:records.pattern??null,band:records.band??null}],['6d Hop decision',records.attribution??null],['6e Approval study references',{status:'DESCRIPTIVE_ONLY',references:[]}],['9 Recall applied',records.recall??null]].map(([title,value])=>`## ${title}\n\nRecord hash: ${createEvidenceDigest(value)}\n\n\`\`\`json\n${JSON.stringify(value,null,2)}\n\`\`\``).join('\n\n')+'\n';
}
