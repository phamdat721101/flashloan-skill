import { randomUUID } from 'node:crypto';
import { createPublicClient, decodeEventLog, http, type Address, type Hex } from 'viem';
import { arbitrum } from 'viem/chains';
import type { PoolAdmission, ScannerConfig, ScanDiagnostic, ScanEnvelope, ScanOpportunity, ScanProtocol, VenueDescriptor } from './types.js';
import { ScanStore } from './store.js';

const AAVE_ABI = [
  { type: 'event', name: 'Borrow', inputs: [{ indexed: true, name: 'reserve', type: 'address' }, { indexed: false, name: 'user', type: 'address' }, { indexed: true, name: 'onBehalfOf', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' }, { indexed: false, name: 'interestRateMode', type: 'uint8' }, { indexed: false, name: 'borrowRate', type: 'uint256' }, { indexed: false, name: 'referralCode', type: 'uint16' }] },
  { type: 'function', name: 'getUserAccountData', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: 'totalCollateralBase', type: 'uint256' }, { name: 'totalDebtBase', type: 'uint256' }, { name: 'availableBorrowsBase', type: 'uint256' }, { name: 'currentLiquidationThreshold', type: 'uint256' }, { name: 'ltv', type: 'uint256' }, { name: 'healthFactor', type: 'uint256' }] }
] as const;
const MORPHO_ABI = [
  { type: 'event', name: 'Borrow', inputs: [{ indexed: true, name: 'id', type: 'bytes32' }, { indexed: false, name: 'caller', type: 'address' }, { indexed: true, name: 'onBehalf', type: 'address' }, { indexed: true, name: 'receiver', type: 'address' }, { indexed: false, name: 'assets', type: 'uint256' }, { indexed: false, name: 'shares', type: 'uint256' }] },
  { type: 'function', name: 'position', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'user', type: 'address' }], outputs: [{ name: 'supplyShares', type: 'uint256' }, { name: 'borrowShares', type: 'uint128' }, { name: 'collateral', type: 'uint128' }] },
  { type: 'function', name: 'idToMarketParams', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' }, { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' }] },
  { type: 'function', name: 'market', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ name: 'totalSupplyAssets', type: 'uint128' }, { name: 'totalSupplyShares', type: 'uint128' }, { name: 'totalBorrowAssets', type: 'uint128' }, { name: 'totalBorrowShares', type: 'uint128' }, { name: 'lastUpdate', type: 'uint128' }, { name: 'fee', type: 'uint128' }] }
] as const;
const MORPHO_ORACLE_ABI = [{ type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ name: 'price', type: 'uint256' }] }] as const;
const BALANCER_ABI = [
  { type: 'event', name: 'PoolRegistered', inputs: [{ indexed: true, name: 'poolId', type: 'bytes32' }, { indexed: true, name: 'poolAddress', type: 'address' }, { indexed: false, name: 'specialization', type: 'uint8' }] },
  { type: 'function', name: 'getPoolTokens', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ name: 'tokens', type: 'address[]' }, { name: 'balances', type: 'uint256[]' }, { name: 'lastChangeBlock', type: 'uint256' }] }
] as const;
const V4_ABI = [
  { type: 'event', name: 'Initialize', inputs: [{ indexed: true, name: 'id', type: 'bytes32' }, { indexed: true, name: 'currency0', type: 'address' }, { indexed: true, name: 'currency1', type: 'address' }, { indexed: false, name: 'fee', type: 'uint24' }, { indexed: false, name: 'tickSpacing', type: 'int24' }, { indexed: false, name: 'hooks', type: 'address' }, { indexed: false, name: 'sqrtPriceX96', type: 'uint160' }, { indexed: false, name: 'tick', type: 'int24' }] }
] as const;
const V2_FACTORY_ABI = [
  { type: 'event', name: 'PairCreated', inputs: [{ indexed: true, name: 'token0', type: 'address' }, { indexed: true, name: 'token1', type: 'address' }, { indexed: false, name: 'pair', type: 'address' }, { indexed: false, name: 'allPairsLength', type: 'uint256' }] }
] as const;
const V3_FACTORY_ABI = [
  { type: 'event', name: 'PoolCreated', inputs: [{ indexed: true, name: 'token0', type: 'address' }, { indexed: true, name: 'token1', type: 'address' }, { indexed: true, name: 'fee', type: 'uint24' }, { indexed: false, name: 'tickSpacing', type: 'int24' }, { indexed: false, name: 'pool', type: 'address' }] }
] as const;

