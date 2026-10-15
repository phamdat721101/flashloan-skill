import { digest, uint } from './state.js';
import { describeLiquidity, parsePoolState, poolPrice, projectPool, type PoolStateEnvelope } from './projection.js';
import { rational, type Rational } from './v2.js';
import { available, unavailable, ns, signedRatio, parseObservation, FEATURE_REVISION, type Availability, type DepthPoint, type MarketObservation, type MicrostructureFrame } from './l2-contracts.js';

const MINUTE = 60000000000n;
const compare = (a: Rational,b: Rational) => BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
const canonical = (o: MarketObservation) => o.status === 'node-confirmed' || o.status === 'checkpoint-certified';

/** Bounded inverse of the existing executable quote, including fee dust and rounding.
 * Coverage failure is an upper bound, never evidence of zero depth.
 */
export function executableDepth(raw: PoolStateEnvelope,bps: number,side: 'bid' | 'ask'): DepthPoint {
  const pool = parsePoolState(raw);
  if (![100,200,500].includes(bps) || !['bid','ask'].includes(side) || pool.stateClass !== 'canonical') throw new Error('L2_INVALID_DEPTH_REQUEST');
  const tokenIn = side === 'bid' ? pool.token0 : pool.token1, tokenOut = side === 'bid' ? pool.token1 : pool.token0;
  const point = { bps,side,inputAsset: tokenIn,outputAsset: tokenOut };
  const spot = poolPrice(pool), target = rational(BigInt(spot.numerator) * BigInt(10000 + (side === 'bid' ? -bps : bps)),BigInt(spot.denominator) * 10000n);
  const snapshotDigest = digest(pool);
  const quote = (amount: bigint) => projectPool(pool,{ schemaVersion: '4.0',snapshotDigest,operationId: 'l2-depth',operationClass: 'hypothetical',tokenIn,amountIn: amount.toString(),maxSteps: 4096 });
  const classify = (amount: bigint): 0 | 1 | 2 => {
    try { const q = quote(amount); return (side === 'bid' ? compare(q.priceAfter,target) <= 0n : compare(q.priceAfter,target) >= 0n) ? 1 : 0; }
    catch (error) {
      if (error instanceof Error && /^(CLMM_COVERAGE_EXHAUSTED|CETUS_COVERAGE_EXHAUSTED|CLMM_STEP_LIMIT|CETUS_STEP_LIMIT|V2_RESERVE_OVERFLOW|CETUS_OUTPUT_OVERFLOW|INTEGER_OUT_OF_RANGE)$/.test(error.message)) return 2;
      throw error;
    }
  };
  let lower = 1n, upper = 1n;
  const maximum = (1n << (pool.state.protocol === 'cetus' ? 64n : 128n)) - 1n;
  while (classify(upper) === 0 && upper < maximum) { lower = upper + 1n; upper = upper > maximum / 2n ? maximum : upper * 2n; }
  while (lower < upper) { const mid = (lower + upper) / 2n; if (classify(mid) === 0) lower = mid + 1n; else upper = mid; }
  if (classify(lower) !== 1) return { ...point,inputAtoms: unavailable('DEPTH_COVERAGE_INCOMPLETE'),outputAtoms: unavailable('DEPTH_COVERAGE_INCOMPLETE'),quoteAtoms: unavailable('DEPTH_COVERAGE_INCOMPLETE') };
  const q = quote(lower);
  return { ...point,inputAtoms: available(q.amountIn),outputAtoms: available(q.amountOut),quoteAtoms: available(side === 'bid' ? q.amountOut : q.amountIn) };
}
function median(values: bigint[]): bigint | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a < b ? -1 : a > b ? 1 : 0), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2n;
}
function skew(depth: DepthPoint[]): Availability<Rational> {
  const bid = depth.find(d => d.side === 'bid' && d.bps === 200)?.quoteAtoms.value;
  const ask = depth.find(d => d.side === 'ask' && d.bps === 200)?.quoteAtoms.value;
  if (bid === null || ask === null || bid === undefined || ask === undefined) return unavailable('DEPTH_COVERAGE_INCOMPLETE');
  const b = BigInt(bid), a = BigInt(ask);
  return b + a ? available(signedRatio(b - a,b + a)) : unavailable('ZERO_DEPTH');
}

