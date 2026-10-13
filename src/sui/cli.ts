import { loadSuiDeploymentConfig, publicSuiConfig } from './config.js';
import { assertCetusPoolCanarySnapshot, loadCetusPoolCanary, snapshotCetusPoolCanary } from './cetus.js';
import { loadDeepBookFlashloanCanary, simulateDeepBookFlashloanCanary } from './deepbook.js';
import { publishTerminalGuard } from './deploy.js';
import { loadSuiOperatorWallet } from './wallet.js';
import { SuiGrpcClient } from '@mysten/sui/grpc';

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
    default:
      throw new Error('Usage: sui:validate-config | wallet-address | sui:deploy-guard | deepbook-flashloan-canary | cetus-pool-canary');
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
