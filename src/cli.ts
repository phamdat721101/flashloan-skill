import { ArbitrumExecutorAdapter } from './arbitrum.js';
import { loadConfig } from './config.js';
import { FlashloanOrchestrator } from './orchestrator.js';
import { JsonOpportunityProvider } from './providers/json-provider.js';
import { DailyLossLedger } from './loss-ledger.js';
import { ExecutionLock } from './execution-lock.js';

const [command, opportunityFile] = process.argv.slice(2);
const config = loadConfig();

if (command === 'validate-config') {
  console.log(JSON.stringify({ chainId: config.chainId, executorConfigured: Boolean(config.executorAddress), walletConfigured: Boolean(config.operatorPrivateKey), risk: config.risk }));
} else if (command === 'run' && opportunityFile) {
  const nativeTokenUsd = Number(process.env.NATIVE_TOKEN_USD);
  if (!Number.isFinite(nativeTokenUsd) || nativeTokenUsd <= 0) throw new Error('NATIVE_TOKEN_USD is required for live risk accounting');
  const adapter = new ArbitrumExecutorAdapter(config, nativeTokenUsd);
  const stateDir = process.env.FLASHLOAN_STATE_DIR ?? '.flashloan-agent';
  const ledger = new DailyLossLedger(`${stateDir}/daily-loss.json`);
  const lock = new ExecutionLock(`${stateDir}/execution.lock`);
  const result = await lock.runExclusive(() => new FlashloanOrchestrator([new JsonOpportunityProvider(opportunityFile)], adapter, ledger).run(config));
  console.log(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value));
} else {
  throw new Error('usage: validate-config | run <opportunities.json>');
}
