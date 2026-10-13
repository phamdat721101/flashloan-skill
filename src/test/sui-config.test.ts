import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSuiDeploymentConfig, requireAutonomousExecution, requirePublishAuthorization, requireUpgradeAuthorization } from '../sui/config.js';
import { publishCommand, upgradeCommand } from '../sui/deploy.js';
import { loadSuiOperatorWallet } from '../sui/wallet.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const valid = {
  SUI_NETWORK: 'testnet',
  SUI_RPC_URL: 'https://fullnode.testnet.sui.io:443',
  SUI_EXECUTION_MODE: 'testnet-canary',
  SUI_GUARD_PACKAGE_DIR: '.',
  SUI_GAS_BUDGET_MIST: '100000000',
  SUI_DEPLOYER_ADDRESS: '0xabc',
  SUI_DEPLOY_CONFIRM: 'publish'
};

test('accepts an explicit testnet deployment configuration', () => {
  const config = loadSuiDeploymentConfig(valid);
  requirePublishAuthorization(config);
  assert.deepEqual(publishCommand(config).slice(0, 4), ['move', 'build', '--path', process.cwd()]);
});

test('refuses accidental deployment settings', () => {
  assert.throws(() => loadSuiDeploymentConfig({ ...valid, SUI_RPC_URL: 'http://example.com' }), /HTTPS/);
  assert.throws(() => requirePublishAuthorization(loadSuiDeploymentConfig({ ...valid, SUI_DEPLOY_CONFIRM: '' })), /SUI_DEPLOY_CONFIRM/);
  assert.throws(() => requirePublishAuthorization(loadSuiDeploymentConfig({ ...valid, SUI_EXECUTION_MODE: 'dry-run' })), /requires SUI_EXECUTION_MODE/);
});

test('requires a distinct confirmation and chain identifier for mainnet', () => {
  const mainnet = {
    ...valid,
    SUI_NETWORK: 'mainnet',
    SUI_RPC_URL: 'https://fullnode.mainnet.sui.io:443',
    SUI_EXECUTION_MODE: 'mainnet-canary',
    SUI_MAINNET_DEPLOY_CONFIRM: 'I_UNDERSTAND_MAINNET_DEPLOYMENT',
    SUI_CHAIN_IDENTIFIER: 'reviewed-mainnet-chain-id'
  };
  assert.doesNotThrow(() => requirePublishAuthorization(loadSuiDeploymentConfig(mainnet)));
  assert.throws(() => requirePublishAuthorization(loadSuiDeploymentConfig({ ...mainnet, SUI_MAINNET_DEPLOY_CONFIRM: '' })), /SUI_MAINNET_DEPLOY_CONFIRM/);
  assert.throws(() => requirePublishAuthorization(loadSuiDeploymentConfig({ ...mainnet, SUI_CHAIN_IDENTIFIER: '' })), /SUI_CHAIN_IDENTIFIER/);
});

test('requires distinct upgrade consent and reviewed package controls', () => {
  const upgrade = loadSuiDeploymentConfig({
    ...valid,
    SUI_DEPLOY_CONFIRM: 'upgrade',
    SUI_GUARD_PACKAGE_ID: '0x123',
    SUI_GUARD_UPGRADE_CAP_ID: '0x456'
  });
  assert.doesNotThrow(() => requireUpgradeAuthorization(upgrade));
  assert.deepEqual(upgradeCommand(upgrade).slice(0, 4), ['move', 'build', '--path', process.cwd()]);
  assert.throws(() => requireUpgradeAuthorization(loadSuiDeploymentConfig({ ...valid, SUI_DEPLOY_CONFIRM: 'upgrade' })), /SUI_GUARD_PACKAGE_ID/);
  assert.throws(() => requireUpgradeAuthorization(loadSuiDeploymentConfig({ ...valid, SUI_GUARD_PACKAGE_ID: '0x123', SUI_GUARD_UPGRADE_CAP_ID: '0x456' })), /SUI_DEPLOY_CONFIRM=upgrade/);
});

test('allows auto mode only for fully identified mainnet execution', () => {
  const automatic = loadSuiDeploymentConfig({
    ...valid,
    SUI_NETWORK: 'mainnet',
    SUI_RPC_URL: 'https://fullnode.mainnet.sui.io:443',
    SUI_EXECUTION_MODE: 'auto',
    SUI_CHAIN_IDENTIFIER: 'reviewed-mainnet-chain-id'
  });
  assert.doesNotThrow(() => requireAutonomousExecution(automatic));
  assert.throws(() => requireAutonomousExecution(loadSuiDeploymentConfig({ ...valid, SUI_EXECUTION_MODE: 'auto' })), /SUI_NETWORK/);
});

test('loads only a Bech32 Ed25519 operator secret in memory', () => {
  const source = new Ed25519Keypair();
  const restored = loadSuiOperatorWallet({ SUI_OPERATOR_PRIVATE_KEY: source.getSecretKey() });
  assert.equal(restored.toSuiAddress(), source.toSuiAddress());
  assert.throws(() => loadSuiOperatorWallet({ SUI_OPERATOR_PRIVATE_KEY: '0x1234' }), /Bech32/);
});
