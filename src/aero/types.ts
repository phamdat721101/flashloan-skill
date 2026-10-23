import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';
import type { TickState } from '../state-adapters.js';
import { digest, uint } from '../liquidity/state.js';
import { ceilDiv } from '../liquidity/v2.js';

export interface ClassicState { protocol: 'aero-volatile' | 'aero-stable'; reserve0: string; reserve1: string; balance0: string; balance1: string; feeBps: number; stable: boolean }
export interface ExternalV2State { protocol: 'uniswap-v2'; reserve0: string; reserve1: string; feeNumerator: string; feeDenominator: string }
export interface ConcentratedState {
  protocol: 'aero-slipstream' | 'uniswap-v3'; sqrtPriceX96: string; tick: number; liquidity: string; tickSpacing: number; feePips: number;
  unlocked: true; lowerTick: number; upperTick: number; bitmapWords: Array<{wordPosition: number; bitmap: string}>; initializedTicks: TickState[];
  feeProfile: 'fixed-proven' | 'dynamic-evm' | 'unknown'; feeEvidenceDigest: string;
}
export type AeroState = ClassicState | ExternalV2State | ConcentratedState;
export type Generation = 'classic' | 'cl-initial' | 'cl-gauge-caps' | 'cl-gauges-v3' | 'external-v2' | 'external-v3';
export interface AeroPool { poolId: string; address: Address; factory: Address; generation: Generation; token0: Address; token1: Address; decimals0: number; decimals1: number; implementation: Address; implementationCodeHash: Hex; state: AeroState }
export interface AeroLeg { poolId: string; tokenIn: Address; minOutBps: number; sqrtPriceLimitX96: string }
export interface AeroBranch { branchId: string; legs: AeroLeg[] }
export interface AeroLender { lenderId: string; kind: 'morpho' | 'balancer-v2'; address: Address; codeHash: Hex; asset: Address; available: string; feeNumerator: string; feeDenominator: string; feeRounding: 'floor' | 'ceil' | 'zero'; termsEvidenceDigest: string }
export interface AeroRequest {
  schemaVersion: 'aero-split/1.0'; identity: {chainId: 8453; blockNumber: string; blockHash: Hex; timestamp: string}; sender: Address; borrowAsset: Address;
  pools: AeroPool[]; pins: Array<{address: Address; codeHash: Hex; role: 'factory' | 'pool' | 'implementation' | 'fee-module' | 'quoter' | 'lender' | 'executor' | 'price-feed'; sourceRevision: string}>;
  branches: AeroBranch[]; lenders: AeroLender[]; bounds: {minimum: string; maximum: string; quantum: string; minNetProfit: string; deadline: string};
  cost: {evidenceDigest: string; nativeAsset: Address; borrowAsset: Address; nativeCostWei: string; costInBorrowAsset: string; conversionNumerator: string; conversionDenominator: string; valuationEvidenceDigest: string; maxAgeSeconds: number};
  limits: {maxEvaluations: number; borrowSamples: number; allocationChunks: number; maxQuoteSteps: number};
}
export interface AeroQuote { poolId: string; tokenIn: Address; tokenOut: Address; amountIn: string; consumedInput: string; amountOut: string; feeAmount: string; minAmountOut: string; sqrtPriceLimitX96: string; stateBeforeDigest: string; stateAfterDigest: string }
export interface AeroAllocation {branchId: string; amountIn: string; ratioBps: number; amountOut: string; legs: AeroQuote[]}
export interface AeroSelected {
  schemaVersion: 'aero-split/1.0'; status: 'selected'; executable: false; requestDigest: string; snapshotDigest: string; lenderId: string; borrowAsset: Address;
  principal: string; flashFee: string; repayment: string; terminalReturn: string; minProfit: string; costInBorrowAsset: string; netProfit: string;
  allocations: AeroAllocation[]; optimality: 'best-found' | 'certified'; evaluations: number; budgetExhausted: boolean; admissionRequired: true;
}
export interface AeroRejected {schemaVersion: 'aero-split/1.0'; status: 'rejected' | 'no-profitable-plan'; executable: false; reason: string; evaluations: number; budgetExhausted: boolean}
export type AeroResult = AeroSelected | AeroRejected;

