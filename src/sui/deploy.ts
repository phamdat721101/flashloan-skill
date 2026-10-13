import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { requirePublishAuthorization, requireUpgradeAuthorization, type SuiDeploymentConfig } from './config.js';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

export function publishCommand(config: SuiDeploymentConfig): readonly string[] {
  requirePublishAuthorization(config);
  return ['move', 'build', '--path', resolve(config.guardPackageDir), '--dump-bytecode-as-base64', '--ignore-chain'];
}

export function upgradeCommand(config: SuiDeploymentConfig): readonly string[] {
  requireUpgradeAuthorization(config);
  return ['move', 'build', '--path', resolve(config.guardPackageDir), '--dump-bytecode-as-base64', '--ignore-chain'];
}

interface CompiledPackage {
  modules: string[];
  dependencies: string[];
  digest: number[];
}

export interface SuiPublishReceipt {
  digest: string;
  gasUsed: {
    computationCost: string;
    storageCost: string;
    storageRebate: string;
    nonRefundableStorageFee: string;
  };
}

function compilePackage(config: SuiDeploymentConfig, command: readonly string[]): CompiledPackage {
  let output: string;
  try {
    output = execFileSync('sui', command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error('Sui Move build failed');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(output.trim());
  } catch {
    throw new Error('Sui Move build did not return package bytecode JSON');
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as CompiledPackage).modules) || !Array.isArray((payload as CompiledPackage).dependencies) || !Array.isArray((payload as CompiledPackage).digest)) {
    throw new Error('Sui Move build returned an invalid package payload');
  }
  return payload as CompiledPackage;
}

function createPublishTransaction(config: SuiDeploymentConfig, compiled: CompiledPackage): Transaction {
  const transaction = new Transaction();
  const [upgradeCap] = transaction.publish(compiled);
  transaction.transferObjects([upgradeCap], config.deployerAddress!);
  transaction.setSender(config.deployerAddress!);
  transaction.setGasBudget(config.gasBudgetMist);
  return transaction;
}

/** Publishes through the supported gRPC transport after simulation and exact signer/chain checks. */
export async function publishTerminalGuard(config: SuiDeploymentConfig, signer: Ed25519Keypair): Promise<SuiPublishReceipt> {
  requirePublishAuthorization(config);
  if (signer.toSuiAddress().toLowerCase() !== config.deployerAddress.toLowerCase()) {
    throw new Error('Sui signer address does not match SUI_DEPLOYER_ADDRESS');
  }

  const client = new SuiGrpcClient({ baseUrl: config.rpcUrl, network: config.network });
  if (config.network === 'mainnet') {
    const chain = await client.getChainIdentifier();
    if (chain.chainIdentifier !== config.expectedChainIdentifier) {
      throw new Error('Sui gRPC chain identifier does not match SUI_CHAIN_IDENTIFIER');
    }
  }

  const compiled = compilePackage(config, publishCommand(config));
  const simulation = await client.simulateTransaction({ transaction: createPublishTransaction(config, compiled), include: { effects: true } });
  if (simulation.$kind !== 'Transaction' || !simulation.Transaction.effects?.status.success) {
    throw new Error('Sui publish simulation failed');
  }

  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: createPublishTransaction(config, compiled),
    include: { effects: true }
  });
  if (result.$kind !== 'Transaction' || !result.Transaction.effects?.status.success || !result.Transaction.effects.gasUsed) {
    throw new Error('Sui publish transaction failed');
  }
  const gasUsed = result.Transaction.effects.gasUsed;
  return {
    digest: result.Transaction.digest,
    gasUsed: {
      computationCost: gasUsed.computationCost.toString(),
      storageCost: gasUsed.storageCost.toString(),
      storageRebate: gasUsed.storageRebate.toString(),
      nonRefundableStorageFee: gasUsed.nonRefundableStorageFee.toString()
    }
  };
}

function createUpgradeTransaction(config: SuiDeploymentConfig, compiled: CompiledPackage): Transaction {
  const transaction = new Transaction();
  const ticket = transaction.moveCall({
    target: '0x2::package::authorize_upgrade',
    arguments: [
      transaction.object(config.guardUpgradeCapId!),
      transaction.pure.u8(0),
      transaction.pure.vector('u8', compiled.digest)
    ]
  });
  const receipt = transaction.upgrade({
    ...compiled,
    package: config.guardPackageId!,
    ticket
  });
  transaction.moveCall({
    target: '0x2::package::commit_upgrade',
    arguments: [transaction.object(config.guardUpgradeCapId!), receipt]
  });
  transaction.setSender(config.deployerAddress!);
  transaction.setGasBudget(config.gasBudgetMist);
  return transaction;
}

async function assertUpgradeCapTargetsPackage(client: SuiGrpcClient, config: SuiDeploymentConfig): Promise<void> {
  const response = await client.getObject({ objectId: config.guardUpgradeCapId!, include: { json: true } });
  const owner = response.object.owner;
  if (owner.$kind !== 'AddressOwner' || owner.AddressOwner.toLowerCase() !== config.deployerAddress!.toLowerCase()) {
    throw new Error('Sui UpgradeCap is not owned by SUI_DEPLOYER_ADDRESS');
  }
  const content = response.object.json;
  if (!content || typeof content.package !== 'string' || content.package.toLowerCase() !== config.guardPackageId!.toLowerCase()) {
    throw new Error('Sui UpgradeCap package does not match SUI_GUARD_PACKAGE_ID');
  }
}

/** Upgrades the retained package only after a compatible gRPC simulation succeeds. */
export async function upgradeTerminalGuard(config: SuiDeploymentConfig, signer: Ed25519Keypair): Promise<SuiPublishReceipt> {
  requireUpgradeAuthorization(config);
  if (signer.toSuiAddress().toLowerCase() !== config.deployerAddress.toLowerCase()) {
    throw new Error('Sui signer address does not match SUI_DEPLOYER_ADDRESS');
  }

  const client = new SuiGrpcClient({ baseUrl: config.rpcUrl, network: config.network });
  if (config.network === 'mainnet') {
    const chain = await client.getChainIdentifier();
    if (chain.chainIdentifier !== config.expectedChainIdentifier) {
      throw new Error('Sui gRPC chain identifier does not match SUI_CHAIN_IDENTIFIER');
    }
  }
  await assertUpgradeCapTargetsPackage(client, config);

  const compiled = compilePackage(config, upgradeCommand(config));
  const simulation = await client.simulateTransaction({ transaction: createUpgradeTransaction(config, compiled), include: { effects: true } });
  if (simulation.$kind !== 'Transaction' || !simulation.Transaction.effects?.status.success) {
    throw new Error('Sui upgrade simulation failed');
  }

  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: createUpgradeTransaction(config, compiled),
    include: { effects: true }
  });
  if (result.$kind !== 'Transaction' || !result.Transaction.effects?.status.success || !result.Transaction.effects.gasUsed) {
    throw new Error('Sui upgrade transaction failed');
  }
  const gasUsed = result.Transaction.effects.gasUsed;
  return {
    digest: result.Transaction.digest,
    gasUsed: {
      computationCost: gasUsed.computationCost.toString(),
      storageCost: gasUsed.storageCost.toString(),
      storageRebate: gasUsed.storageRebate.toString(),
      nonRefundableStorageFee: gasUsed.nonRefundableStorageFee.toString()
    }
  };
}