const WAD = 1_000_000_000_000_000_000n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function diagnostic(protocol: ScanProtocol | undefined, stage: ScanDiagnostic['stage'], error: unknown): ScanDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const retryable = /timeout|429|rate|temporar|network|fetch/i.test(message);
  return { protocol, stage, code: retryable ? 'RPC_TRANSIENT' : 'RPC_PERMANENT', message, retryable };
}

function id(protocol: ScanProtocol, blockNumber: bigint, parts: string[]): string {
  return `${protocol}:${blockNumber}:${parts.join(':').toLowerCase()}`;
}

function admission(config: ScannerConfig, blockNumber: bigint, referenceBlock: bigint, assets: readonly Address[]): { admission: PoolAdmission; reasons: string[] } {
  const policy = config.assetRiskPolicy;
  const reasons: string[] = [];
  if (policy?.denylist?.some((denied) => assets.some((asset) => asset.toLowerCase() === denied.toLowerCase()))) reasons.push('TOKEN_DENYLISTED');
  if (config.assetAllowlist?.length && !assets.some((asset) => config.assetAllowlist!.some((allowed) => allowed.toLowerCase() === asset.toLowerCase()))) reasons.push('LEGACY_ALLOWLIST_MISS');
  if (policy?.minPoolAgeBlocks && referenceBlock - blockNumber < BigInt(policy.minPoolAgeBlocks)) reasons.push('POOL_TOO_NEW');
  return { admission: reasons.length ? 'rejected' : 'evaluable', reasons };
}

function isAllowed(assets: readonly Address[] | undefined, values: readonly Address[]): boolean {
  return !assets?.length || values.some((value) => assets.some((asset) => asset.toLowerCase() === value.toLowerCase()));
}

export class ArbitrumScanner {
  private readonly client;
  private readonly store;
  private readonly aaveBorrowers = new Set<Address>();
  private readonly morphoBorrowers = new Map<string, { marketId: Hex; borrower: Address }>();

  constructor(private readonly config: ScannerConfig) {
    this.client = createPublicClient({ chain: arbitrum, transport: http(config.rpcUrl) });
    this.store = new ScanStore(config.stateDir ?? '.flashloan-agent/scan');
  }

