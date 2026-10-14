import { encodeFunctionData, type Address, type Hex } from 'viem';
import { uint } from './state.js';

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
  legs: Array<{ venueVersion: 2 | 3 | 4; root: Address; pool: Address; tokenIn: Address; tokenOut: Address; minAmountOut: string; fee: number; sqrtPriceLimitX96: string; tickSpacing: number; hooks: Address; hookData: Hex }>;
}
function address(a: string): void { if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('INVALID_ADDRESS'); }
/** Unsigned encoding for a corrected deployment only. Existing immutable executor records do not admit this ABI. */
export function encodeLenderArbitrage(input: LenderRouteInput): Hex {
  if (!['morpho-blue', 'balancer-v2'].includes(input.kind) || input.legs.length < 2 || input.legs.length > 6 || uint(input.flashAmount) === 0n || uint(input.minProfit) === 0n || uint(input.deadline) === 0n) throw new Error('INVALID_LENDER_ROUTE');
  address(input.lender); address(input.flashAsset);
  let current = input.flashAsset.toLowerCase();
  const legs = input.legs.map(leg => {
    [leg.root, leg.pool, leg.tokenIn, leg.tokenOut, leg.hooks].forEach(address);
    if (![2, 3, 4].includes(leg.venueVersion) || leg.tokenIn.toLowerCase() !== current || leg.tokenOut.toLowerCase() === current || !Number.isInteger(leg.fee) || leg.fee < 0 || leg.fee > 0xffffff || !Number.isInteger(leg.tickSpacing) || leg.tickSpacing < -0x800000 || leg.tickSpacing > 0x7fffff || !/^0x([0-9a-fA-F]{2})*$/.test(leg.hookData) || uint(leg.minAmountOut) === 0n) throw new Error('INVALID_ROUTE_LEG');
    current = leg.tokenOut.toLowerCase();
    return { ...leg, minAmountOut: uint(leg.minAmountOut), sqrtPriceLimitX96: uint(leg.sqrtPriceLimitX96, 160) };
  });
  if (current !== input.flashAsset.toLowerCase()) throw new Error('NON_CIRCULAR_ROUTE');
  return encodeFunctionData({ abi: MULTI_LENDER_ROUTE_ABI, functionName: 'executeLenderArbitrage', args: [{ kind: input.kind === 'morpho-blue' ? 1 : 2, lender: input.lender, flashAsset: input.flashAsset, flashAmount: uint(input.flashAmount), minProfit: uint(input.minProfit), deadline: uint(input.deadline), legs }] });
}
