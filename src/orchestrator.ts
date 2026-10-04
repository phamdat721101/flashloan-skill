import type { ExecutorAdapter, OpportunityProvider } from './connectors.js';
import { canBroadcast } from './config.js';
import type { DailyLossLedger } from './loss-ledger.js';
import { evaluateRisk } from './risk.js';
import type { AllocationPlan, RunResult, SkillConfig } from './types.js';

export class FlashloanOrchestrator {
  constructor(
    private readonly providers: OpportunityProvider[],
    private readonly executor: ExecutorAdapter,
    private readonly ledger?: DailyLossLedger
  ) {}

  async run(config: SkillConfig): Promise<RunResult> {
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
      for (const tier of config.risk.borrowTiersUsd) {
        const plan = await opportunity.buildAllocation(tier);
        if (plan) plans.push(plan);
      }
    }

    const dailyRealizedLossUsd = await this.ledger?.currentLossUsd() ?? 0;
    const simulated = await Promise.all(plans.map(async (plan) => ({ plan, simulation: await this.executor.simulate(plan) })));
    const decisions = simulated.map(({ plan, simulation }) => evaluateRisk(plan, simulation, config.risk, dailyRealizedLossUsd));
    const winner = simulated
      .filter(({ plan, simulation }) => decisions.find((decision) => decision.planId === plan.id && decision.allowed)?.allowed && simulation.ok)
      .sort((left, right) => (right.simulation.expectedNetProfitUsd ?? -Infinity) - (left.simulation.expectedNetProfitUsd ?? -Infinity))[0];
    if (!winner) return { decisions, diagnostics };
    if (!canBroadcast(config)) {
      diagnostics.push('broadcast skipped: OPERATOR_PRIVATE_KEY and FLASH_EXECUTOR_ADDRESS are both required');
      return { decisions, diagnostics };
    }
    const receipt = await this.executor.broadcast(winner.plan);
    if (receipt.realizedProfitUsd !== undefined) await this.ledger?.recordProfit(receipt.realizedProfitUsd);
    return { decisions, diagnostics, receipt };
  }
}
