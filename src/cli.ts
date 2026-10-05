import { ArbitrumExecutorAdapter } from './arbitrum.js';
import { loadConfig } from './config.js';
import { FlashloanOrchestrator } from './orchestrator.js';
import { JsonOpportunityProvider } from './providers/json-provider.js';
import { DailyLossLedger } from './loss-ledger.js';
import { ExecutionLock } from './execution-lock.js';
import { loadScannerConfig } from './scan/config.js';
import { ArbitrumScanner } from './scan/scanner.js';
import { readFile } from 'node:fs/promises';
import { buildDynamicPlan, parseDynamicSolverConfig, type DynamicCandidate, type RouteQuote } from './dynamic.js';
import { NimRuntimeMemory } from './nim-memory.js';
import { loadBridgeConfig } from './bridge/config.js';
import { runDexBridge } from './bridge/runtime.js';

const [command, opportunityFile] = process.argv.slice(2);

if (command === 'validate-config') {
  const config = loadConfig();
  console.log(JSON.stringify({ chainId: config.chainId, executorConfigured: Boolean(config.executorAddress), walletConfigured: Boolean(config.operatorPrivateKey), risk: config.risk }));
} else if (command === 'scan') {
  const args = process.argv.slice(3);
  if (args.includes('--live') || args.includes('--execute')) throw new Error('scan is read-only; --live and --execute are not supported');
  const configIndex = args.indexOf('--config');
  const scannerConfigPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  if (!scannerConfigPath) throw new Error('usage: scan --config <scanner-config.json> [--once|--watch]');
  const scannerConfig = await loadScannerConfig(scannerConfigPath);
  const scanner = new ArbitrumScanner(scannerConfig);
  const watch = args.includes('--watch');
  do {
    const result = await scanner.scanOnce();
    console.log(JSON.stringify(result));
    if (!watch) break;
    await new Promise((resolve) => setTimeout(resolve, scannerConfig.pollIntervalMs));
  } while (true);
} else if (command === 'bridge') {
  const args = process.argv.slice(3);
  if (args.includes('--execute') || args.includes('--live')) throw new Error('bridge is read-only; use execute-auto only after an explicit operator review');
  const configIndex = args.indexOf('--config');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  if (!configPath) throw new Error('usage: bridge --config <bridge-config.json> [--once]');
  console.log(JSON.stringify(await runDexBridge(await loadBridgeConfig(configPath))));
} else if (command === 'solve' && opportunityFile) {
  const args = process.argv.slice(3);
  const configIndex = args.indexOf('--config');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  if (!configPath) throw new Error('usage: solve <solver-input.json> --config <solver-config.json>');
  const input = JSON.parse(await readFile(opportunityFile, 'utf8')) as Array<{ candidate: DynamicCandidate; quotes: Array<Omit<RouteQuote, 'amountIn' | 'amountOut' | 'minAmountOut' | 'quoteBlock'> & { amountIn: string; amountOut: string; minAmountOut: string; quoteBlock: string }>; quotedNetProfitUsd: number; profitTokenUsd: number; profitTokenDecimals: number }>;
  const config = parseDynamicSolverConfig(JSON.parse(await readFile(configPath, 'utf8')));
  if (!Array.isArray(input)) throw new Error('solver input must be an array');
  const memory = new NimRuntimeMemory(process.env.NIM_MEMORY_DIR ?? '.nim');
  const plans = input.flatMap((item) => {
    try {
      const plan = buildDynamicPlan(item.candidate, item.quotes.map((quote) => ({ ...quote, amountIn: BigInt(quote.amountIn), amountOut: BigInt(quote.amountOut), minAmountOut: BigInt(quote.minAmountOut), quoteBlock: BigInt(quote.quoteBlock) })), config, item.quotedNetProfitUsd, item.profitTokenUsd, item.profitTokenDecimals);
      void memory.record({ schemaVersion: '1.0', occurredAt: new Date().toISOString(), runId: item.candidate.id, stage: 'solve', outcome: plan ? 'accepted' : 'blocked', code: plan ? 'PROPOSAL_BUILT' : 'PROPOSAL_REJECTED', retryable: false, protocol: item.candidate.protocol, blockNumber: item.candidate.observedBlock });
      return plan ? [plan] : [];
    } catch (error) {
      void memory.record({ schemaVersion: '1.0', occurredAt: new Date().toISOString(), runId: item.candidate.id, stage: 'solve', outcome: 'failed', code: 'SOLVER_INPUT_INVALID', retryable: false, protocol: item.candidate.protocol, blockNumber: item.candidate.observedBlock, detail: error instanceof Error ? error.message : String(error) });
      return [];
    }
  });
  console.log(JSON.stringify(plans, (_, value) => typeof value === 'bigint' ? value.toString() : value));
} else if ((command === 'simulate' || command === 'execute-auto' || command === 'run') && opportunityFile) {
  const config = loadConfig();
  const nativeTokenUsd = Number(process.env.NATIVE_TOKEN_USD);
  if (!Number.isFinite(nativeTokenUsd) || nativeTokenUsd <= 0) throw new Error('NATIVE_TOKEN_USD is required for live risk accounting');
  const adapter = new ArbitrumExecutorAdapter(config, nativeTokenUsd);
  const stateDir = process.env.FLASHLOAN_STATE_DIR ?? '.flashloan-agent';
  const ledger = new DailyLossLedger(`${stateDir}/daily-loss.json`);
  const lock = new ExecutionLock(`${stateDir}/execution.lock`);
  const result = await lock.runExclusive(() => new FlashloanOrchestrator([new JsonOpportunityProvider(opportunityFile)], adapter, ledger).run(config, { broadcast: command !== 'simulate' }));
  console.log(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value));
} else {
  throw new Error('usage: validate-config | scan --config <scanner-config.json> [--once|--watch] | bridge --config <bridge-config.json> [--once] | solve <solver-input.json> --config <solver-config.json> | simulate <opportunities.json> | execute-auto <opportunities.json>');
}