  async scanOnce(): Promise<ScanEnvelope> {
    const diagnostics: ScanDiagnostic[] = [];
    const chainId = await this.client.getChainId();
    if (chainId !== this.config.chainId) throw new Error(`scanner RPC chain ${chainId} does not match configured chain ${this.config.chainId}`);
    const head = await this.client.getBlock();
    const finalBlock = head.number - BigInt(this.config.finalityBlocks ?? 20);
    if (finalBlock < BigInt(this.config.startBlock)) throw new Error('finalized head is below scanner startBlock');
    const checkpoint = await this.store.loadCheckpoint();
    const entities = await this.store.loadEntities();
    entities.aaveBorrowers.forEach((borrower) => this.aaveBorrowers.add(borrower as Address));
    entities.morphoBorrowers.forEach((entry) => this.morphoBorrowers.set(`${entry.marketId}:${entry.borrower}`.toLowerCase(), { marketId: entry.marketId as Hex, borrower: entry.borrower as Address }));
    let fromBlock = BigInt(this.config.startBlock);
    if (checkpoint) {
      try {
        const checkpointBlock = await this.client.getBlock({ blockNumber: BigInt(checkpoint.blockNumber) });
        if (checkpointBlock.hash !== checkpoint.blockHash) {
          diagnostics.push({ protocol: undefined, stage: 'checkpoint', code: 'REORG_DETECTED', message: `checkpoint ${checkpoint.blockNumber} changed hash; replaying finality window`, retryable: true });
          fromBlock = BigInt(checkpoint.blockNumber) > BigInt(this.config.finalityBlocks ?? 20) ? BigInt(checkpoint.blockNumber) - BigInt(this.config.finalityBlocks ?? 20) : BigInt(this.config.startBlock);
        } else fromBlock = BigInt(checkpoint.blockNumber) + 1n;
      } catch (error) { diagnostics.push(diagnostic(undefined, 'checkpoint', error)); }
    }
    const opportunities: ScanOpportunity[] = [];
    if (fromBlock <= finalBlock) {
      const chunks = this.chunks(fromBlock, finalBlock);
      for (const [start, end] of chunks) await this.scanRange(start, end, opportunities, diagnostics);
    }
    const finalized = await this.client.getBlock({ blockNumber: finalBlock });
    await this.store.saveCheckpoint({ chainId: this.config.chainId, blockNumber: finalBlock.toString(), blockHash: finalized.hash });
    await this.store.saveEntities({ aaveBorrowers: [...this.aaveBorrowers], morphoBorrowers: [...this.morphoBorrowers.values()] });
    const envelope: ScanEnvelope = { schemaVersion: '2.0', runId: randomUUID(), chainId: this.config.chainId, observedBlock: { number: finalBlock.toString(), hash: finalized.hash, timestamp: new Date(Number(finalized.timestamp) * 1_000).toISOString() }, opportunities, diagnostics };
    if (this.config.outputFile) await this.store.appendEnvelope(this.config.outputFile, envelope);
    return envelope;
  }

  private chunks(from: bigint, to: bigint): Array<[bigint, bigint]> {
    const result: Array<[bigint, bigint]> = [];
    const size = BigInt(this.config.logChunkSize ?? 2_000);
    for (let cursor = from; cursor <= to; cursor += size) result.push([cursor, cursor + size - 1n > to ? to : cursor + size - 1n]);
    return result;
  }

  private async scanRange(fromBlock: bigint, toBlock: bigint, opportunities: ScanOpportunity[], diagnostics: ScanDiagnostic[]): Promise<void> {
    await Promise.all([
      this.scanAave(fromBlock, toBlock, opportunities, diagnostics),
      this.scanMorpho(fromBlock, toBlock, opportunities, diagnostics),
      this.scanBalancer(fromBlock, toBlock, opportunities, diagnostics),
      this.scanFactories(fromBlock, toBlock, opportunities, diagnostics),
      this.scanV4(fromBlock, toBlock, opportunities, diagnostics)
    ]);
  }

  private expiry(): string { return new Date(Date.now() + 60_000).toISOString(); }

  private venues(): VenueDescriptor[] {
    const legacy = (this.config.factories ?? []).map((factory) => ({ family: factory.family, factory: factory.factory } as VenueDescriptor));
    return [...legacy, ...(this.config.venues ?? [])];
  }

  private async aaveAccountData(pool: Address, borrowers: Address[], multicall3?: Address, healthBatchSize = 200): Promise<Array<readonly [bigint, bigint, bigint, bigint, bigint, bigint] | undefined>> {
    if (!multicall3) return Promise.all(borrowers.map(async (borrower) => this.client.readContract({ address: pool, abi: AAVE_ABI, functionName: 'getUserAccountData', args: [borrower] })));
    const values: Array<readonly [bigint, bigint, bigint, bigint, bigint, bigint] | undefined> = [];
    for (let index = 0; index < borrowers.length; index += healthBatchSize) {
      const batch = borrowers.slice(index, index + healthBatchSize);
      const results = await this.client.multicall({ multicallAddress: multicall3, allowFailure: true, contracts: batch.map((borrower) => ({ address: pool, abi: AAVE_ABI, functionName: 'getUserAccountData', args: [borrower] })) });
      values.push(...results.map((result) => result.status === 'success' ? result.result : undefined));
    }
    return values;
  }

