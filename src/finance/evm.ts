import { readFile, stat } from 'node:fs/promises';
import {
  createPublicClient, decodeFunctionData, encodeFunctionData, http, keccak256, parseAbi, parseTransaction, serializeTransaction,
  type Address, type Hex, type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { estimateEvmFees, receiptNativeCost } from '../evm-fees.js';
import {
  CHAIN_IDS, FinanceError, assetKey, canonicalDigest, compareQuantity, evmAddress, financeHash, insist, sha256Hex,
  type Account, type Amount, type Asset, type Constraints, type Cost, type EvidenceRef, type EvmNetwork, type EvmPayload, type EvmPosition, type Intent, type LocalPlan, type Observation, type Pin, type Plan,
} from './contracts.js';
import type { FinanceAdapter, AccountRead, Fresh, PositionRead, ReconcileResult, SimulationResult } from './adapter.js';

export type Erc20Asset = Extract<Asset, { kind: 'erc20' }>;
export interface AaveMarket { protocol: 'aave-v3'; network: EvmNetwork; pool: string; poolCodeHash: string; reserves: Array<{ asset: Erc20Asset; aToken: string; debtToken: string; reserveId: number }> }
export interface MorphoMarket { protocol: 'morpho-blue'; network: EvmNetwork; morpho: string; morphoCodeHash: string; marketId: Hex; params: { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: string }; loanAsset: Erc20Asset; collateralAsset: Erc20Asset }
export type EvmMarket = AaveMarket | MorphoMarket;
/** R3: a position-owning smart account admitted by bytecode pin; `owner` is the EOA allowed to call it. */
export interface ProtectionAccount { network: EvmNetwork; account: string; codeHash: string; owner: string; market: AaveMarket; flashLender: string; swapAdapter: string }

export const AAVE_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getUserConfiguration(address user) view returns (uint256)',
  'function getUserEMode(address user) view returns (uint256)',
]);
const MARKET = '(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)';
export const MORPHO_ABI = parseAbi([
  `function supply(${MARKET} marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)`,
  `function withdraw(${MARKET} marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)`,
  `function borrow(${MARKET} marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)`,
  `function repay(${MARKET} marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)`,
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
]);
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)']);
const ORACLE_ABI = parseAbi(['function price() view returns (uint256)']);
export const PROTECTION_ABI = parseAbi([
  'function protect((address debtAsset, uint256 flashAmount, address collateralAsset, uint256 withdrawAmount, uint256 minSwapOut, uint256 maxDebtAfter, uint256 minCollateralAfter, bytes32 nonce, uint256 deadline) p)',
  'function owner() view returns (address)',
]);
const MAX_UINT = (1n << 256n) - 1n;
const VIRTUAL_SHARES = 1_000_000n, VIRTUAL_ASSETS = 1n;

