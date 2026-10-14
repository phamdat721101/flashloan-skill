import { isValidSuiAddress, normalizeStructTag } from '@mysten/sui/utils';
import { assertTickWindowCoverage, deriveV4PoolId, type V3Snapshot, type V4PoolKey } from '../state-adapters.js';
import { quoteV3ExactInput, quoteV4ExactInput, sqrtRatioAtTick } from './clmm.js';
import { cetusSqrtPriceAtTick, quoteCetusExactInput, validateCetus, type CetusMathState } from './cetus-math.js';
import { digest, isSuiDigest, parseStateIdentity, uint, type StateIdentity } from './state.js';
import { ceilDiv, priceWithDecimals, projectV2, rational, validateV2, type Rational, type V2State } from './v2.js';

export interface V3MathState {
  protocol: 'uniswap-v3'; sqrtPriceX96: string; tick: number; liquidity: string; feePips: number;
  tickSpacing: number; unlocked: boolean; bitmapWords: V3Snapshot['bitmapWords']; initializedTicks: V3Snapshot['initializedTicks'];
  lowerTick: number; upperTick: number;
}
export type PoolMathState =
  | ({ protocol: 'uniswap-v2' } & V2State)
  | V3MathState
  | (Omit<V3MathState, 'protocol' | 'feePips' | 'unlocked'> & { protocol: 'uniswap-v4'; key: V4PoolKey; poolId: string; protocolFeePips: number; lpFeePips: number })
  | ({ protocol: 'cetus' } & CetusMathState);
