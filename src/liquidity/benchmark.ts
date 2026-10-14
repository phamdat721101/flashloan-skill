import { readFile } from 'node:fs/promises';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import { analyzeLiquidity, runLiquidityAnalytics } from './analytics.js';

const project = JSON.parse(await readFile(new URL('../../schemas/examples/liquidity-project-v4.json',import.meta.url),'utf8'));
const sizing = JSON.parse(await readFile(new URL('../../schemas/examples/liquidity-sizing-v4.json',import.meta.url),'utf8'));
function measure(command: string,input: unknown,iterations: number) {
  for (let i = 0; i < 20; i++) analyzeLiquidity(command,input);
  const durations: number[] = [], before = process.memoryUsage().heapUsed;
  for (let i = 0; i < iterations; i++) { const start = performance.now(); analyzeLiquidity(command,input); durations.push(performance.now() - start); }
  durations.sort((a,b) => a - b);
  return { samples: iterations,p50Ms: durations[Math.floor(iterations * 0.50)],p95Ms: durations[Math.floor(iterations * 0.95)],p99Ms: durations[Math.floor(iterations * 0.99)],heapDeltaBytes: process.memoryUsage().heapUsed - before };
}
const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
const start = performance.now();
const result = await runLiquidityAnalytics('size',sizing);
const workerRoundtripMs = performance.now() - start;
histogram.disable();
console.log(JSON.stringify({ schemaVersion: '4.0',kind: 'synthetic-benchmark-not-admission',runtime: process.version,platform: platform(),arch: arch(),cpu: cpus()[0]?.model,projection: measure('project',project,1000),sizing: measure('size',sizing,50),workerRoundtripMs,workerEventLoopP99Ms: histogram.percentile(99) / 1e6,quoteEvaluations: 'evaluations' in result ? result.evaluations : null,heapMeasurement: 'observed-delta-includes-GC-not-allocation-count',networkAndSigning: 'excluded' }));
