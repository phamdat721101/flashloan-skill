import { existsSync } from 'node:fs';

export type SuiNetwork = 'mainnet' | 'testnet' | 'localnet';
export type SuiExecutionMode = 'read-only' | 'dry-run' | 'testnet-canary' | 'mainnet-canary' | 'auto';

export interface SuiDeploymentConfig {
  network: SuiNetwork;
  rpcUrl: string;
  executionMode: SuiExecutionMode;
  guardPackageDir: string;
  gasBudgetMist: bigint;
  deployerAddress?: `0x${string}`;
  deployConfirmation?: string;
  mainnetConfirmation?: string;
  expectedChainIdentifier?: string;
  guardPackageId?: `0x${string}`;
  guardUpgradeCapId?: `0x${string}`;
}

const ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseNetwork(value: string | undefined): SuiNetwork {
  if (value === 'mainnet' || value === 'testnet' || value === 'localnet') return value;
  throw new Error('SUI_NETWORK must be mainnet, testnet, or localnet');
}

function parseExecutionMode(value: string | undefined): SuiExecutionMode {
  if (value === 'read-only' || value === 'dry-run' || value === 'testnet-canary' || value === 'mainnet-canary' || value === 'auto') return value;
  throw new Error('SUI_EXECUTION_MODE must be read-only, dry-run, testnet-canary, mainnet-canary, or auto');
}

/** Auto mode is a separate runtime authorization and is never sufficient to publish a Move package. */
export function requireAutonomousExecution(config: SuiDeploymentConfig): void {
  if (config.network !== 'mainnet' || config.executionMode !== 'auto') {
    throw new Error('Autonomous execution requires SUI_NETWORK=mainnet and SUI_EXECUTION_MODE=auto');
  }
  if (!config.deployerAddress || !config.expectedChainIdentifier) {
    throw new Error('Autonomous execution requires SUI_DEPLOYER_ADDRESS and SUI_CHAIN_IDENTIFIER');
  }
}

function parseAddress(value: string | undefined, name: string): `0x${string}` | undefined {
  if (!value) return undefined;
  if (!ADDRESS.test(value)) throw new Error(`${name} must be a Sui hex address`);
  return value.toLowerCase() as `0x${string}`;
}

function parseMist(value: string | undefined): bigint {
  const amount = required(value, 'SUI_GAS_BUDGET_MIST');
  if (!DECIMAL.test(amount) || BigInt(amount) === 0n) {
    throw new Error('SUI_GAS_BUDGET_MIST must be a positive decimal integer');
  }
  return BigInt(amount);
}

function parseRpcUrl(value: string | undefined, network: SuiNetwork): string {
  const raw = required(value, 'SUI_RPC_URL');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('SUI_RPC_URL must be an absolute URL');
  }
  const localHttp = network === 'localnet' && url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('SUI_RPC_URL must use HTTPS except for localhost localnet');
  }
  return url.toString();
}

/** Loads only non-secret deployment inputs. The signer is loaded separately on send paths. */
export function loadSuiDeploymentConfig(env: NodeJS.ProcessEnv = process.env): SuiDeploymentConfig {
  const network = parseNetwork(env.SUI_NETWORK);
  const guardPackageDir = required(env.SUI_GUARD_PACKAGE_DIR, 'SUI_GUARD_PACKAGE_DIR');
  if (!existsSync(guardPackageDir)) throw new Error('SUI_GUARD_PACKAGE_DIR does not exist');

  return {
    network,
    rpcUrl: parseRpcUrl(env.SUI_RPC_URL, network),
    executionMode: parseExecutionMode(env.SUI_EXECUTION_MODE),
    guardPackageDir,
    gasBudgetMist: parseMist(env.SUI_GAS_BUDGET_MIST),
    deployerAddress: parseAddress(env.SUI_DEPLOYER_ADDRESS, 'SUI_DEPLOYER_ADDRESS'),
    deployConfirmation: env.SUI_DEPLOY_CONFIRM,
    mainnetConfirmation: env.SUI_MAINNET_DEPLOY_CONFIRM,
    expectedChainIdentifier: env.SUI_CHAIN_IDENTIFIER,
    guardPackageId: parseAddress(env.SUI_GUARD_PACKAGE_ID, 'SUI_GUARD_PACKAGE_ID'),
    guardUpgradeCapId: parseAddress(env.SUI_GUARD_UPGRADE_CAP_ID, 'SUI_GUARD_UPGRADE_CAP_ID')
  };
}

