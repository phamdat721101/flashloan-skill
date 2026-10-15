import { digest, uint, type StateIdentity } from './state.js';
import { HORIZONS, FEATURE_REVISION, parseFrame, ns, ratioNumber, type ForwardOutcome, type Horizon, type MicrostructureFrame, type PredictionRecord } from './l2-contracts.js';

const DAY = 86400000000000n;
const DELAY: Record<Horizon,bigint> = { next: 0n,'1m': 60000000000n,'5m': 300000000000n,'15m': 900000000000n };
export interface TrainingExample {
  frame: MicrostructureFrame; outcome: ForwardOutcome;
  shadowEvidence: { source: 'shadow-runtime'; candidateDigest: string; baselineCandidateDigest: string; profitAsset: string } | null;
}
export interface L2Model {
  schemaVersion: '1.0'; modelId: string; featureRevision: string; chain: StateIdentity['chain']; horizon: Horizon;
  trainedThroughNs: string; mean: number[]; scale: number[]; weights: number[][]; temperature: number;
  flatBandBps: number; classFrequency: [number,number,number];
  classMeanMarkoutBps: [number,number,number];
}
export interface EvaluationReport {
  schemaVersion: '1.0'; reportId: string; chain: StateIdentity['chain']; horizon: Horizon; modelId: string;
  datasetDigest: string; folds: Array<{ train: number; calibration: number; test: number }>;
  testCount: number; testDays: number; classCounts: number[]; brier: number; baselineBrier: number;
  brierImprovement95: [number,number]; netImprovement95: [number,number] | null;
  admitted: boolean; reasons: string[];
}
export function frameFeatures(raw: MicrostructureFrame): number[] {
  const f = parseFrame(raw), m = f.metrics;
  const ratios = [m.skew2pct,m.printDecay,m.turnover1h,m.allowanceOverhang,m.bidWithdrawal,m.marketBasis];
  return [...ratios.map(a => a.value === null ? 0 : Math.max(-100,Math.min(100,ratioNumber(a.value)))),...ratios.map(a => a.value === null ? 1 : 0),Math.log1p(m.tradeCount)];
}
function signed(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(value) || value.length > 80) throw new Error('L2_INVALID_SIGNED_VALUE');
  const n = BigInt(value); uint((n < 0n ? -n : n).toString()); return n;
}
export function forwardOutcome(prediction: PredictionRecord,raw: MicrostructureFrame,futureFrames: readonly MicrostructureFrame[]): ForwardOutcome | null {
  const frame = parseFrame(raw);
  if (prediction.frameId !== frame.frameId || prediction.cutoffNs !== frame.receivedTimeNs || !HORIZONS.includes(prediction.horizon)) throw new Error('L2_PREDICTION_BINDING');
  const cutoff = ns(prediction.cutoffNs), target = cutoff+DELAY[prediction.horizon];
  const future = futureFrames.map(parseFrame).filter(f => f.poolId === frame.poolId && f.generation === frame.generation && digest(f.identity) !== digest(frame.identity) && (prediction.horizon === 'next' ? BigInt(f.identity.height) === BigInt(frame.identity.height)+1n : BigInt(f.identity.height) > BigInt(frame.identity.height)) && f.baseAsset === frame.baseAsset && f.quoteAsset === frame.quoteAsset && ns(f.receivedTimeNs) > cutoff && ns(f.quality.windowEndNs) >= target).sort((a,b) => ns(a.quality.windowEndNs) < ns(b.quality.windowEndNs) ? -1 : 1)[0];
  if (!future) return null;
  // A missing multi-minute interval must not silently become a one-minute label.
  if (prediction.horizon !== 'next' && ns(future.quality.windowEndNs)-target > 30000000000n) return null;
  const a = frame.metrics.spot, b = future.metrics.spot;
  const delta = BigInt(b.numerator)*BigInt(a.denominator)-BigInt(a.numerator)*BigInt(b.denominator);
  const denominator = BigInt(a.numerator)*BigInt(b.denominator);
  if (!denominator) throw new Error('L2_ZERO_OUTCOME_PRICE');
  const markoutBps = Number(delta*100000000n/denominator)/10000;
  return { schemaVersion: '1.0',predictionId: prediction.predictionId,frameId: frame.frameId,cutoffNs: prediction.cutoffNs,observedTimeNs: future.quality.windowEndNs,horizon: prediction.horizon,identity: future.identity,price: b,markoutBps,netValueAtoms: null,baselineNetValueAtoms: null,evidence: `frame:${future.frameId}` };
}
function validateExamples(examples: readonly TrainingExample[],chain: StateIdentity['chain'],horizon: Horizon): TrainingExample[] {
  if (!Array.isArray(examples) || !examples.length || examples.length > 100000) throw new Error('L2_DATASET_LIMIT');
  const seen = new Set<string>();
  for (const e of examples) {
    const f = parseFrame(e.frame), o = e.outcome;
    if (!f.quality.complete || f.identity.chain !== chain || o.horizon !== horizon || o.frameId !== f.frameId || o.cutoffNs !== f.receivedTimeNs || ns(o.observedTimeNs) < ns(o.cutoffNs)+DELAY[horizon] || ns(o.observedTimeNs) <= ns(o.cutoffNs) || o.identity.chain !== chain || o.identity.network !== f.identity.network || BigInt(o.identity.height) <= BigInt(f.identity.height) || !o.evidence || !Number.isFinite(o.markoutBps) || seen.has(f.frameId)) throw new Error('L2_INVALID_TRAINING_BINDING');
    if (horizon === 'next' ? BigInt(o.identity.height) !== BigInt(f.identity.height)+1n : ns(o.observedTimeNs)-ns(o.cutoffNs)-DELAY[horizon] > 30000000000n) throw new Error('L2_OUTCOME_HORIZON_MISMATCH');
    const expected = Number((BigInt(o.price.numerator)*BigInt(f.metrics.spot.denominator)-BigInt(f.metrics.spot.numerator)*BigInt(o.price.denominator))*100000000n/(BigInt(f.metrics.spot.numerator)*BigInt(o.price.denominator)))/10000;
    if (expected !== o.markoutBps) throw new Error('L2_OUTCOME_SUBSTITUTION');
    if (o.netValueAtoms !== null) signed(o.netValueAtoms);
    if (o.baselineNetValueAtoms !== null) signed(o.baselineNetValueAtoms);
    if (e.shadowEvidence && (e.shadowEvidence.source !== 'shadow-runtime' || !/^[a-f0-9]{64}$/.test(e.shadowEvidence.candidateDigest) || !/^[a-f0-9]{64}$/.test(e.shadowEvidence.baselineCandidateDigest) || !e.shadowEvidence.profitAsset.startsWith(`${chain}:${f.identity.network}:`))) throw new Error('L2_INVALID_SHADOW_EVIDENCE');
    seen.add(f.frameId);
  }
  return [...examples].sort((a,b) => ns(a.frame.receivedTimeNs) < ns(b.frame.receivedTimeNs) ? -1 : ns(a.frame.receivedTimeNs) > ns(b.frame.receivedTimeNs) ? 1 : a.frame.frameId.localeCompare(b.frame.frameId));
}
const label = (returnBps: number,flat: number) => returnBps < -flat ? 0 : returnBps > flat ? 2 : 1;
function softmax(logits: number[]): [number,number,number] {
  const maximum = Math.max(...logits), exp = logits.map(v => Math.exp(v-maximum)), sum = exp.reduce((a,b) => a+b,0);
  return exp.map(v => v/sum) as [number,number,number];
}
function probabilities(model: L2Model,features: number[]): [number,number,number] {
  const x = [1,...features.map((v,i) => (v-model.mean[i])/model.scale[i])];
  return softmax(model.weights.map(w => w.reduce((s,v,i) => s+v*x[i],0)/model.temperature));
}
export function trainL2Model(examples: readonly TrainingExample[],chain: StateIdentity['chain'],horizon: Horizon,flatBandBps = 10): L2Model {
  if (!['arbitrum','sui'].includes(chain) || !HORIZONS.includes(horizon) || !Number.isFinite(flatBandBps) || flatBandBps <= 0) throw new Error('L2_INVALID_TRAINING_CONFIG');
  const rows = validateExamples(examples,chain,horizon), features = rows.map(e => frameFeatures(e.frame)), dims = features[0].length;
  const mean = Array.from({ length: dims },(_,i) => features.reduce((s,x) => s+x[i],0)/rows.length);
  const scale = mean.map((m,i) => Math.sqrt(features.reduce((s,x) => s+(x[i]-m)**2,0)/rows.length) || 1);
  const weights = Array.from({ length: 3 },() => Array(dims+1).fill(0) as number[]), counts = [1,1,1];
  for (const row of rows) counts[label(row.outcome.markoutBps,flatBandBps)]++;
  const classMeanMarkoutBps = [0,1,2].map(c => { const group = rows.filter(e => label(e.outcome.markoutBps,flatBandBps) === c); return group.length ? group.reduce((s,e) => s+e.outcome.markoutBps,0)/group.length : 0; }) as [number,number,number];
  const model = { schemaVersion: '1.0' as const,featureRevision: FEATURE_REVISION,chain,horizon,trainedThroughNs: rows.reduce((m,e) => ns(e.outcome.observedTimeNs) > m ? ns(e.outcome.observedTimeNs) : m,0n).toString(),mean,scale,weights,temperature: 1,flatBandBps,classFrequency: counts.map(v => v/(rows.length+3)) as [number,number,number],classMeanMarkoutBps };
  for (let epoch = 0; epoch < 200; epoch++) {
    const gradients = weights.map(w => w.map(() => 0));
    for (let r = 0; r < rows.length; r++) {
      const x = [1,...features[r].map((v,i) => (v-mean[i])/scale[i])], p = probabilities({ ...model,modelId: '' },features[r]), y = label(rows[r].outcome.markoutBps,flatBandBps);
      for (let c = 0; c < 3; c++) for (let j = 0; j < x.length; j++) gradients[c][j] += (p[c]-(c === y ? 1 : 0))*x[j];
    }
    for (let c = 0; c < 3; c++) for (let j = 0; j <= dims; j++) weights[c][j] -= 0.05*(gradients[c][j]/rows.length+(j ? 0.001*weights[c][j] : 0));
  }
  return { ...model,modelId: digest(model) };
}
export function predictL2(model: L2Model,raw: MicrostructureFrame): PredictionRecord {
  const frame = parseFrame(raw), { modelId,...body } = model;
  const dims = frameFeatures(frame).length;
  if (modelId !== digest(body) || model.schemaVersion !== '1.0' || model.featureRevision !== frame.featureRevision || model.chain !== frame.identity.chain || !HORIZONS.includes(model.horizon) || ns(frame.receivedTimeNs) <= ns(model.trainedThroughNs) || model.mean.length !== dims || model.mean.some(v => !Number.isFinite(v)) || model.classMeanMarkoutBps.length !== 3 || model.classMeanMarkoutBps.some(v => !Number.isFinite(v)) || model.scale.length !== dims || model.scale.some(v => !Number.isFinite(v) || v <= 0) || model.weights.length !== 3 || model.weights.some(w => w.length !== dims+1 || w.some(v => !Number.isFinite(v))) || !Number.isFinite(model.temperature) || model.temperature <= 0) throw new Error('L2_INVALID_OR_LEAKING_MODEL');
  const p = probabilities(model,frameFeatures(frame));
  const record = { schemaVersion: '1.0' as const,frameId: frame.frameId,modelId,chain: model.chain,poolId: frame.poolId,cutoffNs: frame.receivedTimeNs,horizon: model.horizon,probabilities: p,expectedMarkoutBps: p.reduce((s,v,i) => s+v*model.classMeanMarkoutBps[i],0),admission: 'research' as const,reason: frame.quality.complete ? 'HOLDOUT_AND_SHADOW_ADMISSION_REQUIRED' : 'INCOMPLETE_FRAME' };
  return { ...record,predictionId: digest(record) };
}
const brier = (p: readonly number[],y: number) => p.reduce((s,v,i) => s+(v-(i === y ? 1 : 0))**2,0);
function bootstrap(values: number[]): [number,number] {
  if (!values.length) return [0,0];
  let seed = 1729; const means: number[] = [];
  for (let i = 0; i < 1000; i++) {
    let total = 0;
    for (let j = 0; j < values.length; j++) { seed = seed*48271%2147483647; total += values[seed%values.length]; }
    means.push(total/values.length);
  }
  means.sort((a,b) => a-b); return [means[24],means[974]];
}
/** Expanding 14/21/28-day training windows, then 7-day calibration and test.
 * Outcome overlap is purged by actual observed time, including `next` labels.
 */