export function buildMicrostructureFrame(raw: MarketObservation, rawHistory: readonly MarketObservation[], previous?: MicrostructureFrame): MicrostructureFrame {
  const observation = parseObservation(raw);
  if (observation.payload.kind !== 'pool' && observation.payload.kind !== 'deepbook') throw new Error('L2_STATE_REQUIRED');
  if (!observation.identity || !canonical(observation)) throw new Error('L2_CANONICAL_STATE_REQUIRED');
  if (rawHistory.length > 100000) throw new Error('L2_HISTORY_LIMIT');
  const cutoff = ns(observation.receivedTimeNs), end = ns(observation.eventTimeNs);
  const parsedHistory = rawHistory.map(parseObservation);
  const history = parsedHistory.filter(o => o.poolId === observation.poolId && o.generation === observation.generation && ns(o.receivedTimeNs) <= cutoff && ns(o.eventTimeNs) <= end && canonical(o) && o.identity && BigInt(o.identity.height) <= BigInt(observation.identity!.height));
  if (history.some(o => o.identity?.height === observation.identity!.height && digest(o.identity) !== digest(observation.identity))) throw new Error('L2_DIVERGENT_STATE');
  const trades = history.filter(o => o.payload.kind === 'trade' && ns(o.eventTimeNs) > end - 60n * MINUTE);
  const oldest = history.reduce((a,o) => ns(o.eventTimeNs) < a ? ns(o.eventTimeNs) : a,end);
  const warm = end - oldest >= 60n * MINUTE;
  let baseAsset: string, quoteAsset: string, decimalsBase: number, decimalsQuote: number, spot: Rational, depth: DepthPoint[], reserveQuote: Rational | null;
  if (observation.payload.kind === 'pool') {
    const pool = parsePoolState(observation.payload.pool), description = describeLiquidity(pool);
    baseAsset = pool.token0; quoteAsset = pool.token1; decimalsBase = pool.decimals0; decimalsQuote = pool.decimals1; spot = description.spotPrice;
    depth = [100,200,500].flatMap(bps => (['bid','ask'] as const).map(side => executableDepth(pool,bps,side)));
    reserveQuote = description.actualReserves ? rational(BigInt(description.actualReserves.reserve1),1n) : description.virtualReserves?.token1 ?? null;
  } else {
    const p = observation.payload, book = p.book, nowMs = end / 1000000n;
    baseAsset = p.baseAsset; quoteAsset = p.quoteAsset; decimalsBase = p.decimalsBase; decimalsQuote = p.decimalsQuote;
    const bids = book.bids.filter(o => uint(o.expiresAtMs,64) >= nowMs), asks = book.asks.filter(o => uint(o.expiresAtMs,64) >= nowMs);
    if (!bids.length || !asks.length || BigInt(bids[0].price) >= BigInt(asks[0].price)) throw new Error('L2_EMPTY_OR_CROSSED_BOOK');
    const mid = (BigInt(bids[0].price) + BigInt(asks[0].price)) / 2n;
    spot = rational(mid * 10n ** BigInt(decimalsBase),1000000000n * 10n ** BigInt(decimalsQuote));
    depth = [100,200,500].flatMap(bps => (['bid','ask'] as const).map(side => {
      const orders = side === 'bid' ? bids : asks, target = mid * BigInt(10000 + (side === 'bid' ? -bps : bps));
      const selected = orders.filter(o => side === 'bid' ? BigInt(o.price) * 10000n >= target : BigInt(o.price) * 10000n <= target);
      const base = selected.reduce((s,o) => s + BigInt(o.remainingBase),0n), quote = selected.reduce((s,o) => s + BigInt(o.remainingBase) * BigInt(o.price) / 1000000000n,0n);
      const feeRate = BigInt(book.takerFee)*1250000000n/1000000000n;
      const fee = selected.reduce((s,o) => s+(side === 'bid' ? BigInt(o.remainingBase) : BigInt(o.remainingBase)*BigInt(o.price)/1000000000n)*feeRate/1000000000n,0n);
      const covered = selected.length <= 100;
      return { bps,side,inputAsset: side === 'bid' ? baseAsset : quoteAsset,outputAsset: side === 'bid' ? quoteAsset : baseAsset,inputAtoms: covered ? available(((side === 'bid' ? base : quote)+fee).toString()) : unavailable<string>('BOOK_SCAN_LIMIT'),outputAtoms: covered ? available((side === 'bid' ? quote : base).toString()) : unavailable<string>('BOOK_SCAN_LIMIT'),quoteAtoms: covered ? available((quote+(side === 'ask' ? fee : 0n)).toString()) : unavailable<string>('BOOK_SCAN_LIMIT') };
    }));
    // Book depth has no AMM virtual-reserve denominator.
    reserveQuote = null;
  }
  let volume = 0n, baseVolume = 0n, cvd = 0n;
  const recent: bigint[] = [], baseline: bigint[] = [];
  for (const o of trades) if (o.payload.kind === 'trade') {
    const q = BigInt(o.payload.quoteAtoms), age = end - ns(o.eventTimeNs);
    volume += q; baseVolume += BigInt(o.payload.baseAtoms);
    if (age < 5n * MINUTE) cvd += o.payload.side === 'buy' ? q : -q;
    if (o.payload.side === 'buy') {
      if (age < 3n * MINUTE) recent.push(q);
      else if (age < 13n * MINUTE) baseline.push(q);
    }
  }
  const m = median(recent), b = median(baseline), bookSkew = skew(depth);
  const allowance = new Map<string,{ balance: bigint; routers: Map<string,bigint> }>();
  for (const o of history) if (o.payload.kind === 'allowance' && digest(o.identity) === digest(observation.identity)) {
    const p = o.payload, owner = allowance.get(p.owner) ?? { balance: BigInt(p.balanceAtoms),routers: new Map<string,bigint>() };
    if (owner.balance !== BigInt(p.balanceAtoms)) throw new Error('L2_INCONSISTENT_BALANCE');
    owner.routers.set(p.router,BigInt(p.allowanceAtoms)); allowance.set(p.owner,owner);
  }
  const capacity = [...allowance.values()].reduce((s,o) => { const sum = [...o.routers.values()].reduce((a,b) => a+b,0n); return s + (sum < o.balance ? sum : o.balance); },0n);
  const quoteCapacity = capacity * BigInt(spot.numerator) * 10n ** BigInt(decimalsQuote) / (BigInt(spot.denominator) * 10n ** BigInt(decimalsBase));
  const bid = depth.find(d => d.bps === 200 && d.side === 'bid')!.quoteAtoms.value;
  const priorBid = previous?.poolId === observation.poolId && previous.generation === observation.generation && ns(previous.receivedTimeNs) < cutoff ? previous.metrics.depth.find(d => d.bps === 200 && d.side === 'bid')?.quoteAtoms.value : null;
  const withdrawal: Availability<Rational> = priorBid && bid !== null && BigInt(priorBid) ? available(signedRatio(BigInt(priorBid)-BigInt(bid),BigInt(priorBid))) : unavailable('NO_COMPARABLE_PRIOR');
  const decay: Availability<Rational> = recent.length >= 3 && baseline.length >= 3 && m !== null && b !== null && b > 0n ? available(rational(m,b)) : unavailable('INSUFFICIENT_PRINTS');
  const labels: string[] = [];
  if (bookSkew.value && BigInt(bookSkew.value.numerator) * 2n <= -BigInt(bookSkew.value.denominator)) labels.push('ASK_HEAVY');
  if (decay.value && BigInt(decay.value.numerator) * 100n < BigInt(decay.value.denominator) * 30n) labels.push('BUY_PRINT_DECAY');
  if (withdrawal.value && BigInt(withdrawal.value.numerator) * 100n >= BigInt(withdrawal.value.denominator) * 40n) labels.push('BID_DEPTH_WITHDRAWAL');
  if (allowance.size && bid !== null && BigInt(bid) > 0n && quoteCapacity*100n >= BigInt(bid)*120n) labels.push('ALLOWANCE_CAPACITY_HIGH');
  const turnover = warm && reserveQuote && BigInt(reserveQuote.numerator) ? available(rational(volume * BigInt(reserveQuote.denominator),BigInt(reserveQuote.numerator))) : unavailable<Rational>(warm ? 'NO_RESERVE_DENOMINATOR' : 'WINDOW_WARMUP');
  if (turnover.value && BigInt(turnover.value.numerator) >= 15n*BigInt(turnover.value.denominator)) labels.push('HIGH_TURNOVER');
  const oldPrice = previous?.poolId === observation.poolId && previous.generation === observation.generation ? previous.metrics.spot : null;
  if (cvd > 0n && oldPrice && compare(spot,oldPrice) <= 0n) labels.push('BUY_FLOW_LOW_IMPACT');
  const recentPrice = (minutes: bigint) => history.filter(o => o.payload.kind === 'pool' && ns(o.eventTimeNs) <= end-minutes*MINUTE).at(-1);
  const p3 = recentPrice(3n), p15 = recentPrice(15n);
  const vwap = baseVolume ? available(rational(volume * 10n ** BigInt(decimalsBase),baseVolume * 10n ** BigInt(decimalsQuote))) : unavailable<Rational>('NO_TRADES');
  const bounceVolume = trades.filter(o => ns(o.eventTimeNs) > end-3n*MINUTE).reduce((s,o) => s+BigInt(o.payload.kind === 'trade' ? o.payload.quoteAtoms : '0'),0n);
  const dropVolume = trades.filter(o => ns(o.eventTimeNs) > end-6n*MINUTE && ns(o.eventTimeNs) <= end-3n*MINUTE).reduce((s,o) => s+BigInt(o.payload.kind === 'trade' ? o.payload.quoteAtoms : '0'),0n);
  if (p3?.payload.kind === 'pool' && p15?.payload.kind === 'pool' && compare(spot,poolPrice(p3.payload.pool)) > 0n && compare(spot,poolPrice(p15.payload.pool)) < 0n && vwap.value && compare(spot,vwap.value) < 0n && dropVolume > 0n && bounceVolume*100n <= dropVolume*35n) labels.push('WEAK_REBOUND');
  const market = parsedHistory.filter(o => o.poolId === observation.poolId && o.status === 'external' && o.payload.kind === 'market-book' && o.payload.baseAsset === baseAsset && o.payload.quoteAsset === quoteAsset && ns(o.receivedTimeNs) <= cutoff && cutoff-ns(o.receivedTimeNs) <= 2000000000n && cutoff-ns(o.eventTimeNs) <= 2000000000n).sort((a,b) => ns(a.receivedTimeNs) > ns(b.receivedTimeNs) ? -1 : 1)[0];
  let marketBasis: Availability<Rational> = unavailable('MARKET_FEED_UNAVAILABLE');
  if (market?.payload.kind === 'market-book' && market.payload.bids.length && market.payload.asks.length) {
    const bidPrice = BigInt(market.payload.bids[0].price), askPrice = BigInt(market.payload.asks[0].price);
    if (bidPrice >= askPrice) throw new Error('L2_CROSSED_MARKET_BOOK');
    const mid = bidPrice+askPrice;
    marketBasis = available(signedRatio(mid*BigInt(spot.denominator)-2000000000n*BigInt(spot.numerator),2000000000n*BigInt(spot.numerator)));
  }
  const flowComplete = observation.payload.flowComplete && history.every(o => ns(o.eventTimeNs) <= end-60n*MINUTE || !['pool','deepbook'].includes(o.payload.kind) || ('flowComplete' in o.payload && o.payload.flowComplete));
  const reasons = [...(!warm ? ['WINDOW_WARMUP'] : []),...(!flowComplete ? ['FLOW_COVERAGE_INCOMPLETE'] : []),...(!depth.every(d => d.quoteAtoms.value !== null) ? ['DEPTH_COVERAGE_INCOMPLETE'] : [])];
  const watermarks: Record<string,string> = {};
  for (const o of [...history,observation,...(market ? [market] : [])]) if (watermarks[o.sourceId] === undefined || BigInt(o.cursor) > BigInt(watermarks[o.sourceId])) watermarks[o.sourceId] = o.cursor;
  const body: Omit<MicrostructureFrame,'frameId'> = {
    schemaVersion: '1.0',featureRevision: FEATURE_REVISION,generation: observation.generation,poolId: observation.poolId,identity: observation.identity,
    stateDigest: digest(observation.payload),receivedTimeNs: observation.receivedTimeNs,baseAsset,quoteAsset,decimalsBase,decimalsQuote,
    evidence: [...new Set([...history.map(o => o.evidence),observation.evidence,...(market ? [market.evidence] : [])])].sort(),watermarks,labels,
    metrics: { spot,depth,skew2pct: bookSkew,volume1hQuoteAtoms: volume.toString(),cvd5mQuoteAtoms: cvd.toString(),tradeCount: trades.length,
      vwap1h: vwap,
      printDecay: decay,printCounts: { recent: recent.length,baseline: baseline.length },turnover1h: turnover,
      allowanceCapacityQuoteAtoms: allowance.size ? available(quoteCapacity.toString()) : unavailable('ALLOWANCE_COVERAGE_UNAVAILABLE'),
      allowanceOverhang: allowance.size && bid !== null && BigInt(bid) ? available(rational(quoteCapacity,BigInt(bid))) : unavailable('ALLOWANCE_OR_DEPTH_UNAVAILABLE'),bidWithdrawal: withdrawal,marketBasis,marketSource: market?.sourceId ?? null },
    quality: { complete: reasons.length === 0,reasons,windowStartNs: (end >= 60n * MINUTE ? end-60n * MINUTE : 0n).toString(),windowEndNs: end.toString() }
  };
  return { ...body,frameId: digest(body) };
}
