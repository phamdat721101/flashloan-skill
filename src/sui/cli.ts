import { loadSuiDeploymentConfig, publicSuiConfig } from './config.js';
import { assertCetusPoolCanarySnapshot, loadCetusPoolCanary, snapshotCetusPoolCanary } from './cetus.js';
import { loadDeepBookFlashloanCanary, simulateDeepBookFlashloanCanary } from './deepbook.js';
import { publishTerminalGuard, upgradeTerminalGuard } from './deploy.js';
import { loadSuiOperatorWallet } from './wallet.js';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { readFileSync } from 'node:fs';
import { validateAdapterRegistry } from './manifest.js';
import type { SuiAdapterRegistry } from './types.js';

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'validate-config':
      console.log(JSON.stringify(publicSuiConfig(loadSuiDeploymentConfig()), null, 2));
      return;
    case 'wallet-address':
      console.log(loadSuiOperatorWallet().toSuiAddress());
      return;
    case 'deploy-guard':
      console.log(JSON.stringify(await publishTerminalGuard(loadSuiDeploymentConfig(), loadSuiOperatorWallet())));
      return;
    case 'upgrade-guard':
      console.log(JSON.stringify(await upgradeTerminalGuard(loadSuiDeploymentConfig(), loadSuiOperatorWallet())));
      return;
    case 'deepbook-flashloan-canary': {
      const config = loadSuiDeploymentConfig();
      if (config.network !== 'mainnet' || !config.deployerAddress) {
        throw new Error('DeepBook flashloan canary requires SUI_NETWORK=mainnet and SUI_DEPLOYER_ADDRESS');
      }
      const client = new SuiGrpcClient({ baseUrl: config.rpcUrl, network: config.network });
      console.log(JSON.stringify(await simulateDeepBookFlashloanCanary(
        client,
        loadDeepBookFlashloanCanary(),
        config.deployerAddress,
        config.gasBudgetMist
      )));
      return;
    }
    case 'cetus-pool-canary': {
      const config = loadSuiDeploymentConfig();
      if (config.network !== 'mainnet') throw new Error('Cetus pool canary requires SUI_NETWORK=mainnet');
      const client = new SuiGrpcClient({ baseUrl: config.rpcUrl, network: config.network });
      const canary = loadCetusPoolCanary();
      const snapshot = await snapshotCetusPoolCanary(client, canary);
      assertCetusPoolCanarySnapshot(canary, snapshot);
      console.log(JSON.stringify(snapshot));
      return;
    }
    case 'validate-adapter-registry': {
      const path = process.argv[3];
      if (!path) throw new Error('validate-adapter-registry requires a registry JSON path');
      const registry = JSON.parse(readFileSync(path, 'utf8')) as SuiAdapterRegistry;
      validateAdapterRegistry(registry);
      console.log(JSON.stringify({ id: registry.id, network: registry.network, lenders: registry.lenders.map((lender) => lender.id), venues: registry.venues.map((venue) => venue.id) }));
      return;
    }
    default:
      throw new Error('Usage: sui:validate-config | wallet-address | sui:deploy-guard | sui:upgrade-guard | deepbook-flashloan-canary | cetus-pool-canary | validate-adapter-registry <file>');
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
