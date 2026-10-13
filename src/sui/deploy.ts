import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { requirePublishAuthorization, type SuiDeploymentConfig } from './config.js';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

export function publishCommand(config: SuiDeploymentConfig): readonly string[] {
  requirePublishAuthorization(config);
  return ['move', 'build', '--path', resolve(config.guardPackageDir), '--dump-bytecode-as-base64', '--ignore-chain'];
}

interface CompiledPackage {
  modules: string[];
  dependencies: string[];
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

function compilePackage(config: SuiDeploymentConfig): CompiledPackage {
  let output: string;
  try {
    output = execFileSync('sui', publishCommand(config), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error('Sui Move build failed');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(output.trim());
  } catch {
    throw new Error('Sui Move build did not return package bytecode JSON');
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as CompiledPackage).modules) || !Array.isArray((payload as CompiledPackage).dependencies)) {
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

  const compiled = compilePackage(config);
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
