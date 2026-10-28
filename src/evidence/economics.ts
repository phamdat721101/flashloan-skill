import { optimizeTradeSize, type SizingBounds, type SizeQuoter } from '../adaptive-sizing.js';
import { digest, uint } from '../liquidity/state.js';
import { fresh, recordHash, sameAsset, validateRecord, type Asset, type EvidenceRef, type Ledger, type NativeProof, type Plan, type Policy, type Ratio, type RunRequest, type Search, type WatchLimits } from './contracts.js';

export interface Profile extends WatchLimits {
  principalCapRaw: string; minimumPrincipalRaw: string; minimumBranchRaw: string; minProfitUsd: Ratio;
  maxPriceImpactBps: number; minDeploymentBps: number; minBranchWeightBps: number;
  maxHopsPerBranch: number; maxBranches: number; maxTotalSwaps: number; maxAttempts: number;
  deadlineMs: number; maxStateAgeNs: string; maxDailyLossRaw: string;
}
export interface ApprovedProfile { body: Profile; ref: EvidenceRef }
const positiveRatio = (r: Ratio) => { validateRecord<Ratio>('Ratio',r); if (BigInt(r.numerator) <= 0n) throw new Error('INVALID_VALUATION'); return r; };
const larger = (a: Ratio,b: Ratio): Ratio => BigInt(a.numerator)*BigInt(b.denominator) >= BigInt(b.numerator)*BigInt(a.denominator) ? a : b;
/** Exclusive raw threshold. Native solvers taking >= must use threshold + one atom. */
export function rawThreshold(usd: Ratio, price: Ratio, decimals: number): bigint {
  positiveRatio(price); validateRecord<Ratio>('Ratio',usd);
  if (BigInt(usd.numerator) < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('INVALID_THRESHOLD');
  return BigInt(usd.numerator)*BigInt(price.denominator)*10n**BigInt(decimals)/(BigInt(usd.denominator)*BigInt(price.numerator));
}
export function compilePolicy(request: RunRequest, approved: ApprovedProfile, asset: Asset, valuation: { price: Ratio; ref: EvidenceRef }, nowNs: bigint): Policy {
  validateRecord<RunRequest>('RunRequest',request,request.schemaVersion); validateRecord<Asset>('Asset',asset);
  const p=approved.body, version=request.schemaVersion;
  if (!request.borrowAsset || !sameAsset(request.borrowAsset,asset) || request.networkId !== asset.networkId || !request.riskProfileRef || request.riskProfileRef.contentHash !== digest(p) || approved.ref.contentHash !== request.riskProfileRef.contentHash || approved.ref.kind !== 'configuration' || !request.principalCapRaw || !request.networkCostEvidenceRef || !request.valuationEvidenceRef || request.valuationEvidenceRef.contentHash !== valuation.ref.contentHash) throw new Error('INPUT_BLOCKED');
  for (const ref of [approved.ref,valuation.ref,request.networkCostEvidenceRef]) fresh(ref,nowNs,uint(p.maxStateAgeNs));
  if (version === '5.2') { validateRecord('Ratio',p.minProfitUsd); if (BigInt(p.minProfitUsd.numerator)<0n) throw new Error('INVALID_THRESHOLD'); } else positiveRatio(p.minProfitUsd);
  if(request.requestedMinProfitUsd && BigInt(request.requestedMinProfitUsd.numerator)<0n) throw new Error('INVALID_THRESHOLD');
  const requestedFloor=larger(p.minProfitUsd,request.requestedMinProfitUsd ?? p.minProfitUsd);
  const floor=version==='5.2'?requestedFloor:larger({numerator:'10',denominator:'1'},requestedFloor);
  const usdMinimum=(value: Ratio | null) => {if(!value)return 0n;validateRecord('Ratio',value);if(BigInt(value.numerator)<0n)throw new Error('INVALID_THRESHOLD');const numerator=BigInt(value.numerator)*BigInt(valuation.price.denominator)*10n**BigInt(asset.decimals),denominator=BigInt(value.denominator)*BigInt(valuation.price.numerator);return (numerator+denominator-1n)/denominator;};
  const max=(a: bigint,b: bigint)=>a>b?a:b;
  const cap=uint(request.principalCapRaw)<uint(p.principalCapRaw)?uint(request.principalCapRaw):uint(p.principalCapRaw);
  const result: Policy={schemaVersion:version,recordType:'policy',runId:request.runId,profileRef:approved.ref,policyHash:'0'.repeat(64),mode:request.mode,principalCapRaw:cap.toString(),minimumPrincipalRaw:max(uint(p.minimumPrincipalRaw),usdMinimum(request.requestedMinPrincipalUsd)).toString(),minimumBranchRaw:max(uint(p.minimumBranchRaw),usdMinimum(request.requestedMinBranchUsd)).toString(),minProfitRaw:rawThreshold(floor,valuation.price,asset.decimals).toString(),profitComparison:'gt',maxPriceImpactBps:Math.min(p.maxPriceImpactBps,request.requestedPriceImpactBps??p.maxPriceImpactBps),minDeploymentBps:Math.max(p.minDeploymentBps,request.requestedMinDeploymentBps??0),minBranchWeightBps:Math.max(p.minBranchWeightBps,request.requestedMinBranchWeightBps??0),maxHopsPerBranch:p.maxHopsPerBranch,maxBranches:p.maxBranches,maxAttempts:p.maxAttempts,deadlineMs:p.deadlineMs,maxStateAgeNs:p.maxStateAgeNs,maxDailyLossRaw:p.maxDailyLossRaw,executionAuthorizationRef:null,borrowAsset:asset,maxTotalSwaps:p.maxTotalSwaps,valuationEvidenceRef:valuation.ref,networkCostEvidenceRef:request.networkCostEvidenceRef};
  if(version!=='5.0')for(const key of ['watchMode','maxTriggerToSimulationBlocks','bandTtlBlocks','bandRebuildTicks','bandMaxEvaluationsPerRow','bandMaxEvaluationsTotal','watchQueueCapacity','watchMaxSolves'] as const) if(p[key]!==undefined) Object.assign(result,{[key]:p[key]});
  if(!cap || uint(result.minimumPrincipalRaw)>cap)throw new Error('POLICY_UNSUPPORTED');
  result.policyHash=digest(Object.fromEntries(Object.entries(result).filter(([k])=>!['policyHash','runId'].includes(k))));
  return validateRecord<Policy>('Policy',result,version);
}
export interface LedgerInputs { runId: string; schemaVersion:'5.0'|'5.1'|'5.2'; asset:Asset; principalRaw:string; deployedRaw:string; unusedPrincipalRaw:string; swapProceedsRaw:string; flashFeeRaw:string; networkCostRaw:string; otherExternalCostsRaw:string; operatorPrefundRaw:string; executorOpeningBalanceRaw:string; evidence:EvidenceRef[] }
export function buildLedger(input:LedgerInputs):Ledger {
  for(const [key,value]of Object.entries(input))if(key.endsWith('Raw'))uint(value);
  const n=(x:string)=>BigInt(x),terminal=n(input.swapProceedsRaw)+n(input.unusedPrincipalRaw),surplus=terminal-n(input.principalRaw)-n(input.flashFeeRaw);
  if(n(input.principalRaw)!==n(input.deployedRaw)+n(input.unusedPrincipalRaw))throw new Error('PRINCIPAL_NOT_CONSERVED');
  return validateRecord<Ledger>('Ledger',{...input,recordType:'cashflow-ledger',terminalBeforeDebtRaw:terminal.toString(),surplusAfterDebtRaw:surplus.toString(),simulatedNetRaw:(surplus-n(input.networkCostRaw)-n(input.otherExternalCostsRaw)).toString(),realizedNetRaw:{value:null,reason:'RECEIPT_NOT_RECONCILED'}},input.schemaVersion);
}
export function verifyPlan(plan:Plan,policy:Policy):void {
  validateRecord<Plan>('Plan',plan,plan.schemaVersion);
  if(plan.planHash!==recordHash(plan,'planHash') || plan.policyHash!==policy.policyHash || plan.runId!==policy.runId || !sameAsset(plan.borrowAsset,policy.borrowAsset) || uint(plan.principalRaw)>uint(policy.principalCapRaw))throw new Error('PLAN_BINDING_MISMATCH');
  const deployed=plan.branches.reduce((s,b)=>s+uint(b.allocatedRaw),0n);
  if(deployed+uint(plan.unusedPrincipalRaw)!==uint(plan.principalRaw) || plan.branches.length>policy.maxBranches || plan.branches.reduce((s,b)=>s+b.hopCount,0)>policy.maxTotalSwaps || plan.branches.some(b=>b.hopCount>policy.maxHopsPerBranch||b.poolPath.length!==b.hopCount||b.tokenPath.length!==b.hopCount+1||uint(b.allocatedRaw)<uint(policy.minimumBranchRaw)||!sameAsset(b.tokenPath[0],plan.borrowAsset)||b.tokenPath[0].decimals!==plan.borrowAsset.decimals||!sameAsset(b.tokenPath.at(-1)!,plan.borrowAsset)||b.tokenPath.at(-1)!.decimals!==plan.borrowAsset.decimals))throw new Error('PRINCIPAL_OR_ROUTE_INVALID');
  if(deployed*10000n<uint(plan.principalRaw)*BigInt(policy.minDeploymentBps)||plan.branches.some(b=>uint(b.allocatedRaw)*10000n<uint(plan.principalRaw)*BigInt(policy.minBranchWeightBps)))throw new Error('POLICY_UNSUPPORTED');
  const external=plan.costs.filter(c=>!c.includedInSwapOutput);if(external.some(c=>c.amountRaw.value===null||!sameAsset(c.asset,plan.borrowAsset)||c.asset.decimals!==plan.borrowAsset.decimals))throw new Error('MISSING_COST_EVIDENCE');
  const expected=uint(plan.outputAfterEmbeddedFeesRaw)+uint(plan.unusedPrincipalRaw)-uint(plan.principalRaw)-uint(plan.flashFeeRaw)-external.reduce((n,c)=>n+uint(c.amountRaw.value!),0n);
  if(plan.netProfitRaw.value===null||expected!==BigInt(plan.netProfitRaw.value))throw new Error('ECONOMIC_INVARIANT_FAILED');
  if(plan.netProfitRaw.value===null||BigInt(plan.netProfitRaw.value)<=uint(policy.minProfitRaw))throw new Error('INSUFFICIENT_NET_PROFIT');
}
export function verifyNative(proof:NativeProof,plan:Plan,context:{payloadHash:string;executorCodeOrPackageHash:string;adapterRevision:string;nowNs:bigint;maxAgeNs:bigint}):void {
  validateRecord<NativeProof>('NativeProof',proof,proof.schemaVersion);
  if(proof.runId!==plan.runId || proof.candidateHash!==plan.planHash || proof.stateDigest!==plan.stateDigest || proof.policyHash!==plan.policyHash || proof.executionContextHash!==plan.executionContextHash || proof.payloadHash!==context.payloadHash || proof.executorCodeOrPackageHash!==context.executorCodeOrPackageHash || proof.adapterRevision!==context.adapterRevision || proof.fidelity!=='existing-native'||proof.overrideRefs.length||!proof.success||!proof.repaymentProven||proof.terminalBalanceBasis==='unknown'||proof.terminalBalanceRaw.value===null||proof.resultEvidence.kind!=='native-simulation'||!plan.unsignedPayloadRef||plan.unsignedPayloadRef.contentHash!==context.payloadHash||plan.costs.some(c=>c.basis==='research-assumption'||c.amountRaw.value===null))throw new Error('NATIVE_PROOF_MISMATCH');
  fresh(proof.resultEvidence,context.nowNs,context.maxAgeNs);
}
export async function searchExact(bounds:SizingBounds,quote:SizeQuoter,domain:EvidenceRef):Promise<{result:Awaited<ReturnType<typeof optimizeTradeSize>>;search:Search;status:'CANDIDATE_FOUND'|'CERTIFIED_NO_OPPORTUNITY'|'INCONCLUSIVE'}> {
  const start=performance.now(),result=await optimizeTradeSize(bounds,quote),complete=result.termination==='domain-complete';
  const search:Search={attempted:result.attempted,accepted:result.evaluated.length,rejected:result.rejected,uniqueAmounts:result.attempted,retries:0,maxAttempts:bounds.maxEvaluations,elapsedMs:Math.floor(performance.now()-start),deadlineMs:bounds.deadlineMs,domainMinimumRaw:(((bounds.minAmount+bounds.quantum-1n)/bounds.quantum)*bounds.quantum).toString(),domainMaximumRaw:(bounds.maxAmount/bounds.quantum*bounds.quantum).toString(),quantumRaw:bounds.quantum.toString(),evaluatedDomainHash:digest(result.evaluated.map(q=>({amount:q.amountIn.toString(),net:q.netProfitRaw.toString(),state:q.stateDigest}))),coverageComplete:complete,termination:complete?'domain-certified':result.termination==='time-budget'?'time-budget':result.termination==='cancelled'?'cancelled':'attempt-budget',optimality:complete?'domain-certified':'best-found',rejections:Object.entries(result.rejectedQuotes).map(([code,count])=>({code,count})),inflight:0,domainEvidenceRef:domain,certificateRef:null,gridPointCount:null};
  validateRecord<Search>('Search',search);
  return {result,search,status:result.winner?'CANDIDATE_FOUND':complete?'CERTIFIED_NO_OPPORTUNITY':'INCONCLUSIVE'};
}

/** Schema validity cannot establish accounting truth. Recompute before any publication. */
export function verifyLedger(ledger:Ledger):void {
  validateRecord<Ledger>('Ledger',ledger,ledger.schemaVersion);
  const n=(key:keyof Ledger)=>BigInt(String(ledger[key]));
  if(n('principalRaw')!==n('deployedRaw')+n('unusedPrincipalRaw')||n('terminalBeforeDebtRaw')!==n('swapProceedsRaw')+n('unusedPrincipalRaw')||n('surplusAfterDebtRaw')!==n('terminalBeforeDebtRaw')-n('principalRaw')-n('flashFeeRaw')||n('simulatedNetRaw')!==n('surplusAfterDebtRaw')-n('networkCostRaw')-n('otherExternalCostsRaw'))throw new Error('ECONOMIC_INVARIANT_FAILED');
}

/** Shared funding semantics for orchestration, direct runtime and persisted evidence replay. */
export function verifyFundingMarket(option:import('./gap-runtime.js').FundingOption,market:Pick<import('./solver.js').CapturedMarket,'identity'|'asset'|'lender'>,nowNs:bigint,maxAgeNs:bigint):void {
  validateRecord('FundingOption',option,'5.2');
  if(!sameAsset(option.asset,option.repaymentAsset)||option.asset.decimals!==option.repaymentAsset.decimals||!sameAsset(option.asset,market.asset)||option.asset.decimals!==market.asset.decimals||digest(option.identity)!==digest(market.identity)||option.identity.finality==='provisional'||option.identity.namespace!==option.asset.namespace||option.identity.networkId!==option.asset.networkId||option.capacityRaw!==market.lender.capacityRaw||option.feeNumerator!==market.lender.feeNumerator||option.feeDenominator!==market.lender.feeDenominator||!uint(option.capacityRaw)||!uint(option.feeDenominator)||digest(option.evidence)!==digest(market.lender.evidence)||option.executorCapabilityRef.kind!=='configuration')throw new Error('FUNDING_EVIDENCE_MISMATCH');
  if(option.asset.namespace==='eip155'&&!/^0x[0-9a-fA-F]{40}$/.test(option.lenderAddress))throw new Error('FUNDING_EVIDENCE_MISMATCH');
  fresh(option.evidence,nowNs,maxAgeNs);fresh(option.executorCapabilityRef,nowNs,maxAgeNs);
}