export const adapterRef = (market: EvmMarket | ProtectionAccount) => financeHash('adapter', market);
export const networkIdentityHash = (network: EvmNetwork) => canonicalDigest({ network, chainId: CHAIN_IDS[network] });
const atomic = (asset: Asset, value: bigint): Amount => ({ asset, quantity: { kind: 'atomic', value: value.toString() } });
const ratio = (numerator: bigint, scale: bigint): string => { const whole = numerator / scale, frac = (numerator % scale).toString().padStart(scale.toString().length - 1, '0').replace(/0+$/, ''); return frac ? `${whole}.${frac}` : `${whole}`; };
const evidence = (content: unknown, expiresAt: string | null): EvidenceRef => ({ id: canonicalDigest({ kind: 'evm-read', content }), contentHash: canonicalDigest(content), expiresAt });
/** Morpho share math, same rounding as SharesMathLib. */
export const toAssetsDown = (shares: bigint, totalAssets: bigint, totalShares: bigint) => (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
export const toAssetsUp = (shares: bigint, totalAssets: bigint, totalShares: bigint) => { const d = totalShares + VIRTUAL_SHARES; return (shares * (totalAssets + VIRTUAL_ASSETS) + d - 1n) / d; };

export interface EvmSigner { address: string; sign(payload: EvmPayload): Promise<Hex> }
/** Owner signer host: key file named by an env var, owner-only file mode, address must match the account. */
export async function loadEvmSigner(envName = 'FINANCE_EVM_SIGNER_KEY_FILE', env: NodeJS.ProcessEnv = process.env): Promise<EvmSigner> {
  const path = env[envName]; insist(path, 'PERMISSION_MISSING', 'signer-unavailable');
  const s = await stat(path); insist(s.isFile() && (s.mode & 0o077) === 0, 'PERMISSION_MISSING', 'signer-file-permissions');
  const key = (await readFile(path, 'utf8')).trim(); insist(/^0x[a-fA-F0-9]{64}$/.test(key), 'PERMISSION_MISSING', 'signer-invalid');
  return localEvmSigner(key as Hex);
}
export function localEvmSigner(key: Hex): EvmSigner {
  const account = privateKeyToAccount(key);
  return {
    address: account.address,
    sign: p => account.signTransaction({ type: 'eip1559', chainId: p.chainId, to: p.to as Address, data: p.data as Hex, value: BigInt(p.value), nonce: Number(p.nonce), gas: BigInt(p.gasLimit), maxFeePerGas: BigInt(p.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas) }),
  };
}

/**
 * Native EVM adapter for admitted Aave V3 / Morpho Blue markets and (R3) one admitted protection account.
 * Unknown markets, eMode positions or unpinned code are reported or blocked, never assumed equivalent.
 */
export class EvmFinanceAdapter implements FinanceAdapter {
  readonly client: PublicClient;
  constructor(readonly network: EvmNetwork, rpcUrl: string, readonly markets: EvmMarket[], readonly protection: ProtectionAccount[] = [], readonly finality: 'safe' | 'finalized' | 'latest' = 'finalized', readonly now: () => number = Date.now, client?: PublicClient) {
    this.client = client ?? createPublicClient({ transport: http(rpcUrl, { timeout: 5_000, retryCount: 1 }) });
  }

  capabilities() {
    const ops = ['positions', 'earn', 'withdraw', 'borrow', 'repay'] as const;
    return [...ops.map(operation => ({ operation, protocol: this.markets.map(m => m.protocol).join(',') || null, admitted: this.markets.length > 0 })), { operation: 'protect' as const, protocol: 'protection-account', admitted: this.protection.length > 0 }];
  }

  /** Pins one block and re-checks its hash after every read; a reorg or mixed state rejects the whole page. */
  private async pinned<T>(read: (blockNumber: bigint) => Promise<T>, maxAgeSeconds: number): Promise<{ value: T; observation: Observation }> {
    const chainId = await this.client.getChainId(); insist(chainId === CHAIN_IDS[this.network], 'WRONG_CHAIN', 'rpc-chain');
    const block = await this.client.getBlock({ blockTag: this.finality });
    const value = await read(block.number);
    const again = await this.client.getBlock({ blockNumber: block.number });
    insist(again.hash === block.hash, 'STALE_STATE', 'reorg-during-read');
    const observedAt = new Date(this.now()).toISOString(), expiresAt = new Date(this.now() + maxAgeSeconds * 1000).toISOString();
    return { value, observation: {
      network: this.network, networkIdentityHash: networkIdentityHash(this.network), observedAt, expiresAt, consistency: 'pinned', fidelity: 'chain-read',
      point: { kind: 'evm-block', number: block.number.toString(), hash: block.hash!, finality: this.finality === 'latest' ? 'included' : this.finality },
      sources: [evidence({ blockHash: block.hash, value: JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v)) }, expiresAt)],
    } };
  }
  async codePin(address: string, expected: string, blockNumber?: bigint): Promise<Pin> {
    const code = await this.client.getCode({ address: address as Address, blockNumber });
    insist(code && code !== '0x', 'CODE_DRIFT', 'no-code');
    const hash = sha256Hex(Buffer.from(code.slice(2), 'hex'));
    insist(hash === expected.toLowerCase(), 'CODE_DRIFT', address);
    return { kind: 'bytecode', id: evmAddress(address).toLowerCase(), hash };
  }

  async readAccount(account: Account, assets: Asset[], maxAgeSeconds = 30): Promise<AccountRead> {
    insist(account.family === 'evm' && account.chainId === CHAIN_IDS[this.network], 'WRONG_CHAIN');
    const { value, observation } = await this.pinned(async blockNumber => Promise.all(assets.map(async a => {
      if (a.kind === 'evm-native') return atomic(a, await this.client.getBalance({ address: account.address as Address, blockNumber }));
      insist(a.kind === 'erc20' && a.network === this.network, 'WRONG_CHAIN', 'asset');
      return atomic(a, await this.client.readContract({ address: a.address as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address as Address], blockNumber }));
    })), maxAgeSeconds);
    return { balances: value, observation };
  }

  async readPositions(account: Account, maxAgeSeconds = 30): Promise<PositionRead> {
    insist(account.family === 'evm' && account.chainId === CHAIN_IDS[this.network], 'WRONG_CHAIN');
    const user = account.address as Address;
    const missing: Array<{ capability: string; reasonCode: string }> = [];
    const { value, observation } = await this.pinned(async blockNumber => {
      const out = [];
      for (const m of this.markets) {
        try { out.push(m.protocol === 'aave-v3' ? await this.readAave(m, user, blockNumber) : await this.readMorpho(m, user, blockNumber)); }
        catch (e) { missing.push({ capability: `${m.protocol}:${m.protocol === 'aave-v3' ? m.pool : m.marketId}`, reasonCode: e instanceof FinanceError ? e.code : 'COVERAGE_INCOMPLETE' }); }
      }
      return out;
    }, maxAgeSeconds);
    const positions = value.map(p => ({ ...p, account, observation, positionId: canonicalDigest({ account: account.address.toLowerCase(), network: this.network, deploymentRef: p.deploymentRef, marketId: p.marketId }) }));
    return { positions, observation, coverage: { complete: missing.length === 0 && this.markets.length > 0, missing: this.markets.length ? missing : [{ capability: 'lending', reasonCode: 'CAPABILITY_UNAVAILABLE' }], cursor: null } };
  }

  private async readAave(m: AaveMarket, user: Address, blockNumber: bigint) {
    await this.codePin(m.pool, m.poolCodeHash, blockNumber);
    const pool = { address: m.pool as Address, abi: AAVE_ABI, blockNumber } as const;
    const [data, config, emode] = await Promise.all([
      this.client.readContract({ ...pool, functionName: 'getUserAccountData', args: [user] }),
      this.client.readContract({ ...pool, functionName: 'getUserConfiguration', args: [user] }),
      this.client.readContract({ ...pool, functionName: 'getUserEMode', args: [user] }),
    ]);
    insist(emode === 0n, 'UNSUPPORTED_ACCOUNT_MODEL', 'aave-emode');
    const supplied: Amount[] = [], collateral: Amount[] = [], debt: Amount[] = [];
    for (const r of m.reserves) {
      const [a, d] = await Promise.all([
        this.client.readContract({ address: r.aToken as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [user], blockNumber }),
        this.client.readContract({ address: r.debtToken as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [user], blockNumber }),
      ]);
      const usedAsCollateral = ((config >> BigInt(r.reserveId * 2 + 1)) & 1n) === 1n;
      if (a > 0n) (usedAsCollateral ? collateral : supplied).push(atomic(r.asset, a));
      if (d > 0n) debt.push(atomic(r.asset, d));
    }
    const [, totalDebtBase, , liquidationThreshold, ltv, healthFactor] = data;
    const noDebt = totalDebtBase === 0n;
    return {
      kind: 'evm-collateralized' as const, protocol: 'aave-v3' as const, deploymentRef: adapterRef(m), marketId: m.pool.toLowerCase(), supplied, shareEvidence: [], collateral, debt, noDebt,
      healthFactor: noDebt || healthFactor === MAX_UINT ? null : ratio(healthFactor, 10n ** 18n), ltv: ratio(ltv, 10_000n), liquidationThreshold: ratio(liquidationThreshold, 10_000n),
    };
  }

  private async readMorpho(m: MorphoMarket, user: Address, blockNumber: bigint) {
    await this.codePin(m.morpho, m.morphoCodeHash, blockNumber);
    const base = { address: m.morpho as Address, abi: MORPHO_ABI, blockNumber } as const;
    const [pos, mk, price] = await Promise.all([
      this.client.readContract({ ...base, functionName: 'position', args: [m.marketId, user] }),
      this.client.readContract({ ...base, functionName: 'market', args: [m.marketId] }),
      this.client.readContract({ address: m.params.oracle as Address, abi: ORACLE_ABI, functionName: 'price', blockNumber }),
    ]);
    const [supplyShares, borrowShares, collateralAssets] = pos, [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares] = mk;
    const supplyAssets = toAssetsDown(supplyShares, totalSupplyAssets, totalSupplyShares), borrowAssets = toAssetsUp(BigInt(borrowShares), totalBorrowAssets, totalBorrowShares);
    const shareModelRef = canonicalDigest({ model: 'morpho-shares-math', totalSupplyAssets: totalSupplyAssets.toString(), totalSupplyShares: totalSupplyShares.toString(), totalBorrowAssets: totalBorrowAssets.toString(), totalBorrowShares: totalBorrowShares.toString() });
    const maxBorrow = (BigInt(collateralAssets) * price / 10n ** 36n) * BigInt(m.params.lltv) / 10n ** 18n;
    return {
      kind: 'evm-collateralized' as const, protocol: 'morpho-blue' as const, deploymentRef: adapterRef(m), marketId: m.marketId.toLowerCase(),
      supplied: supplyAssets > 0n ? [atomic(m.loanAsset, supplyAssets)] : [], collateral: collateralAssets > 0n ? [atomic(m.collateralAsset, BigInt(collateralAssets))] : [], debt: borrowAssets > 0n ? [atomic(m.loanAsset, borrowAssets)] : [],
      shareEvidence: [
        ...(supplyShares > 0n ? [{ role: 'supply' as const, asset: m.loanAsset, raw: supplyShares.toString(), shareModelRef }] : []),
        ...(borrowShares > 0n ? [{ role: 'borrow' as const, asset: m.loanAsset, raw: borrowShares.toString(), shareModelRef }] : []),
      ],
      noDebt: borrowAssets === 0n, healthFactor: borrowAssets === 0n ? null : ratio(maxBorrow * 10n ** 18n / borrowAssets, 10n ** 18n), ltv: null, liquidationThreshold: ratio(BigInt(m.params.lltv), 10n ** 18n),
    };
  }

  /** Deterministic action compiler. No model text reaches calldata. */
  compileAction(account: Account, intent: Intent, market: EvmMarket, asset: Erc20Asset, amount: bigint): { to: string; data: Hex; permissions: Array<{ kind: 'erc20-allowance'; target: string; asset: Asset; maximum: { kind: 'atomic'; value: string } }> } {
    insist(account.family === 'evm' && account.model === 'eoa', 'UNSUPPORTED_ACCOUNT_MODEL');
    insist(amount > 0n && amount < MAX_UINT, 'INVALID_INPUT', 'amount');
    const me = account.address as Address, token = asset.address as Address;
    const allowance = (spender: string) => (intent === 'earn' || intent === 'repay') ? [{ kind: 'erc20-allowance' as const, target: spender.toLowerCase(), asset, maximum: { kind: 'atomic' as const, value: amount.toString() } }] : [];
    if (market.protocol === 'aave-v3') {
      insist(market.reserves.some(r => assetKey(r.asset) === assetKey(asset)), 'CAPABILITY_UNAVAILABLE', 'reserve');
      const data = intent === 'earn' ? encodeFunctionData({ abi: AAVE_ABI, functionName: 'supply', args: [token, amount, me, 0] })
        : intent === 'withdraw' ? encodeFunctionData({ abi: AAVE_ABI, functionName: 'withdraw', args: [token, amount, me] })
        : intent === 'borrow' ? encodeFunctionData({ abi: AAVE_ABI, functionName: 'borrow', args: [token, amount, 2n, 0, me] })
        : intent === 'repay' ? encodeFunctionData({ abi: AAVE_ABI, functionName: 'repay', args: [token, amount, 2n, me] })
        : (() => { throw new FinanceError('CAPABILITY_UNAVAILABLE', intent); })();
      return { to: market.pool, data, permissions: allowance(market.pool) };
    }
    insist(assetKey(market.loanAsset) === assetKey(asset), 'CAPABILITY_UNAVAILABLE', 'morpho-loan-asset-only');
    const p = morphoParams(market);
    const data = intent === 'earn' ? encodeFunctionData({ abi: MORPHO_ABI, functionName: 'supply', args: [p, amount, 0n, me, '0x'] })
      : intent === 'withdraw' ? encodeFunctionData({ abi: MORPHO_ABI, functionName: 'withdraw', args: [p, amount, 0n, me, me] })
      : intent === 'borrow' ? encodeFunctionData({ abi: MORPHO_ABI, functionName: 'borrow', args: [p, amount, 0n, me, me] })
      : intent === 'repay' ? encodeFunctionData({ abi: MORPHO_ABI, functionName: 'repay', args: [p, amount, 0n, me, '0x'] })
      : (() => { throw new FinanceError('CAPABILITY_UNAVAILABLE', intent); })();
    return { to: market.morpho, data, permissions: allowance(market.morpho) };
  }
  /** R3 recipe call: the owner EOA calls its own protection account; bounds are enforced on-chain and re-checked locally. */
  compileProtect(prot: ProtectionAccount, p: { flashAmount: bigint; withdrawAmount: bigint; minSwapOut: bigint; maxDebtAfter: bigint; minCollateralAfter: bigint; nonce: Hex; deadline: bigint }): { from: string; to: string; data: Hex } {
    insist(this.protection.includes(prot), 'CAPABILITY_UNAVAILABLE', 'protection-account');
    const debt = prot.market.reserves[0], coll = prot.market.reserves[1]; insist(debt && coll, 'CAPABILITY_UNAVAILABLE', 'protection-reserves');
    insist(p.flashAmount > 0n && p.minSwapOut >= 0n, 'INVALID_INPUT', 'protect-amount');
    return { from: prot.owner, to: prot.account, data: encodeFunctionData({ abi: PROTECTION_ABI, functionName: 'protect', args: [{ debtAsset: debt.asset.address as Address, collateralAsset: coll.asset.address as Address, ...p }] }) };
  }
  compileApproval(token: Erc20Asset, spender: string, amount: bigint): { to: string; data: Hex } {
    return { to: token.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender as Address, amount] }) };
  }

  /**
   * Decodes a native payload against approved selectors and exact arguments: target is an admitted
   * market (or the exact-amount approval for it), beneficiary is the account itself.
   */
  decodeAction(payload: EvmPayload, account: Account): { intent: Intent | 'approve'; asset: Erc20Asset; amount: bigint; market: EvmMarket | ProtectionAccount } {
    insist(account.family === 'evm' && payload.chainId === CHAIN_IDS[this.network], 'WRONG_CHAIN');
    insist(BigInt(payload.value) === 0n, 'POLICY_REJECTED', 'native-value');
    const to = payload.to.toLowerCase(), me = account.address.toLowerCase(), data = payload.data as Hex;
    const prot = this.protection.find(p => p.account.toLowerCase() === to);
    if (prot) {
      insist(account.model === 'smart-account' && me === prot.account.toLowerCase() && payload.from.toLowerCase() === prot.owner.toLowerCase(), 'UNSUPPORTED_ACCOUNT_MODEL', 'protection-owner');
      const { functionName, args } = decodeFunctionData({ abi: PROTECTION_ABI, data }); insist(functionName === 'protect', 'POLICY_REJECTED', 'selector');
      const p = (args as unknown as [{ debtAsset: Address; flashAmount: bigint }])[0];
      const reserve = prot.market.reserves.find(r => r.asset.address.toLowerCase() === p.debtAsset.toLowerCase()); insist(reserve, 'CAPABILITY_UNAVAILABLE', 'protect-asset');
      return { intent: 'protect', asset: reserve.asset, amount: p.flashAmount, market: prot };
    }
    insist(account.model === 'eoa' && payload.from.toLowerCase() === me, 'OWNER_SCOPE_MISMATCH', 'payload-from');
    for (const m of this.markets) {
      const target = (m.protocol === 'aave-v3' ? m.pool : m.morpho).toLowerCase();
      const assets = m.protocol === 'aave-v3' ? m.reserves.map(r => r.asset) : [m.loanAsset];
      const asToken = assets.find(a => a.address.toLowerCase() === to);
      if (asToken) {
        const { functionName, args } = decodeFunctionData({ abi: ERC20_ABI, data }); insist(functionName === 'approve', 'POLICY_REJECTED', 'selector');
        const [spender, amount] = args as [Address, bigint];
        insist(spender.toLowerCase() === target && amount > 0n && amount < MAX_UINT, 'POLICY_REJECTED', 'unbounded-or-foreign-approval');
        return { intent: 'approve', asset: asToken, amount, market: m };
      }
      if (to !== target) continue;
      if (m.protocol === 'aave-v3') {
        const { functionName, args } = decodeFunctionData({ abi: AAVE_ABI, data });
        const a = args as readonly unknown[];
        const asset = m.reserves.find(r => r.asset.address.toLowerCase() === (a[0] as string).toLowerCase())?.asset; insist(asset, 'CAPABILITY_UNAVAILABLE', 'reserve');
        const amount = a[1] as bigint; insist(amount > 0n && amount < MAX_UINT, 'POLICY_REJECTED', 'amount');
        const beneficiary = (functionName === 'supply' ? a[2] : functionName === 'withdraw' ? a[2] : functionName === 'borrow' ? a[4] : functionName === 'repay' ? a[3] : undefined) as string | undefined;
        insist(beneficiary?.toLowerCase() === me, 'OWNER_SCOPE_MISMATCH', 'beneficiary');
        if (functionName === 'borrow' || functionName === 'repay') insist(a[2] === 2n, 'UNSUPPORTED_ACCOUNT_MODEL', 'variable-debt-only');
        if (functionName === 'supply' || functionName === 'borrow') insist(a[functionName === 'supply' ? 3 : 3] === 0, 'POLICY_REJECTED', 'referral');
        const intent = ({ supply: 'earn', withdraw: 'withdraw', borrow: 'borrow', repay: 'repay' } as const)[functionName as 'supply']; insist(intent, 'POLICY_REJECTED', 'selector');
        return { intent, asset, amount, market: m };
      }
      const { functionName, args } = decodeFunctionData({ abi: MORPHO_ABI, data });
      const a = args as readonly unknown[];
      insist(canonicalDigest(lowerParams(a[0] as Record<string, unknown>)) === canonicalDigest(lowerParams(morphoParams(m))), 'POLICY_REJECTED', 'market-params');
      insist(a[2] === 0n && (a[1] as bigint) > 0n, 'POLICY_REJECTED', 'assets-mode-only');
      insist((a[3] as string).toLowerCase() === me && (typeof a[4] !== 'string' || a[4] === '0x' || (a[4] as string).toLowerCase() === me), 'OWNER_SCOPE_MISMATCH', 'beneficiary');
      const intent = ({ supply: 'earn', withdraw: 'withdraw', borrow: 'borrow', repay: 'repay' } as const)[functionName as 'supply']; insist(intent, 'POLICY_REJECTED', 'selector');
      return { intent, asset: m.loanAsset, amount: a[1] as bigint, market: m };
    }
    throw new FinanceError('POLICY_REJECTED', 'unadmitted-target');
  }

  async admitPayload(plan: Plan): Promise<Pin[]> {
    insist(plan.nativePayload.kind === 'evm' && plan.network === this.network, 'WRONG_CHAIN');
    const d = this.decodeAction(plan.nativePayload, plan.account);
    insist(d.intent === plan.intent || (d.intent === 'approve' && (plan.intent === 'earn' || plan.intent === 'repay')), 'POLICY_REJECTED', 'intent-mismatch');
    insist(plan.adapterRef === adapterRef(d.market), 'CODE_DRIFT', 'adapter-ref');
    const pins: Pin[] = [{ kind: 'network', id: this.network, hash: networkIdentityHash(this.network) }, { kind: 'protocol-market', id: 'market', hash: adapterRef(d.market) }];
    if ('owner' in d.market) {
      const prot = d.market;
      pins.push(await this.codePin(prot.account, prot.codeHash));
      const owner = await this.client.readContract({ address: prot.account as Address, abi: PROTECTION_ABI, functionName: 'owner' });
      insist(owner.toLowerCase() === prot.owner.toLowerCase(), 'UNSUPPORTED_ACCOUNT_MODEL', 'protection-owner');
      pins.push({ kind: 'owner-model', id: prot.account.toLowerCase(), hash: canonicalDigest({ owner: owner.toLowerCase(), model: 'smart-account' }) });
    } else {
      const m = d.market; pins.push(await this.codePin(m.protocol === 'aave-v3' ? m.pool : m.morpho, m.protocol === 'aave-v3' ? m.poolCodeHash : m.morphoCodeHash));
      pins.push({ kind: 'owner-model', id: plan.account.address.toLowerCase(), hash: canonicalDigest({ model: 'eoa' }) });
    }
    return pins;
  }

  /** Fresh fee/nonce near signing; every value is hash-bound into the LocalPlan. */
  async freshPayload(input: LocalPlan['nativePayload']): Promise<Fresh> {
    insist(input.kind === 'evm', 'WRONG_CHAIN'); const payload = input;
    const from = payload.from as Address;
    const { value: nonce, observation } = await this.pinned(blockNumber => this.client.getTransactionCount({ address: from, blockNumber }), 30);
    const pending = await this.client.getTransactionCount({ address: from, blockTag: 'pending' });
    insist(pending === nonce, 'SUBMISSION_UNKNOWN', 'pending-transaction-for-account');
    const fee = await estimateEvmFees(this.client, CHAIN_IDS[this.network], from, payload.to as Address, payload.data as Hex);
    const gasLimit = fee.gas + fee.gas / 5n;
    const next: EvmPayload = { ...payload, nonce: nonce.toString(), gasLimit: gasLimit.toString(), maxFeePerGas: fee.fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fee.fees.maxPriorityFeePerGas.toString() };
    const maximum = gasLimit * fee.fees.maxFeePerGas + fee.publicationFee;
    const cost: Cost = { kind: 'execution-gas', payer: 'user', maximum: atomic({ kind: 'evm-native', network: this.network, decimals: 18 }, maximum), sourceRef: evidence({ gasLimit: gasLimit.toString(), maxFeePerGas: next.maxFeePerGas, publicationFee: fee.publicationFee.toString() }, observation.expiresAt) };
    return { payload: next, cost, observation };
  }

  /**
   * Exact simulation: eth_call with the real caller, calldata and value at a pinned block, no state or
   * balance overrides. Postconditions compare the predicted position with the bounds.
   */
  async simulateExact(plan: LocalPlan): Promise<SimulationResult> {
    insist(plan.nativePayload.kind === 'evm', 'WRONG_CHAIN');
    const p = plan.nativePayload, decoded = this.decodeAction(p, plan.account);
    const { value: before, observation } = await this.pinned(async blockNumber => {
      await this.client.call({ account: p.from as Address, to: p.to as Address, data: p.data as Hex, value: BigInt(p.value), blockNumber, gas: BigInt(p.gasLimit) })
        .catch(() => { throw new FinanceError('SIMULATION_FAILED', 'revert'); });
      return true;
    }, plan.effectiveConstraints.maxStateAgeSeconds);
    insist(before, 'SIMULATION_FAILED');
    const spend = decoded.intent === 'earn' || decoded.intent === 'repay' ? [atomic(decoded.asset, decoded.amount)] : [];
    const receive = decoded.intent === 'withdraw' || decoded.intent === 'borrow' ? [atomic(decoded.asset, decoded.amount)] : [];
    const errors: string[] = [];
    if (decoded.intent !== 'approve' && decoded.intent !== 'protect') {
      const current = (await this.readPositions(plan.account, plan.effectiveConstraints.maxStateAgeSeconds)).positions.find((x): x is EvmPosition => x.kind === 'evm-collateralized' && x.deploymentRef === plan.adapterRef);
      if (!current) errors.push('position-unavailable');
      else {
        const debtBefore = sumAsset(current.debt, decoded.asset);
        const debtAfter = decoded.intent === 'repay' ? (debtBefore > decoded.amount ? debtBefore - decoded.amount : 0n) : decoded.intent === 'borrow' ? debtBefore + decoded.amount : debtBefore;
        errors.push(...checkPost(plan.effectiveConstraints, decoded.asset, { debtAfter }));
        if (decoded.intent === 'repay' && decoded.amount > debtBefore) errors.push('repay-exceeds-debt');
      }
    }
    return { fidelity: 'native', pass: true, postconditionsPass: errors.length === 0, expectedSpend: spend, expectedReceive: receive, errors, observation };
  }

  validateSignedArtifact(plan: LocalPlan, signed: string): { transactionId: string } {
    insist(plan.nativePayload.kind === 'evm', 'WRONG_CHAIN');
    const p = plan.nativePayload, tx = parseTransaction(signed as Hex);
    insist(tx.type === 'eip1559' && tx.chainId === p.chainId && tx.to?.toLowerCase() === p.to.toLowerCase() && tx.data === p.data && (tx.value ?? 0n) === BigInt(p.value)
      && BigInt(tx.nonce ?? -1) === BigInt(p.nonce) && tx.gas === BigInt(p.gasLimit) && tx.maxFeePerGas === BigInt(p.maxFeePerGas) && tx.maxPriorityFeePerGas === BigInt(p.maxPriorityFeePerGas), 'SIMULATION_FAILED', 'signed-artifact-mismatch');
    insist(serializeTransaction({ ...tx, r: tx.r, s: tx.s, yParity: tx.yParity } as never) === signed, 'SIMULATION_FAILED', 'non-canonical-signed-artifact');
    return { transactionId: keccak256(signed as Hex) };
  }
  async submitKnownArtifact(signed: string): Promise<string> { return this.client.request({ method: 'eth_sendRawTransaction', params: [signed as Hex] }); }

  /** Receipt status and economic reconciliation are separate; unexplained differences halt. */
  async reconcileKnownReference(plan: LocalPlan, transactionId: string): Promise<ReconcileResult> {
    const receipt = await this.client.getTransactionReceipt({ hash: transactionId as Hex }).catch(() => null);
    if (!receipt) return { state: 'UNKNOWN', reconciliation: 'UNKNOWN', effects: [], evidence: [] };
    insist(plan.nativePayload.kind === 'evm' && receipt.from.toLowerCase() === plan.nativePayload.from.toLowerCase() && receipt.to?.toLowerCase() === plan.nativePayload.to.toLowerCase(), 'RECONCILIATION_MISMATCH', 'receipt-identity');
    const raw = await this.client.request({ method: 'eth_getTransactionReceipt', params: [transactionId as Hex] });
    const fee = atomic({ kind: 'evm-native', network: this.network, decimals: 18 }, receiptNativeCost(CHAIN_IDS[this.network], receipt, raw));
    const ev = [evidence({ transactionId, blockHash: receipt.blockHash, status: receipt.status }, null)];
    if (receipt.status !== 'success') return { state: 'FAILED', reconciliation: 'MATCH', effects: [fee], evidence: ev };
    const head = await this.client.getBlock({ blockTag: this.finality });
    const state = head.number >= receipt.blockNumber ? (this.finality === 'finalized' ? 'FINALIZED' : 'CONFIRMED') : 'INCLUDED';
    const maxCost = plan.costs.find(c => c.kind === 'execution-gas');
    let reconciliation: ReconcileResult['reconciliation'] = 'MATCH';
    if (maxCost && compareQuantity(fee.quantity, maxCost.maximum.quantity) > 0) reconciliation = 'MISMATCH';
    const decoded = this.decodeAction(plan.nativePayload, plan.account);
    if (decoded.intent !== 'approve' && decoded.intent !== 'protect' && state !== 'INCLUDED') {
      const after = (await this.readPositions(plan.account, 30)).positions.find((x): x is EvmPosition => x.kind === 'evm-collateralized' && x.deploymentRef === plan.adapterRef);
      if (!after) reconciliation = 'UNKNOWN';
      else if (checkPost(plan.effectiveConstraints, decoded.asset, { debtAfter: sumAsset(after.debt, decoded.asset) }).length) reconciliation = 'MISMATCH';
    }
    return { state, reconciliation, effects: [fee], evidence: ev };
  }
}

function sumAsset(list: Amount[], asset: Asset): bigint { return list.filter(a => assetKey(a.asset) === assetKey(asset) && a.quantity.kind === 'atomic').reduce((n, a) => n + BigInt((a.quantity as { value: string }).value), 0n); }
function checkPost(c: Constraints, asset: Asset, after: { debtAfter: bigint }): string[] {
  const bound = c.maxDebtAfter.find(b => assetKey(b.asset) === assetKey(asset));
  return bound && bound.quantity.kind === 'atomic' && after.debtAfter > BigInt(bound.quantity.value) ? ['max-debt-after'] : [];
}
const morphoParams = (m: MorphoMarket) => ({ loanToken: m.params.loanToken as Address, collateralToken: m.params.collateralToken as Address, oracle: m.params.oracle as Address, irm: m.params.irm as Address, lltv: BigInt(m.params.lltv) });
const lowerParams = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'string' ? v.toLowerCase() : String(v)]));
