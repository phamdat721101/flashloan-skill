import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { describeLiquidity, parsePoolState, projectPool, type LiquidityDescription, type ProjectionResult } from './projection.js';
import { compareRouteDirections, sizeRoute, sizeConditionalCycle, type ConditionalVenue, type ConditionalSizingResult, type RouteComparison, type SizingResult } from './sizing.js';
import { prepareArbitrumTrade, type ArbitrumTradeBinding, type PreparedArbitrumTrade } from './arbitrum.js';
import type { LiquiditySnapshot } from './state.js';
import { decodeCetusCheckpoint, type CheckpointObjectSet, type CetusDecodeConfig, type PinnedSuiObject } from '../sui/cetus.js';
import { quoteDeepBookExactInput, type DeepBookBookState, type DeepBookQuote } from '../sui/deepbook.js';
import { prepareSuiTrade, type SuiTradeBinding, type PreparedSuiTrade } from '../sui/route.js';
import { quoteAlgebraExactInput, type AlgebraLinkedState, type AlgebraFeeResolution, type AlgebraQuote } from './algebra.js';
import { v2InputForPrice } from './v2.js';
import { uint } from './state.js';

export type AnalyticsOutput = ProjectionResult | SizingResult | ConditionalSizingResult | RouteComparison | PreparedArbitrumTrade | PreparedSuiTrade | DeepBookQuote | AlgebraQuote | ReturnType<typeof decodeCetusCheckpoint> | LiquidityDescription | { schemaVersion: '4.0'; amountIn: string };
function parseAnalyticsInput(command: string, input: unknown): Record<string,unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_ANALYTICS_INPUT');
  const value = input as Record<string,unknown>;
  if (command === 'size-conditional') {
    if (value.schemaVersion !== '4.0' || Object.keys(value).sort().join(',') !== 'request,schemaVersion,venues') throw new Error('INVALID_ANALYTICS_FIELDS');
    return value;
  }
  const expected = command === 'inspect' ? ['schemaVersion','pool'] : command === 'project' ? ['schemaVersion','pool','request'] : ['size','compare'].includes(command) ? ['schemaVersion','pools','request'] : ['prepare-arbitrum','prepare-sui'].includes(command) ? ['schemaVersion','pools','request','snapshot','binding'] : command === 'decode-cetus' ? ['schemaVersion','checkpoint','objects','config'] : command === 'quote-deepbook' ? ['schemaVersion','state','baseToQuote','amountIn'] : command === 'quote-algebra' ? ['schemaVersion','state','zeroForOne','amountIn','feeResolution'] : command === 'target-price' ? ['schemaVersion','pool','tokenIn','target','maximum'] : [];
  if (!expected.length) throw new Error('UNSUPPORTED_ANALYTICS_COMMAND');
  if (value.schemaVersion !== '4.0' || Object.keys(value).sort().join(',') !== expected.sort().join(',')) throw new Error('INVALID_ANALYTICS_FIELDS');
  return value;
}
export function analyzeLiquidity(command: string, input: unknown): AnalyticsOutput {
  const value = parseAnalyticsInput(command,input);
  if (command === 'size-conditional') return sizeConditionalCycle(value.venues as ConditionalVenue[],value.request);
  if (command === 'decode-cetus') return decodeCetusCheckpoint(value.checkpoint as CheckpointObjectSet,value.objects as PinnedSuiObject[],value.config as CetusDecodeConfig);
  if (command === 'quote-deepbook') return quoteDeepBookExactInput(value.state as DeepBookBookState,value.baseToQuote as boolean,value.amountIn as string);
  if (command === 'quote-algebra') return quoteAlgebraExactInput(value.state as AlgebraLinkedState,value.zeroForOne as boolean,value.amountIn as string,value.feeResolution === null ? undefined : value.feeResolution as AlgebraFeeResolution);
  if (command === 'prepare-sui') throw new Error('ASYNC_ANALYTICS_REQUIRED');
  if (command === 'project') return projectPool(value.pool,value.request);
  if (command === 'inspect') return describeLiquidity(value.pool);
  if (command === 'size') return sizeRoute(value.pools,value.request);
  if (command === 'compare') return compareRouteDirections(value.pools,value.request);
  if (command === 'prepare-arbitrum') return prepareArbitrumTrade(value.pools,value.request,value.snapshot as LiquiditySnapshot,value.binding as ArbitrumTradeBinding);
  const pool = parsePoolState(value.pool);
  if (pool.state.protocol !== 'uniswap-v2') throw new Error('UNSUPPORTED_INVERSE_ADAPTER');
  if (typeof value.tokenIn !== 'string' || ![pool.token0.toLowerCase(),pool.token1.toLowerCase()].includes(value.tokenIn.toLowerCase()) || !value.target || typeof value.target !== 'object' || Array.isArray(value.target) || Object.keys(value.target).sort().join(',') !== 'denominator,numerator') throw new Error('INVALID_INVERSE_INPUT');
  const target = value.target as { numerator: string; denominator: string };
  uint(target.numerator); uint(target.denominator); uint(value.maximum);
  // Inverse targets use raw token1/token0 price; displayed decimal scaling is deliberately separate.
  return { schemaVersion: '4.0', amountIn: v2InputForPrice(pool.state,value.tokenIn.toLowerCase() === pool.token0.toLowerCase(),target,value.maximum as string) };
}
/** Worker isolation bounds CPU time and heap without blocking ingestion or loading a wallet. */
export function runLiquidityAnalytics(command: string, input: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<AnalyticsOutput> {
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) return Promise.reject(new Error('INVALID_ANALYTICS_TIMEOUT'));
  if (options.signal?.aborted) return Promise.reject(new Error('ANALYTICS_CANCELLED'));
  return new Promise((resolve,reject) => {
    // Node's worker does not inherit tsx's source resolver. Development uses its
    // installed loader explicitly; compiled distribution needs no tsx at runtime.
    const sourceMode = import.meta.url.endsWith('.ts');
    const data = { liquidityAnalytics: true,command,input,moduleUrl: import.meta.url,
      ...(sourceMode ? { loaderUrl: import.meta.resolve('tsx/esm/api') } : {}) };
    const bootstrap = 'const {workerData}=require("node:worker_threads"); import(workerData.loaderUrl).then(({register})=>{register();return import(workerData.moduleUrl);});';
    const worker = new Worker(sourceMode ? bootstrap : new URL(import.meta.url), { eval: sourceMode,execArgv: sourceMode ? [] : process.execArgv.filter(value => !value.startsWith('--input-type')),workerData: data,resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let settled = false;
    const finish = (error?: Error, output?: AnalyticsOutput) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort',abort);
      void worker.terminate(); if (error) reject(error); else resolve(output!);
    };
    const abort = () => finish(new Error('ANALYTICS_CANCELLED'));
    const timer = setTimeout(() => finish(new Error('ANALYTICS_TIMEOUT')),timeout);
    options.signal?.addEventListener('abort',abort,{ once: true });
    if (options.signal?.aborted) abort();
    worker.once('message',(message: { output?: AnalyticsOutput; error?: string }) => message.error ? finish(new Error(message.error)) : finish(undefined,message.output));
    worker.once('error',() => finish(new Error('ANALYTICS_WORKER_FAILED')));
    worker.once('exit',() => { if (!settled) finish(new Error('ANALYTICS_WORKER_EXITED')); });
  });
}
if (!isMainThread && workerData?.liquidityAnalytics === true) {
  void (async () => {
    try {
      const value = parseAnalyticsInput(workerData.command,workerData.input);
      const output = workerData.command === 'prepare-sui' ? await prepareSuiTrade(value.pools,value.request,value.snapshot as LiquiditySnapshot,value.binding as SuiTradeBinding) : analyzeLiquidity(workerData.command,workerData.input);
      parentPort!.postMessage({ output });
    } catch (error) { parentPort!.postMessage({ error: error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'ANALYTICS_FAILED' }); }
  })();
}
