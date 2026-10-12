import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { requirePublishAuthorization, type SuiDeploymentConfig } from './config.js';

export function publishCommand(config: SuiDeploymentConfig): readonly string[] {
  requirePublishAuthorization(config);
  return ['client', 'publish', resolve(config.guardPackageDir), '--gas-budget', config.gasBudgetMist.toString()];
}

function runSuiClient(args: readonly string[]): string {
  const result = spawnSync('sui', [...args], { encoding: 'utf8' });
  if (result.error) throw new Error(`Sui CLI is required: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `sui ${args.join(' ')} failed`);
  return result.stdout.trim();
}

/** Publishes only after checking the selected CLI network and wallet against explicit config. */
export function publishTerminalGuard(config: SuiDeploymentConfig): void {
  requirePublishAuthorization(config);
  const cliNetwork = runSuiClient(['client', 'active-env']);
  if (cliNetwork !== config.network) {
    throw new Error(`Sui CLI active network ${cliNetwork || '(empty)'} does not match SUI_NETWORK=${config.network}`);
  }
  const activeAddress = runSuiClient(['client', 'active-address']).toLowerCase();
  if (activeAddress !== config.deployerAddress.toLowerCase()) {
    throw new Error('Sui CLI active address does not match SUI_DEPLOYER_ADDRESS');
  }
  if (config.network === 'mainnet') {
    const chainIdentifier = runSuiClient(['client', 'chain-identifier']);
    if (chainIdentifier !== config.expectedChainIdentifier) {
      throw new Error('Sui CLI chain identifier does not match SUI_CHAIN_IDENTIFIER');
    }
  }
  const result = spawnSync('sui', [...publishCommand(config)], { stdio: 'inherit' });
  if (result.error) throw new Error(`Sui CLI publish failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error('Sui CLI publish failed');
}
