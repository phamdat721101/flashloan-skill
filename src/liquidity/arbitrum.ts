import { encodeFunctionData, type Address, type Hex } from 'viem';
import { digest, parseSnapshot, uint, type LiquiditySnapshot } from './state.js';
import { parsePoolState } from './projection.js';
import { compareRouteDirections, parseSizingRequest, sizingToCandidate, type RouteComparison } from './sizing.js';
import type { RouteCandidate } from './runtime.js';
import { sqrtRatioAtTick } from './clmm.js';

const legComponents = [
  { name: 'venueVersion', type: 'uint8' }, { name: 'root', type: 'address' }, { name: 'pool', type: 'address' },
  { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'minAmountOut', type: 'uint256' },
  { name: 'fee', type: 'uint24' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }, { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' }, { name: 'hookData', type: 'bytes' }
] as const;
export const MULTI_LENDER_ROUTE_ABI = [{ type: 'function', name: 'executeLenderArbitrage', stateMutability: 'nonpayable', inputs: [{ name: 'route', type: 'tuple', components: [
  { name: 'kind', type: 'uint8' }, { name: 'lender', type: 'address' }, { name: 'flashAsset', type: 'address' },
  { name: 'flashAmount', type: 'uint256' }, { name: 'legs', type: 'tuple[]', components: legComponents },
  { name: 'minProfit', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
] }], outputs: [] }] as const;
export interface LenderRouteInput {
  kind: 'morpho-blue' | 'balancer-v2'; lender: Address; flashAsset: Address; flashAmount: string; minProfit: string; deadline: string;
  legs: Array<{ venueVersion: 2 | 3 | 4 | 5; root: Address; pool: Address; tokenIn: Address; tokenOut: Address; minAmountOut: string; fee: number; sqrtPriceLimitX96: string; tickSpacing: number; hooks: Address; hookData: Hex }>;
}
function address(a: string): void { if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('INVALID_ADDRESS'); }
/** Unsigned encoding for a corrected deployment only. Existing immutable executor records do not admit this ABI. */
export function encodeLenderArbitrage(input: LenderRouteInput): Hex {
  if (!['morpho-blue', 'balancer-v2'].includes(input.kind) || input.legs.length < 2 || input.legs.length > 6 || uint(input.flashAmount) === 0n || uint(input.minProfit) === 0n || uint(input.deadline) === 0n) throw new Error('INVALID_LENDER_ROUTE');
  address(input.lender); address(input.flashAsset);
  let current = input.flashAsset.toLowerCase();
  const legs = input.legs.map(leg => {
    [leg.root, leg.pool, leg.tokenIn, leg.tokenOut, leg.hooks].forEach(address);
    if (![2, 3, 4, 5].includes(leg.venueVersion) || leg.tokenIn.toLowerCase() !== current || leg.tokenOut.toLowerCase() === current || !Number.isInteger(leg.fee) || leg.fee < 0 || leg.fee > 0xffffff || !Number.isInteger(leg.tickSpacing) || leg.tickSpacing < -0x800000 || leg.tickSpacing > 0x7fffff || !/^0x([0-9a-fA-F]{2})*$/.test(leg.hookData) || uint(leg.minAmountOut) === 0n) throw new Error('INVALID_ROUTE_LEG');
    current = leg.tokenOut.toLowerCase();
    return { ...leg, minAmountOut: uint(leg.minAmountOut), sqrtPriceLimitX96: uint(leg.sqrtPriceLimitX96, 160) };
  });
  if (current !== input.flashAsset.toLowerCase()) throw new Error('NON_CIRCULAR_ROUTE');
  return encodeFunctionData({ abi: MULTI_LENDER_ROUTE_ABI, functionName: 'executeLenderArbitrage', args: [{ kind: input.kind === 'morpho-blue' ? 1 : 2, lender: input.lender, flashAsset: input.flashAsset, flashAmount: uint(input.flashAmount), minProfit: uint(input.minProfit), deadline: uint(input.deadline), legs }] });
}

export interface ArbitrumTradeBinding {
  kind: LenderRouteInput['kind']; lender: Address; deadline: string;
  roots: Array<{ poolId: string; root: Address; adapterRevision: string; revisionHash: string }>;
  adapterId: string; adapterRevision: string; expiresAtMs: number; maxGasCost: string;
}
export interface PreparedArbitrumTrade {
  schemaVersion: '4.0'; comparison: RouteComparison;
  unsignedPayload: Hex | null; candidate: RouteCandidate | null;
}
/** Wallet-free preparation. This artifact cannot admit an executor or bypass fresh simulation. */
export function prepareArbitrumTrade(inputs: unknown, request: unknown, snapshot: LiquiditySnapshot, binding: ArbitrumTradeBinding): PreparedArbitrumTrade {
  if (!Array.isArray(inputs)) throw new Error('INVALID_SIZING_POOLS');
  const pools = inputs.map(parsePoolState);
  if (pools.some(pool => pool.identity.chain === 'sui' || pool.stateClass !== 'canonical')) throw new Error('UNSUPPORTED_TRADE_STATE');
  for (const pool of pools) {
    const state = pool.state;
    if (state.protocol === 'cetus' || [pool.token0,pool.token1].some(token => /^0x0{40}$/i.test(token)) || (state.protocol === 'uniswap-v4' && (state.key.hooks !== `0x${'0'.repeat(40)}` || state.key.fee & 0x800000))) throw new Error('UNSUPPORTED_TRADE_PROTOCOL');
    if (state.protocol !== 'uniswap-v2' && pool.token0.toLowerCase() >= pool.token1.toLowerCase()) throw new Error('INVALID_POOL_ASSETS');
  }
  const source = parseSnapshot(snapshot);
  if (!source.complete || source.stateDigest !== digest(pools) || pools.some(pool => digest(pool.identity) !== digest(source.identity) || !source.poolIds.includes(pool.poolId))) throw new Error('ANALYTICS_CANDIDATE_STATE_MISMATCH');
  if (!binding || Object.keys(binding).sort().join(',') !== 'adapterId,adapterRevision,deadline,expiresAtMs,kind,lender,maxGasCost,roots' || !['morpho-blue','balancer-v2'].includes(binding.kind) || !Array.isArray(binding.roots) || binding.roots.length !== pools.length || binding.roots.some(root => !root || typeof root !== 'object') || new Set(binding.roots.map(root => root.poolId)).size !== pools.length || !Number.isSafeInteger(binding.expiresAtMs) || binding.expiresAtMs < 0 || uint(binding.deadline) * 1000n > BigInt(binding.expiresAtMs) || uint(binding.deadline) * 1000n <= BigInt(source.observedAtMs)) throw new Error('INVALID_TRADE_BINDING');
  if (![binding.adapterId,binding.adapterRevision].every(value => typeof value === 'string' && value.length > 0 && value.length <= 128) || !uint(binding.maxGasCost)) throw new Error('INVALID_TRADE_BINDING');
  const checkedRequest = parseSizingRequest(request);
  if (binding.expiresAtMs <= source.observedAtMs || uint(binding.maxGasCost) > uint(checkedRequest.costInBorrowAsset)) throw new Error('INVALID_TRADE_BINDING');
  if (binding.kind === 'morpho-blue' && uint(checkedRequest.flashFeeNumerator) !== 0n) throw new Error('LENDER_FEE_MISMATCH');
  address(binding.lender);
  if (/^0x0{40}$/i.test(binding.lender)) throw new Error('INVALID_TRADE_BINDING');
  const roots = new Map(binding.roots.map(root => {
    if (!root || Object.keys(root).sort().join(',') !== 'adapterRevision,poolId,revisionHash,root') throw new Error('INVALID_TRADE_ROOT');
    address(root.root);
    if (/^0x0{40}$/i.test(root.root)) throw new Error('INVALID_TRADE_ROOT');
    const pool = pools.find(pool => pool.poolId === root.poolId);
    if (!pool || pool.adapterRevision !== root.adapterRevision || pool.revisionHash !== root.revisionHash) throw new Error('TRADE_REVISION_MISMATCH');
    if (pool.state.protocol === 'uniswap-v4' && root.root.toLowerCase() !== pool.poolAddress.toLowerCase()) throw new Error('TRADE_REVISION_MISMATCH');
    return [root.poolId,root.root] as const;
  }));
  const comparison = compareRouteDirections(pools,checkedRequest), result = comparison.selected, selectedRequest = comparison.selectedRequest;
  if (!result || !selectedRequest) return { schemaVersion: '4.0',comparison,unsignedPayload: null,candidate: null };
  const byId = new Map(pools.map(pool => [pool.poolId,pool]));
  const legs: LenderRouteInput['legs'] = selectedRequest.route.map((leg,index) => {
    const pool = byId.get(leg.poolId)!, state = pool.state, quote = result.legs[index];
    if (state.protocol === 'cetus') throw new Error('UNSUPPORTED_TRADE_PROTOCOL');
    const zeroForOne = quote.tokenIn.toLowerCase() === pool.token0.toLowerCase();
    const limit = state.protocol === 'uniswap-v2' ? 0n : zeroForOne ? sqrtRatioAtTick(state.lowerTick) + (state.lowerTick === -887272 ? 1n : 0n) : sqrtRatioAtTick(state.upperTick) - (state.upperTick === 887272 ? 1n : 0n);
    return { venueVersion: state.protocol === 'uniswap-v2' ? 2 : state.protocol === 'uniswap-v3' ? 3 : 4,
      root: roots.get(pool.poolId)!,pool: state.protocol === 'uniswap-v4' ? `0x${'0'.repeat(40)}` : pool.poolAddress as Address,tokenIn: quote.tokenIn as Address,tokenOut: quote.tokenOut as Address,
      minAmountOut: quote.amountOut,fee: state.protocol === 'uniswap-v2' ? 0 : state.protocol === 'uniswap-v3' ? state.feePips : state.key.fee,
      sqrtPriceLimitX96: limit.toString(),tickSpacing: state.protocol === 'uniswap-v2' ? 0 : state.tickSpacing,hooks: `0x${'0'.repeat(40)}`,hookData: '0x' };
  });
  const unsignedPayload = encodeLenderArbitrage({ kind: binding.kind,lender: binding.lender,flashAsset: result.borrowAsset as Address,flashAmount: result.amountIn,
    // Executor guards gross profit; include conservative costs to preserve the net floor.
    minProfit: (uint(selectedRequest.minProfit) + uint(selectedRequest.costInBorrowAsset)).toString(),deadline: binding.deadline,legs });
  const candidate = sizingToCandidate(pools,selectedRequest,result,source,{ ...binding,unsignedPayload });
  return { schemaVersion: '4.0',comparison,unsignedPayload,candidate };
}