/** Upgrade consent is distinct from a fresh publish and requires the existing package controls. */
export function requireUpgradeAuthorization(config: SuiDeploymentConfig): asserts config is SuiDeploymentConfig & {
  deployerAddress: `0x${string}`;
  guardPackageId: `0x${string}`;
  guardUpgradeCapId: `0x${string}`;
} {
  const expectedMode = config.network === 'mainnet' ? 'mainnet-canary' : 'testnet-canary';
  if (config.executionMode !== expectedMode) {
    throw new Error(`Upgrading on ${config.network} requires SUI_EXECUTION_MODE=${expectedMode}`);
  }
  if (config.deployConfirmation !== 'upgrade') {
    throw new Error('Upgrading requires SUI_DEPLOY_CONFIRM=upgrade');
  }
  if (!config.deployerAddress) throw new Error('SUI_DEPLOYER_ADDRESS is required for upgrading');
  if (!config.guardPackageId || !config.guardUpgradeCapId) {
    throw new Error('Upgrading requires SUI_GUARD_PACKAGE_ID and SUI_GUARD_UPGRADE_CAP_ID');
  }
  if (config.network === 'mainnet') {
    if (config.mainnetConfirmation !== 'I_UNDERSTAND_MAINNET_DEPLOYMENT') {
      throw new Error('Mainnet upgrading requires SUI_MAINNET_DEPLOY_CONFIRM=I_UNDERSTAND_MAINNET_DEPLOYMENT');
    }
    if (!config.expectedChainIdentifier) throw new Error('Mainnet upgrading requires SUI_CHAIN_IDENTIFIER');
  }
}

export function requirePublishAuthorization(config: SuiDeploymentConfig): asserts config is SuiDeploymentConfig & {
  deployerAddress: `0x${string}`;
} {
  const expectedMode = config.network === 'mainnet' ? 'mainnet-canary' : 'testnet-canary';
  if (config.executionMode !== expectedMode) {
    throw new Error(`Publishing to ${config.network} requires SUI_EXECUTION_MODE=${expectedMode}`);
  }
  if (config.deployConfirmation !== 'publish') {
    throw new Error('Publishing requires SUI_DEPLOY_CONFIRM=publish');
  }
  if (!config.deployerAddress) throw new Error('SUI_DEPLOYER_ADDRESS is required for publishing');
  if (config.network === 'mainnet') {
    if (config.mainnetConfirmation !== 'I_UNDERSTAND_MAINNET_DEPLOYMENT') {
      throw new Error('Mainnet publishing requires SUI_MAINNET_DEPLOY_CONFIRM=I_UNDERSTAND_MAINNET_DEPLOYMENT');
    }
    if (!config.expectedChainIdentifier) throw new Error('Mainnet publishing requires SUI_CHAIN_IDENTIFIER');
  }
}

export function publicSuiConfig(config: SuiDeploymentConfig): Record<string, string> {
  return {
    network: config.network,
    rpcUrl: config.rpcUrl,
    executionMode: config.executionMode,
    guardPackageDir: config.guardPackageDir,
    gasBudgetMist: config.gasBudgetMist.toString(),
    deployerAddress: config.deployerAddress ?? '',
    expectedChainIdentifier: config.expectedChainIdentifier ?? '',
    guardPackageId: config.guardPackageId ?? '',
    guardUpgradeCapId: config.guardUpgradeCapId ?? ''
  };
}