  private async scanAave(fromBlock: bigint, toBlock: bigint, out: ScanOpportunity[], diagnostics: ScanDiagnostic[]): Promise<void> {
    const config = this.config.protocols.aaveV3;
    if (!config) return;
    try {
      const logs = await this.client.getLogs({ address: config.pool, event: AAVE_ABI[0], fromBlock, toBlock });
      logs.map((log) => log.args.onBehalfOf).filter(Boolean).forEach((borrower) => this.aaveBorrowers.add(borrower as Address));
      const borrowers = [...this.aaveBorrowers];
      const accounts = await this.aaveAccountData(config.pool, borrowers, config.multicall3, config.healthBatchSize);
      for (const [index, borrower] of borrowers.entries()) {
        const data = accounts[index];
        if (!data) continue;
        const healthFactor = Number((data[5] * 1_000_000n) / WAD) / 1_000_000;
        if (data[1] === 0n || healthFactor > (config.warningHealthFactor ?? 1.08)) continue;
        const block = logs.find((log) => log.args.onBehalfOf?.toLowerCase() === borrower.toLowerCase())?.blockNumber ?? toBlock;
        const reserves = logs.filter((log) => log.args.onBehalfOf?.toLowerCase() === borrower.toLowerCase()).map((log) => log.args.reserve).filter(Boolean) as Address[];
        out.push({ id: id('aave-v3', block, [borrower]), protocol: 'aave-v3', kind: 'liquidation-watch', status: healthFactor < 1 ? 'actionable' : 'validated', observedBlock: block.toString(), observedAt: new Date().toISOString(), expiresAt: this.expiry(), target: { borrower, pool: config.pool }, metrics: { healthFactor: healthFactor.toFixed(8), totalDebtBase: data[1].toString(), totalCollateralBase: data[0].toString() }, executionIntent: { kind: 'aave-v3-liquidation', contract: config.pool, metadata: { borrower } }, candidate: { protocol: 'aave-v3', borrower, pool: config.pool, reserves, healthFactorWad: data[5].toString(), totalDebtBase: data[1].toString(), totalCollateralBase: data[0].toString() } });
      }
    } catch (error) { diagnostics.push(diagnostic('aave-v3', 'logs', error)); }
  }

  private async scanMorpho(fromBlock: bigint, toBlock: bigint, out: ScanOpportunity[], diagnostics: ScanDiagnostic[]): Promise<void> {
    const config = this.config.protocols.morphoBlue;
    if (!config) return;
    try {
      const logs = await this.client.getLogs({ address: config.blue, event: MORPHO_ABI[0], fromBlock, toBlock });
      for (const log of logs) {
        const borrower = log.args.onBehalf;
        const marketId = log.args.id;
        if (!borrower || !marketId) continue;
        this.morphoBorrowers.set(`${marketId}:${borrower}`.toLowerCase(), { marketId, borrower });
      }
      for (const { marketId, borrower } of this.morphoBorrowers.values()) {
        const position = await this.client.readContract({ address: config.blue, abi: MORPHO_ABI, functionName: 'position', args: [marketId, borrower] });
        if (position[1] === 0n) continue;
        const [params, market] = await Promise.all([
          this.client.readContract({ address: config.blue, abi: MORPHO_ABI, functionName: 'idToMarketParams', args: [marketId] }),
          this.client.readContract({ address: config.blue, abi: MORPHO_ABI, functionName: 'market', args: [marketId] })
        ]);
        if (market[3] === 0n) continue;
        const oraclePrice = await this.client.readContract({ address: params[2], abi: MORPHO_ORACLE_ABI, functionName: 'price' });
        const borrowedAssets = (position[1] * market[2]) / market[3];
        const collateralValue = (position[2] * oraclePrice) / 1_000_000_000_000_000_000_000_000_000_000_000_000n;
        const healthFactor = borrowedAssets === 0n ? 0 : Number((collateralValue * params[4] * 1_000_000n) / borrowedAssets / WAD) / 1_000_000;
        if (healthFactor > (config.warningHealthFactor ?? 1.05)) continue;
        out.push({ id: id('morpho-blue', toBlock, [marketId, borrower]), protocol: 'morpho-blue', kind: 'liquidation-watch', status: healthFactor < 1 ? 'actionable' : 'validated', observedBlock: toBlock.toString(), observedAt: new Date().toISOString(), expiresAt: this.expiry(), target: { borrower, marketId, blue: config.blue }, metrics: { borrowShares: position[1].toString(), collateral: position[2].toString(), borrowedAssets: borrowedAssets.toString(), healthFactor: healthFactor.toFixed(8) }, executionIntent: { kind: 'morpho-blue-liquidation', contract: config.blue, metadata: { borrower, marketId } }, candidate: { protocol: 'morpho-blue', borrower, blue: config.blue, marketId, loanToken: params[0], collateralToken: params[1], oracle: params[2], irm: params[3], lltv: params[4].toString(), borrowShares: position[1].toString(), borrowedAssets: borrowedAssets.toString(), collateral: position[2].toString() } });
      }
    } catch (error) { diagnostics.push(diagnostic('morpho-blue', 'logs', error)); }
  }