// This bounded validator accepts only the vocabulary used by our two shipped
// schemas. It is not a general JSON Schema implementation or remote resolver.
type Shape = { type?: string; const?: unknown; enum?: unknown[]; pattern?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; items?: Shape; required?: string[]; properties?: Record<string, Shape>; additionalProperties?: boolean; oneOf?: Shape[] };
function shape(value: unknown, rule: Shape): boolean {
  if (rule.oneOf && rule.oneOf.filter(r => shape(value, r)).length !== 1) return false;
  if ('const' in rule && value !== rule.const || rule.enum && !rule.enum.includes(value)) return false;
  if (rule.type === 'string' && (typeof value !== 'string' || rule.pattern && !new RegExp(rule.pattern).test(value) || typeof value === 'string' && (value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? Infinity)))) return false;
  if (rule.type === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))) return false;
  if (rule.type === 'boolean' && typeof value !== 'boolean') return false;
  if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < (rule.minItems ?? 0) || value.length > (rule.maxItems ?? Infinity)) return false;
    if (rule.items && !value.every(v => shape(v, rule.items!))) return false;
  }
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (rule.required?.some(k => !Object.hasOwn(object, k))) return false;
    if (rule.additionalProperties === false && Object.keys(object).some(k => !Object.hasOwn(rule.properties ?? {}, k))) return false;
    if (Object.entries(rule.properties ?? {}).some(([k, r]) => Object.hasOwn(object,k) && !shape(object[k],r))) return false;
  }
  return true;
}
const requestShape: Shape = JSON.parse(readFileSync(new URL('../../schemas/aero-split-request.schema.json', import.meta.url), 'utf8'));
export function parseAeroRequest(value: unknown): AeroRequest {
  if (!shape(value, requestShape)) throw new Error('INVALID_INPUT');
  const r = structuredClone(value) as AeroRequest;
  const minimum=uint(r.bounds.minimum), maximum=uint(r.bounds.maximum), quantum=uint(r.bounds.quantum);
  if (!minimum || minimum > maximum || minimum % quantum || maximum % quantum || maximum >= 1n<<255n || uint(r.bounds.deadline) <= uint(r.identity.timestamp)) throw new Error('NO_FEASIBLE_DOMAIN');
  uint(r.identity.blockNumber,64); uint(r.identity.timestamp,64); uint(r.bounds.deadline,64); uint(r.bounds.minNetProfit);
  if (/^0x0{64}$/.test(r.identity.blockHash) || r.cost.borrowAsset !== r.borrowAsset || uint(r.cost.costInBorrowAsset) !== ceilDiv(uint(r.cost.nativeCostWei)*uint(r.cost.conversionNumerator),uint(r.cost.conversionDenominator))) throw new Error('COST_EVIDENCE_INVALID');
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (!unique(r.pools.map(p=>p.poolId)) || !unique(r.pools.map(p=>p.address)) || !unique(r.branches.map(b=>b.branchId)) || !unique(r.lenders.map(l=>l.lenderId)) || !unique(r.pins.map(p=>`${p.role}:${p.address}`))) throw new Error('INVALID_INPUT');
  for (const pool of r.pools) {
    if (pool.token0 >= pool.token1 || /^0x0{40}$/.test(pool.address) || pool.decimals0 > 77 || pool.decimals1 > 77) throw new Error('INVALID_INPUT');
    const s=pool.state;
    if(s.protocol==='aero-volatile'||s.protocol==='aero-stable') {
      if(pool.generation!=='classic'||s.stable!==(s.protocol==='aero-stable')||s.reserve0!==s.balance0||s.reserve1!==s.balance1)throw new Error('INCOHERENT_SNAPSHOT');
      uint(s.reserve0);uint(s.reserve1);
    } else if(s.protocol==='uniswap-v2') {
      if(pool.generation!=='external-v2'||uint(s.feeNumerator)>uint(s.feeDenominator))throw new Error('INVALID_INPUT');
      uint(s.reserve0,112);uint(s.reserve1,112);
    } else {
      if((s.protocol==='uniswap-v3'&&pool.generation!=='external-v3')||(s.protocol==='aero-slipstream'&&!pool.generation.startsWith('cl-')))throw new Error('UNSUPPORTED_GENERATION');
      const cl=s as ConcentratedState;uint(cl.sqrtPriceX96,160);uint(cl.liquidity,128);
      if(cl.lowerTick>=cl.upperTick||cl.tick<cl.lowerTick||cl.tick>cl.upperTick)throw new Error('INCOMPLETE_TICK_COVERAGE');
    }
  }
  for (const b of r.branches) {
    let asset = r.borrowAsset;
    for(const leg of b.legs) {
      const pool=r.pools.find(p=>p.poolId===leg.poolId);
      if(!pool||leg.tokenIn!==asset||![pool.token0,pool.token1].includes(asset)||leg.minOutBps===0)throw new Error('INVALID_INPUT');
      asset=asset===pool.token0?pool.token1:pool.token0;
    }
    if(asset!==r.borrowAsset)throw new Error('INVALID_INPUT');
  }
  for(const l of r.lenders) {
    if(l.asset!==r.borrowAsset||l.feeRounding==='zero'&&uint(l.feeNumerator)!==0n||l.kind==='morpho'&&(uint(l.feeNumerator)!==0n||l.feeRounding!=='zero'))throw new Error('UNSUPPORTED_LENDER_CAPABILITY');
    uint(l.available);uint(l.feeNumerator);uint(l.feeDenominator);
  }
  return r;
}
export const aeroSnapshotDigest = (r: AeroRequest) => digest({identity:r.identity,pins:r.pins,pools:r.pools});
