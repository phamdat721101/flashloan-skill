import { loadSuiDeploymentConfig, publicSuiConfig } from './config.js';
import { publishTerminalGuard } from './deploy.js';
import { loadSuiOperatorWallet } from './wallet.js';

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
      publishTerminalGuard(loadSuiDeploymentConfig());
      return;
    default:
      throw new Error('Usage: sui:validate-config | wallet-address | sui:deploy-guard');
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