  /** Discovers only configured factory families; quote and execution remain separate gates. */
  private async scanFactories(fromBlock: bigint, toBlock: bigint, out: ScanOpportunity[], diagnostics: ScanDiagnostic[]): Promise<void> {
    await Promise.all(this.venues().filter((venue) => venue.family !== 'uniswap-v4').map(async (factory) => {
      try {
        if (factory.family === 'uniswap-v2') {
          const factoryAddress = factory.factory!;
          const logs = await this.client.getLogs({ address: factoryAddress, event: V2_FACTORY_ABI[0], fromBlock, toBlock });
          for (const log of logs) {
            const { token0, token1, pair } = log.args;
            if (!token0 || !token1 || !pair) continue;
            const gate = admission(this.config, log.blockNumber!, toBlock, [token0, token1]);
            out.push({ id: id('uniswap-v2', log.blockNumber!, [factoryAddress, pair]), protocol: 'uniswap-v2', kind: 'arbitrage-pool', status: 'observed', observedBlock: log.blockNumber!.toString(), observedAt: new Date().toISOString(), expiresAt: this.expiry(), target: { factory: factoryAddress, pool: pair, token0, token1 }, metrics: { family: 'uniswap-v2', admission: gate.admission, admissionReasons: gate.reasons.join(',') }, executionIntent: { kind: 'uniswap-v2-arbitrage', contract: factoryAddress, metadata: { factory: factoryAddress, pool: pair, token0, token1 } }, candidate: { protocol: 'uniswap-v2', factory: factoryAddress, pool: pair, token0, token1, admission: gate.admission, admissionReasons: gate.reasons, broadcastEligible: false } });
          }
        } else {
          const factoryAddress = factory.factory!;
          const logs = await this.client.getLogs({ address: factoryAddress, event: V3_FACTORY_ABI[0], fromBlock, toBlock });
          for (const log of logs) {
            const { token0, token1, fee, tickSpacing, pool } = log.args;
            if (!token0 || !token1 || fee === undefined || tickSpacing === undefined || !pool) continue;
            const gate = admission(this.config, log.blockNumber!, toBlock, [token0, token1]);
            out.push({ id: id('uniswap-v3', log.blockNumber!, [factoryAddress, pool]), protocol: 'uniswap-v3', kind: 'arbitrage-pool', status: 'observed', observedBlock: log.blockNumber!.toString(), observedAt: new Date().toISOString(), expiresAt: this.expiry(), target: { factory: factoryAddress, pool, token0, token1 }, metrics: { family: 'uniswap-v3', fee: fee.toString(), tickSpacing: tickSpacing.toString(), admission: gate.admission, admissionReasons: gate.reasons.join(',') }, executionIntent: { kind: 'uniswap-v3-arbitrage', contract: factoryAddress, metadata: { factory: factoryAddress, pool, token0, token1, fee: fee.toString(), tickSpacing: tickSpacing.toString() } }, candidate: { protocol: 'uniswap-v3', factory: factoryAddress, pool, token0, token1, fee, tickSpacing, admission: gate.admission, admissionReasons: gate.reasons, broadcastEligible: false } });
          }
        }
      } catch (error) { diagnostics.push(diagnostic(factory.family, 'logs', error)); }
    }));
  }

