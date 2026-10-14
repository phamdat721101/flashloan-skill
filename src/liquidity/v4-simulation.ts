import { parseAbi, keccak256, type Address, type Hex } from 'viem';
import { digest, uint } from './state.js';
import { parsePoolState, parseProjectionRequest, poolPrice, type PoolStateEnvelope } from './projection.js';
import { sqrtRatioAtTick } from './clmm.js';
import type { StateClient } from '../state-adapters.js';

export interface V4SimulationBinding { quoter: Address; quoterCodeHash: Hex; hookCodeHash: Hex; hookData: Hex }
export interface SimulatedV4Quote {
  schemaVersion: '4.0'; eligibility: 'simulation-required'; semantics: 'quoter-sender'; snapshotDigest: string; operationDigest: string;
  tokenIn: string; tokenOut: string; amountIn: string; consumedInput: string; unspentInput: string; amountOut: string;
  projectedState: PoolStateEnvelope; projectedStateDigest: string; executionDigest: string;
  priceBefore: ReturnType<typeof poolPrice>; priceAfter: ReturnType<typeof poolPrice>;
}
export const V4_STATE_QUOTER_ABI = parseAbi(['function quoteExactInput(address manager,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bool zeroForOne,uint256 amount,uint160 limit,bytes hookData,int16[] words) returns((int256 delta,uint160 price,int24 tick,uint128 liquidity,uint24 protocolFee,uint24 lpFee,uint256[] bitmap,int24[] tickIndices,uint128[] liquidityGross,int128[] liquidityNet) result)']);
/** Exact VM projection for hook/dynamic-fee pools. Code pins and exact block are mandatory;
 * this call does not grant admission or prove behavior for a different executor sender.
 */
