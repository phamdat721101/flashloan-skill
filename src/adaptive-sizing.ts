/** Exact, state-bound sampling. Every invocation consumes an attempt, including failures. */
export interface SizingBounds {
  minAmount: bigint; maxAmount: bigint; quantum: bigint;
  maxEvaluations: number; deadlineMs: number; maxPriceImpactBps: number;
  expectedBlock: bigint; expectedStateDigest: string; minProfitRaw: bigint;
  signal?: AbortSignal;
}
export interface SizeQuote {
  amountIn: bigint; netProfitRaw: bigint; priceImpactBps: number;
  quoteBlock: bigint; stateDigest: string;
}
export interface AdaptiveSizingResult {
  winner?: SizeQuote; evaluated: SizeQuote[]; attempted: number; rejected: number;
  rejectedQuotes: Record<string, number>;
  termination: 'domain-complete' | 'attempt-budget' | 'time-budget' | 'cancelled';
}
export type SizeQuoter = (amountIn: bigint, signal: AbortSignal) => Promise<SizeQuote | undefined>;
export async function optimizeTradeSize(bounds: SizingBounds, quote: SizeQuoter): Promise<AdaptiveSizingResult> {
  if (typeof bounds.minAmount !== 'bigint' || typeof bounds.maxAmount !== 'bigint' || typeof bounds.quantum !== 'bigint' || typeof bounds.minProfitRaw !== 'bigint' || bounds.minAmount <= 0n || bounds.maxAmount < bounds.minAmount || bounds.quantum <= 0n || bounds.minProfitRaw <= 0n || typeof bounds.expectedBlock !== 'bigint' || bounds.expectedBlock < 0n || !/^[a-f0-9]{64}$/.test(bounds.expectedStateDigest) || !Number.isSafeInteger(bounds.maxEvaluations) || bounds.maxEvaluations < 1 || bounds.maxEvaluations > 100000 || !Number.isSafeInteger(bounds.deadlineMs) || bounds.deadlineMs < 1 || bounds.deadlineMs > 3600000 || !Number.isInteger(bounds.maxPriceImpactBps) || bounds.maxPriceImpactBps < 0 || bounds.maxPriceImpactBps > 10000) throw new Error('INVALID_SIZING_BOUNDS');
  const minimum = (bounds.minAmount + bounds.quantum - 1n) / bounds.quantum * bounds.quantum;
  const maximum = bounds.maxAmount / bounds.quantum * bounds.quantum;
  if (minimum > maximum) throw new Error('NO_FEASIBLE_SIZING_DOMAIN');
  const count = (maximum - minimum) / bounds.quantum + 1n;
  const limit = Math.min(bounds.maxEvaluations, count > BigInt(bounds.maxEvaluations) ? bounds.maxEvaluations : Number(count));
  const controller = new AbortController(), deadline = performance.now() + bounds.deadlineMs;
  const abort = () => controller.abort(); bounds.signal?.addEventListener('abort', abort, { once: true });
  const result: AdaptiveSizingResult = { evaluated: [], attempted: 0, rejected: 0, rejectedQuotes: {}, termination: 'attempt-budget' };
  const reject = (code: string) => { result.rejected++; result.rejectedQuotes[code] = (result.rejectedQuotes[code] ?? 0) + 1; };
  try {
    for (let i = 0; i < limit; i++) {
      if (bounds.signal?.aborted) { result.termination = 'cancelled'; break; }
      const remaining = deadline - performance.now();
      if (remaining <= 0) { result.termination = 'time-budget'; break; }
      const index = count <= BigInt(limit) ? BigInt(i) : BigInt(i) * (count - 1n) / BigInt(Math.max(1, limit - 1));
      const amount = minimum + index * bounds.quantum;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stop: (() => void) | undefined;
      result.attempted++;
      try {
        const cancelled = new Promise<never>((_, fail) => {
          stop = () => fail(new Error('CANCELLED'));
          controller.signal.addEventListener('abort', stop, { once: true });
          timer = setTimeout(() => { fail(new Error('QUOTE_DEADLINE')); controller.abort(); }, remaining);
        });
        const q = await Promise.race([Promise.resolve().then(() => quote(amount, controller.signal)), cancelled]);
        if (!q || q.amountIn !== amount || typeof q.netProfitRaw !== 'bigint' || q.quoteBlock !== bounds.expectedBlock || q.stateDigest !== bounds.expectedStateDigest || !Number.isInteger(q.priceImpactBps) || q.priceImpactBps < 0 || q.priceImpactBps > 10000) { reject('INVALID_OR_FOREIGN_QUOTE'); continue; }
        result.evaluated.push(q);
        if (q.priceImpactBps <= bounds.maxPriceImpactBps && q.netProfitRaw >= bounds.minProfitRaw && (!result.winner || q.netProfitRaw > result.winner.netProfitRaw || q.netProfitRaw === result.winner.netProfitRaw && q.amountIn < result.winner.amountIn)) result.winner = q;
      } catch (error) {
        const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'QUOTE_REJECTED'; reject(code);
        if (code === 'QUOTE_DEADLINE' || code === 'CANCELLED') { result.termination = bounds.signal?.aborted ? 'cancelled' : 'time-budget'; break; }
      } finally { clearTimeout(timer); if (stop) controller.signal.removeEventListener('abort', stop); }
    }
    if (BigInt(result.attempted) === count && !result.rejected) result.termination = 'domain-complete';
    return result;
  } finally { bounds.signal?.removeEventListener('abort', abort); controller.abort(); }
}
