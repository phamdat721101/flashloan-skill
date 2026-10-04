import { createHash, randomUUID } from 'node:crypto';
import { encodeFunctionData } from 'viem';
import { FLASH_EXECUTOR_ABI, type ExecutorCapability } from './contracts/flash-executor.js';
import type { Address, AllocationLeg, AllocationPlan, Hex, Opportunity, ProposalEvidence, SkillConfig } from './types.js';

export type DynamicProtocol = 'aave-v3' | 'morpho-blue' | 'balancer-v2' | 'uniswap-v4';

interface CandidateBase {
  id: string;
  chainId: number;
  observedBlock: string;
  observedAt: string;
  expiresAt: string;
  protocol: DynamicProtocol;
}

export interface AaveLiquidationCandidate extends CandidateBase {
  protocol: 'aave-v3';
  borrower: Address;
  pool: Address;
  debtToken: Address;
  collateralToken: Address;
  debtAmount: string;
  healthFactorWad: string;
  liquidationBonusBps: number;
}

export interface MorphoLiquidationCandidate extends CandidateBase {
  protocol: 'morpho-blue';
  borrower: Address;
  blue: Address;
  marketId: Hex;
  flashToken: Address;
  collateralToken: Address;
  flashAmount: string;
  repaidShares: string;
  seizedAssets: string;
  marketParams: { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: string };
}

export interface ObservationCandidate extends CandidateBase {
  protocol: 'balancer-v2' | 'uniswap-v4';
  contract: Address;
  reason: 'callback-capability-unverified';
}

export type DynamicCandidate = AaveLiquidationCandidate | MorphoLiquidationCandidate | ObservationCandidate;

export interface RouteQuote {
  venue: string;
  router: Address;
  approveTarget: Address;
  path: Address[];
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  priceImpactBps: number;
  fee: number;
  quoteBlock: bigint;
  calldata: Hex;
}

export interface DynamicSolverConfig {
  executorAddress: Address;
  minNetProfitUsd: number;
  maxPriceImpactBps: number;
  maxProposalBlockAge: number;
  /** A route is only broadcastable once this is proven by a fork test. */
  capabilities: Partial<Record<ExecutorCapability, { enabled: boolean; forkVerified: boolean }>>;
}

export interface QuoteRequest { candidate: DynamicCandidate; repayAmount: bigint; }
export interface QuoteSource { quote(request: QuoteRequest): Promise<RouteQuote[]>; }