  private async scanBalancer(fromBlock: bigint, toBlock: bigint, out: ScanOpportunity[], diagnostics: ScanDiagnostic[]): Promise<void> {
    const config = this.config.protocols.balancerV2;
    if (!config) return;
    try {
      const logs = await this.client.getLogs({ address: config.vault, event: BALANCER_ABI[0], fromBlock, toBlock });
      for (const log of logs) {
        const poolId = log.args.poolId;
        if (!poolId) continue;
        const [tokens, balances] = await this.client.readContract({ address: config.vault, abi: BALANCER_ABI, functionName: 'getPoolTokens', args: [poolId] });
        if (!isAllowed(this.config.assetAllowlist, tokens)) continue;
        out.push({ id: id('balancer-v2', log.blockNumber!, [poolId]), protocol: 'balancer-v2', kind: 'flash-liquidity', status: 'validated', observedBlock: log.blockNumber!.toString(), observedAt: new Date().toISOString(), expiresAt: this.expiry(), target: { vault: config.vault, poolId, poolAddress: log.args.poolAddress! }, metrics: { tokens: tokens.join(','), balances: balances.map((item) => item.toString()).join(',') }, executionIntent: { kind: 'balancer-v2-flash-loan', contract: config.vault, metadata: { poolId, tokens: [...tokens], callbackRequired: true } }, candidate: { protocol: 'balancer-v2', vault: config.vault, poolId, callbackRequired: true, broadcastEligible: false } });
      }
    } catch (error) { diagnostics.push(diagnostic('balancer-v2', 'logs', error)); }
  }

  private async scanV4(fromBlock: bigint, toBlock: bigint, out: ScanOpportunity[], diagnostics: ScanDiagnostic[]): Promise<void> {
    const legacy = this.config.protocols.uniswapV4 ? [{ family: 'uniswap-v4' as const, poolManager: this.config.protocols.uniswapV4.poolManager, allowHooks: this.config.protocols.uniswapV4.allowHooks }] : [];
    const managers = [...legacy, ...this.venues().filter((venue) => venue.family === 'uniswap-v4')];
    await Promise.all(managers.map(async (config) => {
      try {
      const poolManager = config.poolManager!;
      const logs = await this.client.getLogs({ address: poolManager, event: V4_ABI[0], fromBlock, toBlock });
      for (const log of logs) {
        const { id: poolId, currency0, currency1, hooks } = log.args;
        if (!poolId || !currency0 || !currency1 || !hooks) continue;
        if (!config.allowHooks && hooks.toLowerCase() !== ZERO_ADDRESS) continue;
        const gate = admission(this.config, log.blockNumber!, toBlock, [currency0, currency1]);
        out.push({ id: id('uniswap-v4', log.blockNumber!, [poolId]), protocol: 'uniswap-v4', kind: 'pool-liquidity', status: 'observed', observedBlock: log.blockNumber!.toString(), observedAt: new Date().toISOString(), expiresAt: this.expiry(), target: { poolManager, poolId, currency0, currency1, hooks }, metrics: { fee: String(log.args.fee), tickSpacing: String(log.args.tickSpacing), quote: 'requires-quoter-route', admission: gate.admission, admissionReasons: gate.reasons.join(',') }, executionIntent: { kind: 'uniswap-v4-unlock', contract: poolManager, metadata: { poolId, currency0, currency1, hooks, settleAllDeltas: true } }, candidate: { protocol: 'uniswap-v4', poolManager, poolId, currency0, currency1, hooks, fee: Number(log.args.fee), tickSpacing: Number(log.args.tickSpacing), admission: gate.admission, admissionReasons: gate.reasons, callbackRequired: true, broadcastEligible: false } });
      }
      } catch (error) { diagnostics.push(diagnostic('uniswap-v4', 'logs', error)); }
    }));
  }
}
