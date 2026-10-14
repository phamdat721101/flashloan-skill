// Integer tick factors and X64 step rules follow CetusProtocol/cetus-clmm-sui-sdk
// src/math/tick.ts and clmm.ts. This calculator alone does not admit a Move package.
import { uint } from './state.js';
import { ceilDiv } from './v2.js';

const POSITIVE = ['79232123823359799118286999567','79236085330515764027303304731','79244008939048815603706035061','79259858533276714757314932305','79291567232598584799939703904','79355022692464371645785046466','79482085999252804386437311141','79736823300114093921829183326','80248749790819932309965073892','81282483887344747381513967011','83390072131320151908154831281','87770609709833776024991924138','97234110755111693312479820773','119332217159966728226237229890','179736315981702064433883588727','407748233172238350107850275304','2098478828474011932436660412517','55581415166113811149459800483533','38992368544603139932233054999993551'].map(BigInt);
const NEGATIVE = ['18445821805675392311','18444899583751176498','18443055278223354162','18439367220385604838','18431993317065449817','18417254355718160513','18387811781193591352','18329067761203520168','18212142134806087854','17980523815641551639','17526086738831147013','16651378430235024244','15030750278693429944','12247334978882834399','8131365268884726200','3584323654723342297','696457651847595233','26294789957452057','37481735321082'].map(BigInt);
const Q64 = 1n << 64n, PIPS = 1000000n;
export interface CetusMathState {
  sqrtPriceX64: string; tick: number; liquidity: string; feePips: number; tickSpacing: number;
  lowerTick: number; upperTick: number; complete: boolean;
  initializedTicks: Array<{ tick: number; liquidityGross: string; liquidityNet: string }>;
}
export function cetusSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || Math.abs(tick) > 443636) throw new Error('CETUS_INVALID_TICK');
  const factors = tick > 0 ? POSITIVE : NEGATIVE, shift = tick > 0 ? 96n : 64n;
  let value = 1n << shift;
  for (let bit = 0; bit < factors.length; bit++) if ((Math.abs(tick) & (1 << bit)) !== 0) value = value * factors[bit] >> shift;
  return tick > 0 ? value >> 32n : value;
}
function tickAtPrice(price: bigint): number {
  let left = -443636, right = 443636;
  while (left < right) { const middle = Math.ceil((left + right) / 2); if (cetusSqrtPriceAtTick(middle) <= price) left = middle; else right = middle - 1; }
  return left;
}
export function validateCetus(state: CetusMathState): void {
  const price = uint(state.sqrtPriceX64, 128); uint(state.liquidity, 128);
  if (state.complete !== true || !Number.isInteger(state.feePips) || state.feePips < 0 || state.feePips >= 1000000 || !Number.isInteger(state.tickSpacing) || state.tickSpacing < 1 || !Number.isInteger(state.lowerTick) || !Number.isInteger(state.upperTick) || state.lowerTick < -443636 || state.upperTick > 443636 || state.lowerTick >= state.upperTick || !Number.isInteger(state.tick) || state.tick < state.lowerTick || state.tick >= state.upperTick || price < cetusSqrtPriceAtTick(state.tick) || price > cetusSqrtPriceAtTick(state.tick + 1) || !Array.isArray(state.initializedTicks) || state.initializedTicks.length > 10000) throw new Error('CETUS_INVALID_STATE');
  let previous = -443637;
  for (const entry of state.initializedTicks) {
    const gross = uint(entry.liquidityGross, 128);
    if (!Number.isInteger(entry.tick) || entry.tick <= previous || entry.tick < state.lowerTick || entry.tick > state.upperTick || entry.tick % state.tickSpacing !== 0 || typeof entry.liquidityNet !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(entry.liquidityNet)) throw new Error('CETUS_INVALID_TICK_TABLE');
    const net = BigInt(entry.liquidityNet);
    if (!gross || net < -(1n << 127n) || net >= 1n << 127n || (net < 0n ? -net : net) > gross) throw new Error('CETUS_INVALID_TICK_TABLE');
    previous = entry.tick;
  }
}
/** Exact-input X64 quote over a declared complete table window. Coverage provenance is checked upstream. */
export function quoteCetusExactInput(state: CetusMathState, aToB: boolean, amount: string, maxSteps = 4096) {
  validateCetus(state);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 4096) throw new Error('CETUS_STEP_LIMIT');
  let remaining = uint(amount, 64), price = uint(state.sqrtPriceX64, 128), liquidity = uint(state.liquidity, 128), tick = state.tick;
  let output = 0n, fees = 0n, steps = 0;
  const crossedTicks: number[] = [];
  const entries = state.initializedTicks.filter(entry => aToB ? entry.tick <= tick : entry.tick > tick);
  if (aToB) entries.reverse();
  const limitTick = aToB ? state.lowerTick : state.upperTick;
  const limits = [...entries, ...(entries.at(-1)?.tick === limitTick ? [] : [{ tick: limitTick, liquidityGross: '0', liquidityNet: '0' }])];
  for (const boundary of limits) {
    if (!remaining) break;
    if (++steps > maxSteps) throw new Error('CETUS_STEP_LIMIT');
    const target = cetusSqrtPriceAtTick(boundary.tick), difference = aToB ? price - target : target - price;
    if (difference < 0n) throw new Error('CETUS_INVALID_TICK_TABLE');
    const available = remaining * (PIPS - BigInt(state.feePips)) / PIPS;
    const capacity = aToB ? ceilDiv((liquidity << 64n) * difference, price * target) : ceilDiv(liquidity * difference, Q64);
    const used = available < capacity ? available : capacity;
    const fee = available < capacity ? remaining - available : ceilDiv(used * BigInt(state.feePips), PIPS - BigInt(state.feePips));
    const next = available >= capacity ? target : aToB ? ceilDiv((liquidity << 64n) * price, (liquidity << 64n) + used * price) : price + used * Q64 / liquidity;
    const delta = aToB ? price - next : next - price;
    output += aToB ? liquidity * delta / Q64 : (liquidity << 64n) * delta / (price * next);
    remaining -= used + fee; fees += fee; price = next;
    if (next === target && boundary.liquidityGross !== '0') {
      liquidity += aToB ? -BigInt(boundary.liquidityNet) : BigInt(boundary.liquidityNet);
      if (liquidity < 0n || liquidity >= 1n << 128n) throw new Error('CETUS_LIQUIDITY_OVERFLOW');
      crossedTicks.push(boundary.tick);
    }
    tick = next === target ? boundary.tick - (aToB ? 1 : 0) : tickAtPrice(next);
  }
  if (remaining || tick < state.lowerTick || tick >= state.upperTick) throw new Error('CETUS_COVERAGE_EXHAUSTED');
  if (output >= 1n << 64n) throw new Error('CETUS_OUTPUT_OVERFLOW');
  return { amountOut: output.toString(), feeAmount: fees.toString(), sqrtPriceAfterX64: price.toString(), liquidityAfter: liquidity.toString(), tickAfter: tick, crossedTicks, steps };
}
