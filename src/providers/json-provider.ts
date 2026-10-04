import { readFile } from 'node:fs/promises';
import type { OpportunityProvider } from '../connectors.js';
import type { Address, AllocationPlan, Hex, Opportunity, SkillConfig } from '../types.js';

interface JsonPlan {
  id: string;
  borrowTierUsd: number;
  priceImpactBps: number;
  quotedNetProfitUsd: number;
  legs: Array<{ venue: string; path: Address[]; allocationBps: number; minAmountOut: string }>;
  transaction: { to: Address; data: Hex; value?: string };
  sourceBlock?: string;
  quoteBlock?: string;
  capability?: AllocationPlan['capability'];
  profitTokenUsd?: number;
  profitTokenDecimals?: number;
}

interface JsonOpportunity {
  id: string;
  chainId: number;
  channel: string;
  strategy: string;
  expiresAt: string;
  plans: JsonPlan[];
}

/** Bridges an independently-run scanner into the stable skill data contract. */
export class JsonOpportunityProvider implements OpportunityProvider {
  readonly id = 'json-opportunity-provider';
  constructor(private readonly filePath: string) {}

  async discover(_config: SkillConfig): Promise<Opportunity[]> {
    const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as JsonOpportunity[];
    if (!Array.isArray(raw)) throw new Error('opportunity file must contain an array');
    return raw.map((candidate) => ({
      ...candidate,
      buildAllocation: async (tier: number): Promise<AllocationPlan | undefined> => {
        const plan = candidate.plans.find((item) => item.borrowTierUsd === tier);
        if (!plan) return undefined;
        return {
          ...plan,
          opportunityId: candidate.id,
          chainId: candidate.chainId,
          strategy: candidate.strategy,
          expiresAt: candidate.expiresAt,
          sourceBlock: plan.sourceBlock ? BigInt(plan.sourceBlock) : undefined,
          quoteBlock: plan.quoteBlock ? BigInt(plan.quoteBlock) : undefined,
          legs: plan.legs.map((leg) => ({ ...leg, minAmountOut: BigInt(leg.minAmountOut) })),
          transaction: { ...plan.transaction, value: plan.transaction.value ? BigInt(plan.transaction.value) : undefined }
        };
      }
    }));
  }
}
