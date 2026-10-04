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
