import { ArbitrumExecutorAdapter } from './arbitrum.js';
import { loadConfig } from './config.js';
import { FlashloanOrchestrator } from './orchestrator.js';
import { JsonOpportunityProvider } from './providers/json-provider.js';
import { DailyLossLedger } from './loss-ledger.js';
import { ExecutionLock } from './execution-lock.js';
import { loadScannerConfig } from './scan/config.js';
import { ArbitrumScanner } from './scan/scanner.js';

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
} else if (command === 'run' && opportunityFile) {
  const config = loadConfig();
  const nativeTokenUsd = Number(process.env.NATIVE_TOKEN_USD);
  if (!Number.isFinite(nativeTokenUsd) || nativeTokenUsd <= 0) throw new Error('NATIVE_TOKEN_USD is required for live risk accounting');
  const adapter = new ArbitrumExecutorAdapter(config, nativeTokenUsd);
  const stateDir = process.env.FLASHLOAN_STATE_DIR ?? '.flashloan-agent';
  const ledger = new DailyLossLedger(`${stateDir}/daily-loss.json`);
  const lock = new ExecutionLock(`${stateDir}/execution.lock`);
  const result = await lock.runExclusive(() => new FlashloanOrchestrator([new JsonOpportunityProvider(opportunityFile)], adapter, ledger).run(config));
  console.log(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value));
} else {
  throw new Error('usage: validate-config | scan --config <scanner-config.json> [--once|--watch] | run <opportunities.json>');
}