export async function simulateV4Projection(client: StateClient,rawPool: unknown,rawRequest: unknown,binding: V4SimulationBinding): Promise<SimulatedV4Quote> {
  const pool = parsePoolState(rawPool), request = parseProjectionRequest(rawRequest), snapshotDigest = digest(pool), operationDigest = digest({ operationId: request.operationId });
  if (pool.identity.chain !== 'arbitrum' || pool.state.protocol !== 'uniswap-v4' || pool.stateClass !== 'canonical') throw new Error('UNSUPPORTED_V4_SIMULATION_STATE');
  if (request.snapshotDigest !== snapshotDigest || pool.appliedOperations.includes(operationDigest) || pool.appliedOperations.length >= 1000) throw new Error('INVALID_V4_SIMULATION_REQUEST');
  if (!binding || Object.keys(binding).sort().join(',') !== 'hookCodeHash,hookData,quoter,quoterCodeHash' || !/^0x[0-9a-fA-F]{40}$/.test(binding.quoter) || !/^0x[0-9a-f]{64}$/.test(binding.quoterCodeHash) || !/^0x[0-9a-f]{64}$/.test(binding.hookCodeHash) || !/^0x([a-f0-9]{2})*$/.test(binding.hookData) || binding.hookData.length > 8194) throw new Error('INVALID_V4_SIMULATION_BINDING');
  const zeroForOne = request.tokenIn.toLowerCase() === pool.token0.toLowerCase();
  if (!zeroForOne && request.tokenIn.toLowerCase() !== pool.token1.toLowerCase()) throw new Error('INVALID_INPUT_ASSET');
  const height = uint(pool.identity.height,64), chain = await client.getChainId();
  if (String(chain) !== pool.identity.network || (await client.getBlock({ blockNumber: height })).hash !== pool.identity.blockHash) throw new Error('STATE_CHANGED');
  const pins: Array<[Address,Hex]> = [[pool.poolAddress as Address,pool.revisionHash as Hex],[binding.quoter,binding.quoterCodeHash]];
  if (!/^0x0{40}$/i.test(pool.state.key.hooks)) pins.push([pool.state.key.hooks,binding.hookCodeHash]);
  for (const [address,pin] of pins) {
    const code = await client.getCode({ address,blockNumber: height });
    if (!code || code === '0x' || keccak256(code) !== pin) throw new Error('V4_SIMULATION_CODE_CHANGED');
  }
  const state = pool.state, limit = zeroForOne ? sqrtRatioAtTick(state.lowerTick) + (state.lowerTick === -887272 ? 1n : 0n) : sqrtRatioAtTick(state.upperTick) - (state.upperTick === 887272 ? 1n : 0n);
  const raw = await client.readContract({ address: binding.quoter,abi: V4_STATE_QUOTER_ABI,functionName: 'quoteExactInput',args: [pool.poolAddress,state.key,zeroForOne,uint(request.amountIn),limit,binding.hookData,state.bitmapWords.map(w => w.wordPosition)],blockNumber: height });
  const result = raw as { delta: bigint; price: bigint; tick: number; liquidity: bigint; protocolFee: number; lpFee: number; bitmap: bigint[]; tickIndices: number[]; liquidityGross: bigint[]; liquidityNet: bigint[] };
  if (!result || typeof result.delta !== 'bigint' || !Array.isArray(result.bitmap) || result.bitmap.length !== state.bitmapWords.length || !Array.isArray(result.tickIndices) || result.tickIndices.length > 10000 || !Array.isArray(result.liquidityGross) || result.liquidityGross.length !== result.tickIndices.length || !Array.isArray(result.liquidityNet) || result.liquidityNet.length !== result.tickIndices.length) throw new Error('INCOMPLETE_V4_SIMULATION');
  if (!Number.isInteger(result.lpFee) || result.lpFee < 0 || result.lpFee >= 1000000 || !Number.isInteger(result.protocolFee) || result.protocolFee < 0 || result.protocolFee > 0xffffff || (result.protocolFee & 0xfff) > 1000 || (result.protocolFee >> 12) > 1000) throw new Error('INVALID_V4_SIMULATION_FEE');
  const delta = result.delta, delta0 = BigInt.asIntN(128,delta >> 128n), delta1 = BigInt.asIntN(128,delta), inputDelta = zeroForOne ? delta0 : delta1, outputDelta = zeroForOne ? delta1 : delta0;
  if (inputDelta >= 0n || outputDelta < 0n || -inputDelta > uint(request.amountIn)) throw new Error('INVALID_V4_SIMULATION_DELTA');
  const projectedState = parsePoolState({ ...pool,stateClass: 'projected',appliedOperations: [...pool.appliedOperations,operationDigest],state: { ...state,sqrtPriceX96: String(result.price),tick: Number(result.tick),liquidity: String(result.liquidity),protocolFeePips: Number(result.protocolFee),lpFeePips: Number(result.lpFee),bitmapWords: state.bitmapWords.map((w,i) => ({ wordPosition: w.wordPosition,bitmap: String(result.bitmap[i]) })),initializedTicks: result.tickIndices.map((tick,i) => ({ tick,liquidityGross: String(result.liquidityGross[i]),liquidityNet: String(result.liquidityNet[i]) })) } });
  if (projectedState.state.protocol !== 'uniswap-v4' || projectedState.state.tick < state.lowerTick || projectedState.state.tick >= state.upperTick) throw new Error('CLMM_COVERAGE_EXHAUSTED');
  if ((await client.getBlock({ blockNumber: height })).hash !== pool.identity.blockHash) throw new Error('BLOCK_REORG');
  return { schemaVersion: '4.0',eligibility: 'simulation-required',semantics: 'quoter-sender',snapshotDigest,operationDigest,tokenIn: request.tokenIn,tokenOut: zeroForOne ? pool.token1 : pool.token0,amountIn: request.amountIn,consumedInput: (-inputDelta).toString(),unspentInput: (uint(request.amountIn) + inputDelta).toString(),amountOut: outputDelta.toString(),projectedState,projectedStateDigest: digest(projectedState),executionDigest: digest({ pool: snapshotDigest,request,binding,result: { ...result,delta: String(result.delta),price: String(result.price),liquidity: String(result.liquidity),bitmap: result.bitmap.map(String),liquidityGross: result.liquidityGross.map(String),liquidityNet: result.liquidityNet.map(String) } }),priceBefore: poolPrice(pool),priceAfter: poolPrice(projectedState) };
}
