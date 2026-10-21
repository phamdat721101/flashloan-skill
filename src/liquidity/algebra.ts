import { evmProfile, type EvmChainKey } from '../evm-chains.js';
import { q96ExactInputStep, sqrtRatioAtTick, tickAtRatio } from './clmm.js';
import { digest, uint } from './state.js';
import { keccak256, parseAbi, type Address, type Hex } from 'viem';
import type { StateClient } from '../state-adapters.js';

export interface AlgebraLinkedTick { tick: number; liquidityGross: string; liquidityNet: string; prevTick: number; nextTick: number }
export interface AlgebraLinkedState {
  schemaVersion: '4.0'; revision: 'algebra-integral-linked-v1'; sqrtPriceX96: string; tick: number; liquidity: string;
  lastFee: number; communityFee: number; pluginConfig: number; plugin: string; unlocked: boolean;
  prevTickGlobal: number; nextTickGlobal: number; lowerTick: number; upperTick: number; ticks: AlgebraLinkedTick[];
}
export interface AlgebraFeeResolution { snapshotDigest: string; amountIn: string; zeroForOne: boolean; overrideFee: number; pluginFee: number; evidenceDigest: string }
export interface AlgebraQuote {
  schemaVersion: '4.0'; snapshotDigest: string; feeEvidenceDigest: string | null; amountIn: string; amountOut: string; feeAmount: string;
  communityFeeAmount: string; pluginFeeAmount: string; nextState: AlgebraLinkedState; nextStateDigest: string; crossedTicks: number[]; steps: number;
}
/** Linked initialized ticks, without V3's synthetic empty bitmap-word steps.
 * An active plugin requires an exact-amount beforeSwap fee resolution. This is
 * conditional arithmetic only: the plugin's state/effects still require simulation.
 */