function address(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{40}$/.test(value)) throw new Error(`${field} must be an address`);
  return value as Address;
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`);
  return value;
}

/** Parses the secret-free solver configuration rather than trusting CLI JSON. */
export function parseDynamicSolverConfig(value: unknown): DynamicSolverConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('solver config must be an object');
  const input = value as Record<string, unknown>;
  const capabilities = input.capabilities && typeof input.capabilities === 'object' && !Array.isArray(input.capabilities)
    ? Object.fromEntries(Object.entries(input.capabilities as Record<string, unknown>).flatMap(([name, entry]) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const status = entry as Record<string, unknown>;
      return [[name, { enabled: status.enabled === true, forkVerified: status.forkVerified === true }]];
    })) as DynamicSolverConfig['capabilities'] : {};
  return { executorAddress: address(input.executorAddress, 'executorAddress'), minNetProfitUsd: positiveNumber(input.minNetProfitUsd, 'minNetProfitUsd'), maxPriceImpactBps: positiveNumber(input.maxPriceImpactBps, 'maxPriceImpactBps'), maxProposalBlockAge: positiveNumber(input.maxProposalBlockAge, 'maxProposalBlockAge'), capabilities };
}

/** Verifies discriminated candidate identity before it reaches the calldata bridge. */
export function validateDynamicCandidate(candidate: DynamicCandidate): void {
  if (!candidate.id || !Number.isInteger(candidate.chainId) || candidate.chainId <= 0 || !/^\d+$/.test(candidate.observedBlock)) throw new Error('candidate identity is invalid');
  validExpiry(candidate.expiresAt);
  if (candidate.protocol === 'aave-v3') {
    address(candidate.borrower, 'borrower'); address(candidate.pool, 'pool'); address(candidate.debtToken, 'debtToken'); address(candidate.collateralToken, 'collateralToken');
    if (!/^\d+$/.test(candidate.debtAmount) || !/^\d+$/.test(candidate.healthFactorWad) || !Number.isInteger(candidate.liquidationBonusBps)) throw new Error('Aave candidate sizing is invalid');
  } else if (candidate.protocol === 'morpho-blue') {
    address(candidate.borrower, 'borrower'); address(candidate.blue, 'blue'); address(candidate.flashToken, 'flashToken'); address(candidate.collateralToken, 'collateralToken');
    if (!/^0x[\da-fA-F]{64}$/.test(candidate.marketId) || !/^\d+$/.test(candidate.flashAmount) || !/^\d+$/.test(candidate.repaidShares) || !/^\d+$/.test(candidate.seizedAssets)) throw new Error('Morpho candidate sizing is invalid');
  } else address(candidate.contract, 'contract');
}

export function closeFactorBps(healthFactorWad: bigint): number {
  return healthFactorWad < 950_000_000_000_000_000n ? 10_000 : 5_000;
}

export function maxAaveRepay(candidate: AaveLiquidationCandidate): bigint {
  return BigInt(candidate.debtAmount) * BigInt(closeFactorBps(BigInt(candidate.healthFactorWad))) / 10_000n;
}

export function routeLegs(quotes: RouteQuote[]): AllocationLeg[] {
  if (quotes.length === 0) throw new Error('at least one route quote is required');
  const total = quotes.reduce((sum, quote) => sum + quote.amountIn, 0n);
  if (total <= 0n) throw new Error('route input must be positive');
  return quotes.map((quote, index) => ({
    venue: quote.venue,
    path: quote.path,
    allocationBps: index === quotes.length - 1
      ? 10_000 - quotes.slice(0, -1).reduce((sum, item) => sum + Number(item.amountIn * 10_000n / total), 0)
      : Number(quote.amountIn * 10_000n / total),
    minAmountOut: quote.minAmountOut
  }));
}

function capabilityFor(candidate: DynamicCandidate, split: boolean): ExecutorCapability | undefined {
  if (candidate.protocol === 'aave-v3') return split ? 'aave-v3-liquidation-split' : 'aave-v3-liquidation';
  if (candidate.protocol === 'morpho-blue') return 'morpho-blue-liquidation';
  if (candidate.protocol === 'uniswap-v4') return 'uniswap-v4-arbitrage';
  return undefined;
}

function validExpiry(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) throw new Error('candidate has expired');
}

/** Builds calldata only after all candidate, quote, and executor evidence is present. */
export function buildDynamicPlan(
  candidate: DynamicCandidate,
  quotes: RouteQuote[],
  config: DynamicSolverConfig,
  quotedNetProfitUsd: number,
  profitTokenUsd: number,
  profitTokenDecimals: number
): AllocationPlan | undefined {
  validateDynamicCandidate(candidate);
  validExpiry(candidate.expiresAt);
  if (candidate.protocol === 'balancer-v2' || candidate.protocol === 'uniswap-v4') return undefined;
  if (!Number.isFinite(quotedNetProfitUsd) || quotedNetProfitUsd < config.minNetProfitUsd) return undefined;
  if (!Number.isFinite(profitTokenUsd) || profitTokenUsd <= 0 || !Number.isInteger(profitTokenDecimals) || profitTokenDecimals < 0) throw new Error('profit valuation is invalid');
  if (quotes.length === 0 || quotes.some((quote) => quote.priceImpactBps > config.maxPriceImpactBps || quote.amountIn <= 0n || quote.minAmountOut <= 0n || !Number.isInteger(quote.fee) || quote.fee < 0)) return undefined;
  const sourceBlock = BigInt(candidate.observedBlock);
  const quoteBlock = quotes.reduce((latest, quote) => quote.quoteBlock > latest ? quote.quoteBlock : latest, 0n);
  if (quoteBlock < sourceBlock || quoteBlock - sourceBlock > BigInt(config.maxProposalBlockAge)) return undefined;
  const capability = capabilityFor(candidate, quotes.length > 1);
  if (!capability) return undefined;
  const allowed = config.capabilities[capability];
  if (!allowed?.enabled || !allowed.forkVerified) return undefined;
  const repayAmount = candidate.protocol === 'aave-v3'
    ? maxAaveRepay(candidate)
    : BigInt((candidate as MorphoLiquidationCandidate).flashAmount);
  const minProfit = BigInt(Math.ceil(config.minNetProfitUsd / profitTokenUsd * 10 ** profitTokenDecimals));
  let data: Hex;
  if (candidate.protocol === 'aave-v3' && quotes.length === 1) {
    data = encodeFunctionData({ abi: FLASH_EXECUTOR_ABI, functionName: 'executeFlashLiquidation', args: [{ debtToken: candidate.debtToken, debtAmount: repayAmount, collateralToken: candidate.collateralToken, insolventUser: candidate.borrower, dexPoolFee: quotes[0].fee, minProfit }] }) as Hex;
  } else if (candidate.protocol === 'aave-v3') {
    if (quotes.some((quote) => quote.calldata === '0x')) return undefined;
    data = encodeFunctionData({ abi: FLASH_EXECUTOR_ABI, functionName: 'executeFlashLiquidationSplit', args: [{ debtToken: candidate.debtToken, debtAmount: repayAmount, collateralToken: candidate.collateralToken, insolventUser: candidate.borrower, minProfit, routes: quotes.map((quote) => ({ router: quote.router, approveTarget: quote.approveTarget, amountIn: quote.amountIn, minAmountOut: quote.minAmountOut, callData: quote.calldata })) }] }) as Hex;
  } else {
    const morpho = candidate as MorphoLiquidationCandidate;
    data = encodeFunctionData({ abi: FLASH_EXECUTOR_ABI, functionName: 'executeMorphoMarketLiquidation', args: [{ flashToken: morpho.flashToken, flashAmount: repayAmount, marketParams: { ...morpho.marketParams, lltv: BigInt(morpho.marketParams.lltv) }, borrower: morpho.borrower, seizedAssets: BigInt(morpho.seizedAssets), repaidShares: BigInt(morpho.repaidShares), sellVenue: 0, dexPoolFee: quotes[0].fee, minProfit }] }) as Hex;
  }
  return {
    id: `proposal-${randomUUID()}`,
    opportunityId: candidate.id,
    chainId: candidate.chainId,
    strategy: `${candidate.protocol}-dynamic`,
    borrowTierUsd: 0,
    priceImpactBps: Math.max(...quotes.map((quote) => quote.priceImpactBps)),
    quotedNetProfitUsd,
    legs: routeLegs(quotes),
    transaction: { to: config.executorAddress, data },
    sourceBlock,
    quoteBlock,
    capability,
    profitTokenUsd,
    profitTokenDecimals,
    expiresAt: candidate.expiresAt
  };
}

export function candidateFingerprint(candidate: DynamicCandidate): string {
  return createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
}

/** Adapts a dynamically-built plan to the existing orchestration contract. */
export function dynamicOpportunity(candidate: DynamicCandidate, plan: AllocationPlan): Opportunity {
  return {
    id: candidate.id,
    chainId: candidate.chainId,
    channel: candidate.protocol,
    strategy: plan.strategy,
    expiresAt: candidate.expiresAt,
    buildAllocation: async () => plan,
    buildAllocations: async () => [plan]
  };
}

export function broadcastEvidence(plan: AllocationPlan): ProposalEvidence | undefined {
  if (!plan.sourceBlock || !plan.quoteBlock || !plan.expiresAt || !plan.capability) return undefined;
  return { sourceBlock: plan.sourceBlock, quoteBlock: plan.quoteBlock, expiresAt: plan.expiresAt, capability: plan.capability, broadcastEligible: true };
}
