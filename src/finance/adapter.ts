import type { Account, ActionState, Amount, Asset, Coverage, EvidenceRef, EvmPosition, LocalPlan, Network, Observation, Pin, Plan, Receipt, XrplLoan } from './contracts.js';

export interface AccountRead { balances: Amount[]; observation: Observation; reservedXrp?: Amount | null }
export interface PositionRead { positions: Array<EvmPosition | XrplLoan>; observation: Observation; coverage: Coverage }
export interface SimulationResult { fidelity: 'native' | 'model' | 'fixture'; pass: boolean; postconditionsPass: boolean; expectedSpend: Amount[]; expectedReceive: Amount[]; errors: string[]; observation: Observation }
export interface ReconcileResult { state: ActionState; reconciliation: Receipt['reconciliation']; effects: Amount[]; evidence: EvidenceRef[] }
export interface Fresh { payload: LocalPlan['nativePayload']; cost: LocalPlan['costs'][number]; observation: Observation }

/**
 * One native network host. Unknown support never falls through to another chain or a public
 * broadcast host: each method throws a typed FinanceError instead.
 */
export interface FinanceAdapter {
  readonly network: Network;
  capabilities(): Array<{ operation: string; protocol: string | null; admitted: boolean }>;
  readAccount(account: Account, assets: Asset[], maxAgeSeconds?: number): Promise<AccountRead>;
  readPositions(account: Account, maxAgeSeconds?: number): Promise<PositionRead>;
  /** Verifies the research payload against admitted targets/selectors/arguments and returns code/network/owner pins. */
  admitPayload(plan: Plan): Promise<Pin[]>;
  freshPayload(payload: LocalPlan['nativePayload']): Promise<Fresh>;
  simulateExact(plan: LocalPlan): Promise<SimulationResult>;
  validateSignedArtifact(plan: LocalPlan, signed: string): { transactionId: string };
  submitKnownArtifact(signed: string): Promise<string>;
  reconcileKnownReference(plan: LocalPlan, transactionId: string): Promise<ReconcileResult>;
}
/** Sign-only host. It must never broadcast; the runtime submits the validated artifact itself. */
export interface FinanceSigner { sign(plan: LocalPlan): Promise<string> }