export function evaluateL2(examples: readonly TrainingExample[],chain: StateIdentity['chain'],horizon: Horizon): { model: L2Model; report: EvaluationReport } {
  const rows = validateExamples(examples,chain,horizon), start = ns(rows[0].frame.receivedTimeNs), folds: EvaluationReport['folds'] = [];
  const losses: Array<{ day: string; model: number; baselines: number[]; net: number | null }> = [], counts = [0,0,0];
  let finalModel: L2Model | undefined;
  for (const trainDays of [14,21,28]) {
    const trainEnd = start+BigInt(trainDays)*DAY, calibrationEnd = trainEnd+7n*DAY, testEnd = calibrationEnd+7n*DAY;
    const train = rows.filter(e => ns(e.outcome.observedTimeNs) < trainEnd);
    const calibration = rows.filter(e => ns(e.frame.receivedTimeNs) >= trainEnd && ns(e.outcome.observedTimeNs) < calibrationEnd);
    const test = rows.filter(e => ns(e.frame.receivedTimeNs) >= calibrationEnd && ns(e.outcome.observedTimeNs) < testEnd);
    folds.push({ train: train.length,calibration: calibration.length,test: test.length });
    if (!train.length || !calibration.length || !test.length) continue;
    let model = trainL2Model(train,chain,horizon), best = Infinity;
    for (const temperature of [0.5,1,2,4]) {
      const candidate = { ...model,temperature }, loss = calibration.reduce((s,e) => s+brier(probabilities(candidate,frameFeatures(e.frame)),label(e.outcome.markoutBps,model.flatBandBps)),0);
      if (loss < best) { best = loss; model = candidate; }
    }
    model.trainedThroughNs = calibration.reduce((latest,e) => ns(e.outcome.observedTimeNs) > latest ? ns(e.outcome.observedTimeNs) : latest,ns(model.trainedThroughNs)).toString();
    const { modelId: _id,...body } = model; model = { ...body,modelId: digest(body) }; finalModel = model;
    for (const e of test) {
      const y = label(e.outcome.markoutBps,model.flatBandBps), p = predictL2(model,e.frame).probabilities, skew = e.frame.metrics.skew2pct.value;
      const sign = skew ? ratioNumber(skew) : 0;
      // A causal recent-return baseline is unavailable without a previous price;
      // CVD sign is a deliberately simple observable momentum proxy.
      const momentum = BigInt(e.frame.metrics.cvd5mQuoteAtoms), oneHot = (i: number) => [0,0,0].map((_,j) => i === j ? 1 : 0);
      const baselineLoss = [brier(model.classFrequency,y),brier(oneHot(sign < -0.1 ? 0 : sign > 0.1 ? 2 : 1),y),brier(oneHot(momentum < 0n ? 0 : momentum > 0n ? 2 : 1),y)];
      const net = e.shadowEvidence && e.outcome.netValueAtoms !== null && e.outcome.baselineNetValueAtoms !== null ? Number(signed(e.outcome.netValueAtoms)-signed(e.outcome.baselineNetValueAtoms)) : null;
      losses.push({ day: (ns(e.frame.receivedTimeNs)/DAY).toString(),model: brier(p,y),baselines: baselineLoss,net }); counts[y]++;
    }
  }
  if (!finalModel) throw new Error('L2_INSUFFICIENT_CHRONOLOGICAL_DATA');
  const meanLoss = losses.reduce((s,l) => s+l.model,0)/losses.length;
  const baselineMeans = [0,1,2].map(i => losses.reduce((s,l) => s+l.baselines[i],0)/losses.length), baselineIndex = baselineMeans.indexOf(Math.min(...baselineMeans));
  const days = [...new Set(losses.map(l => l.day))];
  const daily = days.map(day => { const group = losses.filter(l => l.day === day); return group.reduce((s,l) => s+l.baselines[baselineIndex]-l.model,0)/group.length; });
  const hasNet = losses.every(l => l.net !== null) && new Set(rows.filter(e => e.shadowEvidence).map(e => e.shadowEvidence!.profitAsset)).size === 1;
  const net = hasNet ? bootstrap(days.map(day => losses.filter(l => l.day === day).reduce((s,l) => s+l.net!,0))) : null;
  const improvement = bootstrap(daily), reasons: string[] = [];
  if (ns(rows.at(-1)!.outcome.observedTimeNs)-start < 42n*DAY) reasons.push('HISTORY_UNDER_42_DAYS');
  if (losses.length < 500 || days.length < 14 || folds.some(f => !f.train || !f.calibration || !f.test)) reasons.push('INSUFFICIENT_HOLDOUT');
  if (counts.some(c => c < 10)) reasons.push('INSUFFICIENT_CLASS_COVERAGE');
  if (improvement[0] <= 0) reasons.push('NO_PREDICTIVE_LIFT');
  if (net === null || net[0] <= 0) reasons.push('NO_INDEPENDENT_NET_BENEFIT');
  const body = { schemaVersion: '1.0' as const,chain,horizon,modelId: finalModel.modelId,datasetDigest: digest(rows),folds,testCount: losses.length,testDays: days.length,classCounts: counts,brier: meanLoss,baselineBrier: baselineMeans[baselineIndex],brierImprovement95: improvement,netImprovement95: net,admitted: reasons.length === 0,reasons };
  return { model: finalModel,report: { ...body,reportId: digest(body) } };
}