export function quoteAlgebraExactInput(raw: AlgebraLinkedState,zeroForOne: boolean,amountIn: string,resolution?: AlgebraFeeResolution): AlgebraQuote {
  const state = structuredClone(raw), snapshotDigest = digest(raw);
  if (!state || Object.keys(state).sort().join(',') !== 'communityFee,lastFee,liquidity,lowerTick,nextTickGlobal,plugin,pluginConfig,prevTickGlobal,revision,schemaVersion,sqrtPriceX96,tick,ticks,unlocked,upperTick' || state.schemaVersion !== '4.0' || state.revision !== 'algebra-integral-linked-v1' || state.unlocked !== true || typeof zeroForOne !== 'boolean' || !/^0x[0-9a-f]{40}$/.test(state.plugin) || !Array.isArray(state.ticks) || state.ticks.length > 10000 || !Number.isInteger(state.lastFee) || state.lastFee < 0 || state.lastFee > 65535 || !Number.isInteger(state.communityFee) || state.communityFee < 0 || state.communityFee > 1000 || !Number.isInteger(state.pluginConfig) || state.pluginConfig < 0 || state.pluginConfig > 255) throw new Error('INVALID_ALGEBRA_STATE');
  for (const t of [state.tick,state.lowerTick,state.upperTick,state.prevTickGlobal,state.nextTickGlobal]) if (!Number.isInteger(t) || t < -887272 || t > 887272) throw new Error('INVALID_ALGEBRA_STATE');
  if (state.lowerTick > state.tick || state.tick >= state.upperTick || state.prevTickGlobal > state.tick || state.nextTickGlobal <= state.tick) throw new Error('INVALID_ALGEBRA_COVERAGE');
  let remaining = uint(amountIn), price = uint(state.sqrtPriceX96,160), liquidity = uint(state.liquidity,128), tick = state.tick;
  if (!remaining || remaining >= 1n << 255n || price < sqrtRatioAtTick(tick) || price > sqrtRatioAtTick(tick + 1)) throw new Error('INVALID_ALGEBRA_STATE');
  let fee = state.lastFee, pluginFee = 0, feeEvidenceDigest: string | null = null;
  const active = state.pluginConfig !== 0;
  if (active || resolution) {
    if (!resolution || Object.keys(resolution).sort().join(',') !== 'amountIn,evidenceDigest,overrideFee,pluginFee,snapshotDigest,zeroForOne' || resolution.snapshotDigest !== snapshotDigest || resolution.amountIn !== amountIn || resolution.zeroForOne !== zeroForOne || !/^[a-f0-9]{64}$/.test(resolution.evidenceDigest) || ![resolution.overrideFee,resolution.pluginFee].every(f => Number.isInteger(f) && f >= 0 && f < 1000000)) throw new Error('UNRESOLVED_ALGEBRA_PLUGIN');
    fee = (resolution.overrideFee || state.lastFee) + resolution.pluginFee; pluginFee = resolution.pluginFee; feeEvidenceDigest = resolution.evidenceDigest;
    if (fee >= 1000000) throw new Error('INVALID_ALGEBRA_FEE');
  }
  const nodes = new Map(state.ticks.map(node => {
    if (!node || Object.keys(node).sort().join(',') !== 'liquidityGross,liquidityNet,nextTick,prevTick,tick' || !Number.isInteger(node.tick) || node.tick < -887272 || node.tick > 887272 || !Number.isInteger(node.prevTick) || !Number.isInteger(node.nextTick) || (node.prevTick >= node.tick && !(node.tick === -887272 && node.prevTick === node.tick)) || (node.nextTick <= node.tick && !(node.tick === 887272 && node.nextTick === node.tick)) || typeof node.liquidityNet !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(node.liquidityNet)) throw new Error('INVALID_ALGEBRA_TICK');
    const gross = uint(node.liquidityGross,128), net = BigInt(node.liquidityNet);
    if (net < -(1n << 127n) || net >= 1n << 127n || (net < 0n ? -net : net) > gross) throw new Error('INVALID_ALGEBRA_TICK');
    return [node.tick,node] as const;
  }));
  if (nodes.size !== state.ticks.length) throw new Error('INVALID_ALGEBRA_TICK');
  const validatePath = (start: number,down: boolean) => {
    let next = start, prior = down ? state.nextTickGlobal : state.prevTickGlobal, visits = 0;
    while (down ? next >= state.lowerTick : next <= state.upperTick) {
      if (++visits > 10000) throw new Error('INVALID_ALGEBRA_COVERAGE');
      const node = nodes.get(next);
      if (!node || (down ? node.nextTick : node.prevTick) !== prior) throw new Error('INVALID_ALGEBRA_COVERAGE');
      if (down ? next === -887272 : next === 887272) break;
      prior = next; next = down ? node.prevTick : node.nextTick;
    }
  };
  validatePath(state.prevTickGlobal,true); validatePath(state.nextTickGlobal,false);
  const limit = zeroForOne ? sqrtRatioAtTick(state.lowerTick) + (state.lowerTick === -887272 ? 1n : 0n) : sqrtRatioAtTick(state.upperTick) - (state.upperTick === 887272 ? 1n : 0n);
  if (zeroForOne ? limit >= price : limit <= price) throw new Error('ALGEBRA_COVERAGE_EXHAUSTED');
  let next = zeroForOne ? state.prevTickGlobal : state.nextTickGlobal, output = 0n, fees = 0n, communityFees = 0n, pluginFees = 0n, steps = 0;
  const crossedTicks: number[] = [];
  while (remaining) {
    if (++steps > 4096) throw new Error('ALGEBRA_STEP_LIMIT');
    const boundary = sqrtRatioAtTick(next), target = zeroForOne ? boundary < limit ? limit : boundary : boundary > limit ? limit : boundary;
    const step = q96ExactInputStep(price,target,liquidity,remaining,fee,zeroForOne);
    if (step.used + step.fee > remaining) throw new Error('ALGEBRA_MATH_INVARIANT');
    remaining -= step.used + step.fee; output += step.received; fees += step.fee; price = step.nextRatio;
    const pluginDelta = fee ? step.fee * BigInt(pluginFee) / BigInt(fee) : 0n;
    pluginFees += pluginDelta; communityFees += (step.fee - pluginDelta) * BigInt(state.communityFee) / 1000n;
    if (price === boundary) {
      const node = nodes.get(next); if (!node) throw new Error('ALGEBRA_COVERAGE_EXHAUSTED');
      liquidity += (zeroForOne ? -1n : 1n) * BigInt(node.liquidityNet); uint(liquidity.toString(),128);
      tick = zeroForOne ? next - 1 : next; crossedTicks.push(next);
      if (zeroForOne) { state.nextTickGlobal = next; state.prevTickGlobal = node.prevTick; next = node.prevTick; }
      else { state.prevTickGlobal = next; state.nextTickGlobal = node.nextTick; next = node.nextTick; }
    } else if (price !== uint(state.sqrtPriceX96,160)) tick = tickAtRatio(price);
    if ((remaining && price === limit) || tick < state.lowerTick || tick >= state.upperTick) throw new Error('ALGEBRA_COVERAGE_EXHAUSTED');
  }
  state.sqrtPriceX96 = price.toString(); state.tick = tick; state.liquidity = liquidity.toString(); uint(output.toString());
  return { schemaVersion: '4.0',snapshotDigest,feeEvidenceDigest,amountIn,amountOut: output.toString(),feeAmount: fees.toString(),communityFeeAmount: communityFees.toString(),pluginFeeAmount: pluginFees.toString(),nextState: state,nextStateDigest: digest(state),crossedTicks,steps };
}

