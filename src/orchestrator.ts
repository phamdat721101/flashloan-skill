import type { ExecutorAdapter, OpportunityProvider } from './connectors.js';
import { canBroadcast } from './config.js';
import type { DailyLossLedger } from './loss-ledger.js';
import { evaluateRisk } from './risk.js';
import { executionOutcome } from './execution-outcome.js';
import type { AllocationPlan, RunResult, SkillConfig } from './types.js';

async function mapBounded<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(limit)), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

export class FlashloanOrchestrator {
  constructor(
    private readonly providers: OpportunityProvider[],
    private readonly executor: ExecutorAdapter,
    private readonly ledger?: DailyLossLedger
  ) {}

  async run(config: SkillConfig, options: { broadcast?: boolean } = {}): Promise<RunResult> {
    await this.executor.verify(config);
    const diagnostics: string[] = [];
    const discovered = await Promise.allSettled(this.providers.map((provider) => provider.discover(config)));
    const opportunities = discovered.flatMap((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      diagnostics.push(`provider ${this.providers[index].id} failed: ${String(result.reason)}`);
      return [];
    // EDGE-03: stale or cross-chain opportunities cannot race into the allocation phase.
    }).filter((opportunity) => opportunity.chainId === config.chainId && Date.parse(opportunity.expiresAt) > Date.now());

    const plans: AllocationPlan[] = [];
    for (const opportunity of opportunities) {
      if (opportunity.buildAllocations) {
        try {
          plans.push(...await opportunity.buildAllocations(config));
        } catch (error) {
          diagnostics.push(`${opportunity.id}: ${JSON.stringify(executionOutcome('build', error))}`);
        }
        continue;
      }
      for (const tier of config.risk.borrowTiersUsd) {
        const plan = await opportunity.buildAllocation(tier);
        if (plan) plans.push(plan);
      }
    }

    const dailyRealizedLossUsd = await this.ledger?.currentLossUsd() ?? 0;
    const executionHalted = await this.ledger?.isHalted() ?? false;
    const simulated = await mapBounded(plans, config.risk.rpcConcurrency, async (plan) => ({ plan, simulation: await this.executor.simulate(plan) }));
    const decisions = simulated.map(({ plan, simulation }) => evaluateRisk(plan, simulation, config.risk, dailyRealizedLossUsd, executionHalted));
    const winner = simulated
      .filter(({ plan, simulation }) => decisions.find((decision) => decision.planId === plan.id && decision.allowed)?.allowed && simulation.ok)
      .sort((left, right) => (right.simulation.expectedNetProfitUsd ?? -Infinity) - (left.simulation.expectedNetProfitUsd ?? -Infinity))[0];
    if (!winner) return { decisions, diagnostics };
    if (options.broadcast === false) {
      diagnostics.push('broadcast skipped: simulation-only mode');
      return { decisions, diagnostics };
    }
    if (!canBroadcast(config)) {
      diagnostics.push('broadcast skipped: OPERATOR_PRIVATE_KEY, FLASH_EXECUTOR_ADDRESS, and PRIVATE_RELAY_URL are all required');
      return { decisions, diagnostics };
    }
    const receipt = await this.executor.broadcast(winner.plan);
    if (receipt.realizedPnlStatus === 'unknown') await this.ledger?.halt(receipt.outcome?.message ?? 'realized P&L unavailable');
    else if (receipt.realizedProfitUsd !== undefined) await this.ledger?.recordProfit(receipt.realizedProfitUsd);
    return { decisions, diagnostics, receipt };
  }
}
