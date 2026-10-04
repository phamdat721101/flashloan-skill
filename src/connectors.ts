import type { AllocationPlan, ExecutionReceipt, Opportunity, SimulationResult, SkillConfig } from './types.js';

export interface OpportunityProvider {
  readonly id: string;
  discover(config: SkillConfig): Promise<Opportunity[]>;
}

export interface ExecutorAdapter {
  readonly chainId: number;
  verify(config: SkillConfig): Promise<void>;
  simulate(plan: AllocationPlan): Promise<SimulationResult>;
  broadcast(plan: AllocationPlan): Promise<ExecutionReceipt>;
}

export class ConnectorRegistry {
  private readonly executors = new Map<number, ExecutorAdapter>();

  register(executor: ExecutorAdapter): void {
    if (this.executors.has(executor.chainId)) throw new Error(`executor already registered for chain ${executor.chainId}`);
    this.executors.set(executor.chainId, executor);
  }

  executorFor(chainId: number): ExecutorAdapter {
    const executor = this.executors.get(chainId);
    if (!executor) throw new Error(`no verified executor adapter registered for chain ${chainId}`);
    return executor;
  }
}