const linkedAbi = parseAbi([
  'function token0() view returns(address)', 'function token1() view returns(address)',
  'function globalState() view returns(uint160 price,int24 tick,uint16 lastFee,uint8 pluginConfig,uint16 communityFee,bool unlocked)',
  'function liquidity() view returns(uint128)', 'function plugin() view returns(address)',
  'function prevTickGlobal() view returns(int24)', 'function nextTickGlobal() view returns(int24)',
  'function ticks(int24) view returns(uint256 liquidityTotal,int128 liquidityDelta,int24 prevTick,int24 nextTick,uint256 outerFeeGrowth0Token,uint256 outerFeeGrowth1Token)'
]);
/** Current Integral linked-state ABI, separate from the legacy tickTable/timepoint adapter. */
export async function readAlgebraLinkedSnapshot(client: StateClient,address: Address,expectedCodeHash: Hex,lowerTick: number,upperTick: number): Promise<{ identity: { chain: EvmChainKey; network: string; height: string; blockHash: Hex }; token0: string; token1: string; state: AlgebraLinkedState; revisionHash: Hex }> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^0x[0-9a-f]{64}$/.test(expectedCodeHash) || !Number.isInteger(lowerTick) || !Number.isInteger(upperTick) || lowerTick < -887272 || upperTick > 887272 || lowerTick >= upperTick) throw new Error('INVALID_ALGEBRA_CAPTURE');
  const chain = await client.getChainId(); const profile = evmProfile(chain);
  const block = await client.getBlock(); if (!block.hash) throw new Error('INCOMPLETE_BLOCK');
  const code = await client.getCode({ address,blockNumber: block.number });
  if (!code || keccak256(code) !== expectedCodeHash) throw new Error('POOL_CODE_CHANGED');
  const read = (functionName: string,args?: readonly unknown[]) => client.readContract({ address,abi: linkedAbi,functionName,args,blockNumber: block.number });
  const [global,liquidity,plugin,prev,next,token0,token1] = await Promise.all(['globalState','liquidity','plugin','prevTickGlobal','nextTickGlobal','token0','token1'].map(name => read(name)));
  if (!Array.isArray(global) || global.length !== 6 || typeof global[5] !== 'boolean' || typeof liquidity !== 'bigint' || typeof plugin !== 'string' || typeof prev !== 'number' || typeof next !== 'number' || typeof token0 !== 'string' || typeof token1 !== 'string') throw new Error('INCOMPLETE_ALGEBRA_STATE');
  const ticks = new Map<number,AlgebraLinkedTick>();
  for (const down of [true,false]) {
    let tick = down ? prev : next, prior = down ? next : prev, visited = 0;
    while (down ? tick >= lowerTick : tick <= upperTick) {
      if (++visited > 10000) throw new Error('ALGEBRA_CAPTURE_LIMIT');
      const value = await read('ticks',[tick]);
      if (!Array.isArray(value) || value.length !== 6) throw new Error('INCOMPLETE_ALGEBRA_STATE');
      const node = { tick,liquidityGross: String(value[0]),liquidityNet: String(value[1]),prevTick: Number(value[2]),nextTick: Number(value[3]) };
      if (ticks.has(tick) || (down ? node.nextTick : node.prevTick) !== prior) throw new Error('INVALID_ALGEBRA_COVERAGE');
      ticks.set(tick,node);
      if (down ? tick === -887272 : tick === 887272) break;
      prior = tick; tick = down ? node.prevTick : node.nextTick;
    }
  }
  const state: AlgebraLinkedState = { schemaVersion: '4.0',revision: 'algebra-integral-linked-v1',sqrtPriceX96: String(global[0]),tick: Number(global[1]),lastFee: Number(global[2]),pluginConfig: Number(global[3]),communityFee: Number(global[4]),unlocked: global[5],liquidity: liquidity.toString(),plugin: plugin.toLowerCase(),prevTickGlobal: prev,nextTickGlobal: next,lowerTick,upperTick,ticks: [...ticks.values()].sort((a,b) => a.tick - b.tick) };
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('BLOCK_REORG');
  return { identity: { chain: profile.key,network: String(chain),height: block.number.toString(),blockHash: block.hash },token0,token1,state,revisionHash: expectedCodeHash };
}