export interface PoolStateEnvelope {
  schemaVersion: '4.0'; identity: StateIdentity; poolId: string; poolAddress: string; adapterRevision: string; revisionHash: string;
  token0: string; token1: string; decimals0: number; decimals1: number;
  stateClass: 'canonical' | 'projected'; appliedOperations: string[]; state: PoolMathState;
}
export interface ProjectionRequest {
  schemaVersion: '4.0'; snapshotDigest: string; operationId: string;
  operationClass: 'hypothetical' | 'ordered-replay'; tokenIn: string; amountIn: string; maxSteps?: number;
}
export interface ProjectionResult {
  schemaVersion: '4.0'; status: 'complete'; snapshotDigest: string; operationDigest: string;
  tokenIn: string; tokenOut: string; amountIn: string; consumedInput: string; unspentInput: string;
  amountOut: string; feeAmount: string; feeSemantics: 'input-retained-ceiling' | 'swap-step';
  priceBefore: Rational; priceAfter: Rational; crossedTicks: number[]; steps: number;
  projectedState: PoolStateEnvelope; projectedStateDigest: string;
}
export interface LiquidityDescription {
  schemaVersion: '4.0'; snapshotDigest: string; poolId: string; protocol: PoolMathState['protocol']; spotPrice: Rational;
  actualReserves: { reserve0: string; reserve1: string } | null;
  virtualReserves: { token0: Rational; token1: Rational } | null;
  coveredRange: { lowerTick: number; upperTick: number; lowerPrice: Rational; upperPrice: Rational } | null;
  activeInterval: { lowerTick: number; upperTick: number; token0InputFeeExclusive: string; token1InputFeeExclusive: string } | null;
  initializedTickCount: number;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ANALYTICS_OBJECT');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('INVALID_ANALYTICS_FIELDS');
}
const evmAddress = (value: unknown) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
function boundedText(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
export function parsePoolState(input: unknown): PoolStateEnvelope {
  const value = record(input);
  fields(value, ['schemaVersion','identity','poolId','poolAddress','adapterRevision','revisionHash','token0','token1','decimals0','decimals1','stateClass','appliedOperations','state']);
  if (value.schemaVersion !== '4.0') throw new Error('UNSUPPORTED_ANALYTICS_VERSION');
  const identity = parseStateIdentity(value.identity);
  if (!boundedText(value.poolId, 256) || !value.poolId.startsWith(`${identity.chain}:${identity.network}:`) || !boundedText(value.adapterRevision, 128) || !['canonical','projected'].includes(String(value.stateClass))) throw new Error('INVALID_POOL_BINDING');
  if (![value.decimals0, value.decimals1].every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('INVALID_DECIMALS');
  if (!Array.isArray(value.appliedOperations) || value.appliedOperations.length > 1000 || value.appliedOperations.some(v => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) || new Set(value.appliedOperations).size !== value.appliedOperations.length) throw new Error('INVALID_OPERATION_HISTORY');
  if (identity.chain === 'arbitrum') {
    if (![value.poolAddress,value.token0,value.token1].every(evmAddress) || typeof value.revisionHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(value.revisionHash)) throw new Error('INVALID_POOL_BINDING');
    if (String(value.token0).toLowerCase() === String(value.token1).toLowerCase()) throw new Error('INVALID_POOL_ASSETS');
  } else {
    if (typeof value.poolAddress !== 'string' || !isValidSuiAddress(value.poolAddress) || !isSuiDigest(value.revisionHash)) throw new Error('INVALID_POOL_BINDING');
    for (const token of [value.token0,value.token1]) if (!boundedText(token, 1024) || normalizeStructTag(token) !== token) throw new Error('INVALID_POOL_ASSETS');
    if (value.token0 === value.token1) throw new Error('INVALID_POOL_ASSETS');
  }
  const state = record(value.state);
  const clmmFields = ['protocol','sqrtPriceX96','tick','liquidity','tickSpacing','bitmapWords','initializedTicks','lowerTick','upperTick'];
  if (state.protocol === 'uniswap-v2') {
    fields(state, ['protocol','reserve0','reserve1','feeNumerator','feeDenominator']);
    if (identity.chain !== 'arbitrum') throw new Error('PROTOCOL_CHAIN_MISMATCH');
    validateV2(state as unknown as V2State);
  } else if (state.protocol === 'uniswap-v3' || state.protocol === 'uniswap-v4') {
    fields(state, [...clmmFields, ...(state.protocol === 'uniswap-v3' ? ['feePips','unlocked'] : ['key','poolId','protocolFeePips','lpFeePips'])]);
    if (identity.chain !== 'arbitrum') throw new Error('PROTOCOL_CHAIN_MISMATCH');
    const price = uint(state.sqrtPriceX96, 160); uint(state.liquidity, 128);
    if (!Number.isInteger(state.tick) || !Number.isInteger(state.tickSpacing) || !Array.isArray(state.bitmapWords) || state.bitmapWords.length > 256 || !Array.isArray(state.initializedTicks) || state.initializedTicks.length > 10000) throw new Error('CLMM_INVALID_STATE');
    for (const entry of state.bitmapWords) {
      const word = record(entry); fields(word, ['wordPosition','bitmap']);
      if (!Number.isInteger(word.wordPosition) || (word.wordPosition as number) < -32768 || (word.wordPosition as number) > 32767) throw new Error('CLMM_INVALID_STATE');
      uint(word.bitmap);
    }
    if ((state.tick as number) < -887272 || (state.tick as number) >= 887272 || price < sqrtRatioAtTick(state.tick as number) || price > sqrtRatioAtTick((state.tick as number) + 1)) throw new Error('CLMM_INVALID_STATE');
    for (const entry of state.initializedTicks) {
      const tick = record(entry); fields(tick, ['tick','liquidityGross','liquidityNet']);
      const gross = uint(tick.liquidityGross,128);
      if (!Number.isInteger(tick.tick) || (tick.tick as number) < -887272 || (tick.tick as number) > 887272 || !gross || typeof tick.liquidityNet !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(tick.liquidityNet) || tick.liquidityNet.length > 40) throw new Error('CLMM_INVALID_STATE');
      const net = BigInt(tick.liquidityNet);
      if (net < -(1n << 127n) || net >= 1n << 127n || (net < 0n ? -net : net) > gross) throw new Error('CLMM_INVALID_STATE');
    }
    assertTickWindowCoverage(state as unknown as V3MathState, state.lowerTick as number, state.upperTick as number);
    if (state.protocol === 'uniswap-v3') {
      if (typeof state.unlocked !== 'boolean' || !Number.isInteger(state.feePips) || (state.feePips as number) < 0 || (state.feePips as number) >= 1000000) throw new Error('CLMM_INVALID_STATE');
    } else {
      const key = record(state.key); fields(key, ['currency0','currency1','fee','tickSpacing','hooks']);
      if (![key.currency0,key.currency1,key.hooks].every(evmAddress) || key.currency0 !== value.token0 || key.currency1 !== value.token1 || key.tickSpacing !== state.tickSpacing || !Number.isInteger(key.fee) || (key.fee as number) < 0 || (key.fee as number) > 0xffffff || typeof state.poolId !== 'string' || deriveV4PoolId(key as unknown as V4PoolKey).toLowerCase() !== state.poolId.toLowerCase() || !Number.isInteger(state.protocolFeePips) || !Number.isInteger(state.lpFeePips)) throw new Error('CLMM_INVALID_STATE');
    }
  } else if (state.protocol === 'cetus') {
    fields(state, ['protocol','sqrtPriceX64','tick','liquidity','feePips','tickSpacing','lowerTick','upperTick','complete','initializedTicks']);
    if (identity.chain !== 'sui') throw new Error('PROTOCOL_CHAIN_MISMATCH');
    if (!Array.isArray(state.initializedTicks)) throw new Error('CETUS_INVALID_TICK_TABLE');
    for (const entry of state.initializedTicks) { const tick = record(entry); fields(tick, ['tick','liquidityGross','liquidityNet']); }
    validateCetus(state as unknown as CetusMathState);
  } else throw new Error('UNSUPPORTED_MATH_ADAPTER');
  return structuredClone(value) as unknown as PoolStateEnvelope;
}
export function parseProjectionRequest(input: unknown): ProjectionRequest {
  const value = record(input);
  fields(value, ['schemaVersion','snapshotDigest','operationId','operationClass','tokenIn','amountIn'], ['maxSteps']);
  if (value.schemaVersion !== '4.0' || typeof value.snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshotDigest) || !boundedText(value.operationId, 256) || !['hypothetical','ordered-replay'].includes(String(value.operationClass)) || !boundedText(value.tokenIn, 1024) || uint(value.amountIn) === 0n || (value.maxSteps !== undefined && (!Number.isInteger(value.maxSteps) || (value.maxSteps as number) < 1 || (value.maxSteps as number) > 4096))) throw new Error('INVALID_PROJECTION_REQUEST');
  return structuredClone(value) as unknown as ProjectionRequest;
}
export function poolPrice(pool: PoolStateEnvelope): Rational {
  const state = pool.state;
  if (state.protocol === 'uniswap-v2') return priceWithDecimals(uint(state.reserve1), uint(state.reserve0), pool.decimals0, pool.decimals1);
  const price = uint(state.protocol === 'cetus' ? state.sqrtPriceX64 : state.sqrtPriceX96);
  return priceWithDecimals(price * price, 1n << (state.protocol === 'cetus' ? 128n : 192n), pool.decimals0, pool.decimals1);
}
/** Raw native position amounts, excluding accrued fees. This requires the position's own L and bounds. */
export function positionInventory(liquidity: string, sqrtPrice: string, lowerSqrtPrice: string, upperSqrtPrice: string, fractionalBits: 64 | 96): { token0: string; token1: string } {
  if (![64,96].includes(fractionalBits)) throw new Error('INVALID_PRICE_SCALE');
  const priceBits = fractionalBits === 96 ? 160 : 128;
  const l = uint(liquidity,128), p = uint(sqrtPrice,priceBits), lower = uint(lowerSqrtPrice,priceBits), upper = uint(upperSqrtPrice,priceBits), q = 1n << BigInt(fractionalBits);
  if (!lower || lower >= upper || !p) throw new Error('INVALID_POSITION_RANGE');
  const effective = p < lower ? lower : p > upper ? upper : p;
  return { token0: (l * q * (upper - effective) / (effective * upper)).toString(),token1: (l * (effective - lower) / q).toString() };
}
export function describeLiquidity(input: unknown): LiquidityDescription {
  const pool = parsePoolState(input), state = pool.state;
  const common = { schemaVersion: '4.0' as const,snapshotDigest: digest(pool),poolId: pool.poolId,protocol: state.protocol,spotPrice: poolPrice(pool) };
  if (state.protocol === 'uniswap-v2') return { ...common,actualReserves: { reserve0: state.reserve0,reserve1: state.reserve1 },virtualReserves: null,coveredRange: null,activeInterval: null,initializedTickCount: 0 };
  const q = 1n << (state.protocol === 'cetus' ? 64n : 96n), p = uint(state.protocol === 'cetus' ? state.sqrtPriceX64 : state.sqrtPriceX96), l = uint(state.liquidity);
  const sqrt = state.protocol === 'cetus' ? cetusSqrtPriceAtTick : sqrtRatioAtTick;
  const price = (tick: number) => { const s = sqrt(tick); return priceWithDecimals(s * s,q * q,pool.decimals0,pool.decimals1); };
  const lowerTick = Math.max(state.lowerTick,...state.initializedTicks.filter(t => t.tick <= state.tick).map(t => t.tick));
  const upperTick = Math.min(state.upperTick,...state.initializedTicks.filter(t => t.tick > state.tick).map(t => t.tick));
  const lower = sqrt(lowerTick), upper = sqrt(upperTick);
  return { ...common,actualReserves: null,virtualReserves: { token0: rational(l * q,p),token1: rational(l * p,q) },coveredRange: { lowerTick: state.lowerTick,upperTick: state.upperTick,lowerPrice: price(state.lowerTick),upperPrice: price(state.upperTick) },activeInterval: { lowerTick,upperTick,token0InputFeeExclusive: ceilDiv(l * q * (p - lower),p * lower).toString(),token1InputFeeExclusive: ceilDiv(l * (upper - p),q).toString() },initializedTickCount: state.initializedTicks.length };
}
export function projectPool(input: unknown, operation: unknown): ProjectionResult {
  const pool = parsePoolState(input), request = parseProjectionRequest(operation);
  // Observation class can change during reconciliation; logical identity cannot.
  const snapshotDigest = digest(pool), operationDigest = digest({ operationId: request.operationId });
  if (snapshotDigest !== request.snapshotDigest) throw new Error('SNAPSHOT_DIGEST_MISMATCH');
  if (pool.appliedOperations.includes(operationDigest)) throw new Error('OPERATION_ALREADY_APPLIED');
  if (pool.appliedOperations.length === 1000) throw new Error('OPERATION_HISTORY_EXHAUSTED');
  const same = (a: string, b: string) => pool.identity.chain === 'arbitrum' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const zeroForOne = same(request.tokenIn, pool.token0);
  if (!zeroForOne && !same(request.tokenIn, pool.token1)) throw new Error('INVALID_INPUT_ASSET');
  let state = structuredClone(pool.state), amountOut: string, feeAmount: string, steps = 1, crossedTicks: number[] = [];
  if (state.protocol === 'uniswap-v2') {
    const quote = projectV2(state, zeroForOne, request.amountIn); state = { ...quote.state, protocol: 'uniswap-v2' }; amountOut = quote.amountOut; feeAmount = quote.feeAmount;
  } else if (state.protocol === 'cetus') {
    const quote = quoteCetusExactInput(state, zeroForOne, request.amountIn, request.maxSteps);
    amountOut = quote.amountOut; feeAmount = quote.feeAmount; steps = quote.steps; crossedTicks = quote.crossedTicks;
    state = { ...state, sqrtPriceX64: quote.sqrtPriceAfterX64, tick: quote.tickAfter, liquidity: quote.liquidityAfter };
  } else {
    if (pool.identity.chain !== 'arbitrum') throw new Error('PROTOCOL_CHAIN_MISMATCH');
    const block = { chainId: Number(pool.identity.network), number: uint(pool.identity.height, 64), hash: pool.identity.blockHash as `0x${string}`, timestamp: 0n };
    const common = { ...state, block, token0: pool.token0 as `0x${string}`, token1: pool.token1 as `0x${string}`, runtimeCodeHash: pool.revisionHash as `0x${string}` };
    const quote = state.protocol === 'uniswap-v3'
      ? quoteV3ExactInput({ ...common, ...state, pool: pool.poolAddress as `0x${string}` }, request.tokenIn, request.amountIn, state.lowerTick, state.upperTick, request.maxSteps)
      : quoteV4ExactInput({ ...common, ...state, poolManager: pool.poolAddress as `0x${string}`, poolId: state.poolId as `0x${string}` }, request.tokenIn, request.amountIn, state.lowerTick, state.upperTick, request.maxSteps);
    amountOut = quote.amountOut; feeAmount = quote.feeAmount; steps = quote.steps; crossedTicks = quote.crossedTicks;
    state = { ...state, sqrtPriceX96: quote.sqrtPriceAfterX96, tick: quote.tickAfter, liquidity: quote.liquidityAfter };
  }
  if (state.protocol !== 'uniswap-v2' && (state.tick < state.lowerTick || state.tick >= state.upperTick)) throw new Error(state.protocol === 'cetus' ? 'CETUS_COVERAGE_EXHAUSTED' : 'CLMM_COVERAGE_EXHAUSTED');
  const projectedState: PoolStateEnvelope = { ...pool, stateClass: 'projected', appliedOperations: [...pool.appliedOperations, operationDigest], state };
  return { schemaVersion: '4.0', status: 'complete', snapshotDigest, operationDigest, tokenIn: request.tokenIn, tokenOut: zeroForOne ? pool.token1 : pool.token0, amountIn: request.amountIn, consumedInput: request.amountIn, unspentInput: '0', amountOut, feeAmount, feeSemantics: state.protocol === 'uniswap-v2' ? 'input-retained-ceiling' : 'swap-step', priceBefore: poolPrice(pool), priceAfter: poolPrice(projectedState), crossedTicks, steps, projectedState, projectedStateDigest: digest(projectedState) };
}
