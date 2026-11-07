import { join, resolve } from 'node:path';
import { encodeFunctionData, erc1155Abi, zeroHash, type Hex } from 'viem';
import { effectiveLimits, verifyGrant } from './config.js';
import { date, hash, insist, planHash, policyHash, PredictionError, raw, validate, type ExecutionGrant, type Hash, type Mode, type OrderObservation, type PredictionConfig, type Request, type Result, type TradeIntent, type TradePlan } from './contracts.js';
import { PredictionLedger, positionsFrom, publicOrder, type ChainOperation, type LedgerState } from './ledger.js';
import { LimitlessProvider } from './provider.js';

export class PredictionRuntime {
  readonly config: PredictionConfig;
  constructor(config: PredictionConfig, readonly provider = new LimitlessProvider(config), readonly now: () => number = Date.now) {
    this.config = validate('PredictionConfig', config);
    insist(resolve(config.stateDir) === config.stateDir, 'STATE_DIRECTORY_NOT_ABSOLUTE');
  }
  ledger(mode: Mode): PredictionLedger { return new PredictionLedger(join(this.config.stateDir, this.config.transportProfile), this.config.accountId, mode, this.now); }
  async run(input: unknown): Promise<Result> {
    const request = validate<Request>('CommandRequest', input), { command, payload: p } = request;
    let data: unknown = null, outcome: Result['outcome'] = 'ok';
    try {
      const ledger = this.ledger(p.mode);
      if (command === 'capabilities') data = { kind: 'capabilities', enabled: this.config.enabled, live: this.config.live, chainId: 8453, venue: 'limitless', sdkVersion: '1.3.0', orderTypes: ['FAK', 'GTC'], modes: ['paper', 'assisted', 'autonomous'] };
      else if (command === 'doctor') { data = await this.doctor(p.mode, p.publicOnly ?? true); if (!(data as { ready: boolean }).ready) outcome = 'blocked'; }
      else {
        insist(this.config.enabled || ['positions', 'reconcile', 'cancel', 'halt', 'resume'].includes(command), 'FEATURE_DISABLED');
        if (command === 'markets') data = { kind: 'markets', markets: await this.provider.markets() };
        else if (command === 'market') data = { kind: 'market', market: await this.provider.market(p.marketSlug!) };
        else if (command === 'positions') data = { kind: 'positions', positions: positionsFrom(await ledger.state()) };
        else if (command === 'prepare') data = await ledger.exclusive(() => this.prepare(p.mode, p.intent!, ledger));
        else if (command === 'execute') { data = await ledger.exclusive(() => this.execute(p.mode, p.planHash!, p.grant, ledger)); outcome = this.pending(data) ? 'pending' : 'ok'; }
        else if (command === 'reconcile') { data = await ledger.exclusive(() => this.reconcile(ledger, p.clientOrderId)); outcome = this.pending(data) ? 'pending' : 'ok'; }
        else if (command === 'cancel') { data = await ledger.exclusive(() => this.cancel(p.mode, p.clientOrderId!, p.grant, ledger)); outcome = this.pending(data) ? 'pending' : 'ok'; }
        else if (command === 'halt') data = await ledger.exclusive(async () => { await ledger.append('halt', { reason: p.reason! }); return { kind: 'control', halted: true, reason: p.reason! }; });
        else if (command === 'resume') {
          const g = p.mode === 'paper' ? null : verifyGrant(this.config, p.grant, 'resume', p.mode, this.now());
          await ledger.recoverDeadLock();
          data = await ledger.exclusive(async () => { const s = await ledger.state(); insist(!this.unresolved(s), 'RECOVERY_REQUIRED'); await ledger.append('resume', { grantId: g?.grantId ?? 'paper-local' }); return { kind: 'control', halted: false, reason: g ? 'owner-resumed' : 'paper-resumed' }; });
        }
        else if (command === 'redeem') { data = await ledger.exclusive(() => this.redeem(p.mode, p.marketSlug!, p.grant!, ledger)); outcome = this.pending(data) ? 'pending' : 'ok'; }
        else if (command === 'watch') {
          const until = this.now() + p.durationMs!;
          let wake: (() => void) | undefined;
          const slugs = [...new Set([...(await ledger.state()).orders.values()].filter(o => !['filled', 'cancelled', 'rejected'].includes(o.state)).map(o => o.plan.market.slug))].slice(0, this.config.maxWatchedMarkets);
          const close = this.config.wsHints ? await this.provider.hints(slugs, () => wake?.()) : async () => {};
          try { do {
            data = await ledger.exclusive(() => this.reconcile(ledger)); if (this.now() >= until) break;
            const started = this.now();
            await new Promise<void>(r => { const timer = setTimeout(() => { wake = undefined; r(); }, Math.min(this.config.reconcileIntervalMs, until - this.now())); wake = () => { clearTimeout(timer); wake = undefined; setTimeout(r, Math.min(Math.max(0, 1000 - (this.now() - started)), Math.max(0, until - this.now()))); }; });
          } while (this.now() < until); } finally { await close(); }
          outcome = this.pending(data) ? 'pending' : 'ok';
        }
      }
      return validate('ResultEnvelope', { schemaVersion: 'prediction-result/1', requestId: request.requestId, command, mode: p.mode, outcome, data, errors: [], evidence: [] });
    } catch (error) {
      const code = error instanceof PredictionError ? error.code : 'PREDICTION_OPERATION_FAILED';
      const pending = /UNKNOWN|RECOVERY_REQUIRED|UNCONFIRMED|EVIDENCE_INCOMPLETE/.test(code);
      return validate('ResultEnvelope', { schemaVersion: 'prediction-result/1', requestId: request.requestId, command, mode: p.mode, outcome: pending ? 'pending' : 'blocked', data: null, errors: [{ code, retryable: error instanceof PredictionError && error.retryable, recovery: pending ? 'Reconcile persisted order and transaction identities; do not resubmit.' : 'Review the named gate and prepare a newly authorized request when needed.' }], evidence: [] });
    }
  }
  private pending(data: unknown): boolean {
    const d = data as { kind?: string; status?: string; order?: { submission: string; state: string; settlement: string }; orders?: Array<{ submission: string; state: string; settlement: string }> };
    if (d.kind === 'chain') return d.status === 'pending';
    return [d.order, ...(d.orders ?? [])].filter(Boolean).some(o => o!.submission !== 'acknowledged' || o!.state === 'unknown' || ['delayed', 'matched', 'mined', 'retrying', 'unknown'].includes(o!.settlement));
  }
  private unresolved(s: LedgerState): boolean { return [...s.chain.values()].some(o => o.status === 'pending') || [...s.orders.values()].some(o => ['dispatching', 'acceptance-unknown'].includes(o.submission) || o.settlement === 'unknown'); }
  private liveGate(mode: Mode): asserts mode is 'assisted' | 'autonomous' { insist(mode !== 'paper' && this.config.live && this.config.eligible && this.config.eligibilityEvidence.length > 0, 'LIVE_UNAUTHORIZED'); }
  private async doctor(mode: Mode, publicOnly: boolean): Promise<unknown> {
    const checks: Array<{ code: string; pass: boolean }> = [];
    for (const [code, operation] of [['chain-identity', () => this.provider.chainId()], ['maintenance', () => this.provider.maintenance()], ['public-markets', async () => { insist((await this.provider.markets()).length > 0, 'NO_SUPPORTED_MARKETS'); }]] as const) {
      try { await operation(); checks.push({ code, pass: true }); } catch { checks.push({ code, pass: false }); }
    }
    if (!publicOnly) {
      try { insist(mode !== 'paper' && this.config.allowedMarkets.length > 0, 'LIVE_UNAUTHORIZED'); const m = await this.provider.market(this.config.allowedMarkets[0]); await this.provider.checkPins(m); await this.provider.account(m, mode); checks.push({ code: 'account-and-pins', pass: true }); } catch { checks.push({ code: 'account-and-pins', pass: false }); }
    }
    return { kind: 'doctor', ready: checks.every(c => c.pass), publicOnly, checks };
  }
  private async prepare(mode: Mode, input: TradeIntent, ledger: PredictionLedger): Promise<unknown> {
    const intent = validate<TradeIntent>('TradeIntent', input); insist(intent.accountId === this.config.accountId, 'ACCOUNT_MISMATCH');
    if (mode !== 'paper') { this.liveGate(mode); insist(this.config.allowedMarkets.includes(intent.marketSlug), 'MARKET_UNAUTHORIZED'); }
    const state = await ledger.state(), existing = [...state.plans.values()].find(p => p.intent.intentId === intent.intentId);
    if (existing) { insist(hash('intent', existing.intent) === hash('intent', intent) && existing.mode === mode, 'INTENT_ID_REUSED'); insist(date(existing.validUntil) > this.now(), 'INTENT_EXPIRED_USE_NEW_ID'); return { kind: 'plan', plan: existing }; }
    const market = await this.provider.market(intent.marketSlug); insist(market.slug === intent.marketSlug && market.status === 'open', 'MARKET_NOT_OPEN');
    const account = await this.provider.account(market, mode);
    if (mode === 'paper') this.paperAccount(state, account, market);
    const order = await this.provider.build(intent, market, account), book = await this.provider.book(market, intent.outcome);
    this.checkBook(intent, book);
    const feeReserve = market.feeModel === 'collateral' && market.feeEnabled && !intent.postOnly ? (BigInt(intent.side === 'BUY' ? order.makerAmount : order.takerAmount) * BigInt(market.feeCapBps) + 9999n) / 10000n + 10n : 0n;
    const approvals = await this.provider.approvals(market, intent, order, mode, feeReserve);
    const gas = mode === 'paper' ? 0n : await this.provider.estimate(approvals);
    const body = { schemaVersion: 'prediction-plan/1' as const, mode, policyHash: policyHash(this.config), intent, accountId: this.config.accountId, market, account, order, clientOrderId: hash('client-order', { account: this.config.accountId, intentId: intent.intentId, mode: mode === 'paper' ? 'paper' : 'live' }).slice(7), createdAt: new Date(this.now()).toISOString(), validUntil: new Date(this.now() + this.config.planTtlMs).toISOString(), reserveRaw: (intent.side === 'BUY' ? BigInt(order.makerAmount) + feeReserve : 0n).toString(), feeReserveRaw: feeReserve.toString(), feeAsset: (!market.feeEnabled || intent.postOnly ? 'NONE' : market.feeModel === 'legacy' && intent.side === 'BUY' ? 'SHARES' : 'USDC') as TradePlan['feeAsset'], approvals, estimatedGasUpperRaw: gas.toString() };
    const plan = validate<TradePlan>('TradePlan', { ...body, planHash: planHash(body) }); await ledger.append('plan', plan); return { kind: 'plan', plan };
  }
  private paperAccount(s: LedgerState, a: TradePlan['account'], m: TradePlan['market']): void {
    const positions = positionsFrom(s), cash = [...s.orders.values()].flatMap(o => o.fills).reduce((n, f) => f.side === 'BUY' ? n - raw(f.usdGrossRaw) - raw(f.usdFeeRaw) : n + raw(f.usdGrossRaw) - raw(f.usdFeeRaw), raw(this.config.paperCashRaw)) + s.events.filter(e => e.kind === 'paper-redeemed').reduce((n, e) => n + raw((e.data as { payoutRaw: string }).payoutRaw), 0n);
    insist(cash >= 0n, 'PAPER_CASH_NEGATIVE'); a.usdcRaw = cash.toString(); a.yesRaw = positions.find(p => p.tokenId === m.tokens.yes)?.sharesRaw ?? '0'; a.noRaw = positions.find(p => p.tokenId === m.tokens.no)?.sharesRaw ?? '0';
  }
  private checkBook(i: TradeIntent, b: Awaited<ReturnType<LimitlessProvider['book']>>): void {
    const levels = i.side === 'BUY' ? b.asks : b.bids;
    insist(this.now() - date(b.observedAt) <= this.config.quoteTtlMs, 'STALE_CONTEXT');
    const crosses = levels.some(l => raw(l.sharesRaw) > 0n && (i.side === 'BUY' ? l.pricePpm <= i.limitPricePpm : l.pricePpm >= i.limitPricePpm));
    if (i.orderType === 'FAK') insist(crosses, 'NO_EXECUTABLE_LIQUIDITY');
    if (i.postOnly) insist(!crosses, 'POST_ONLY_WOULD_CROSS');
  }
  private async execute(mode: Mode, id: Hash, grantInput: unknown, ledger: PredictionLedger): Promise<unknown> {
    let state = await ledger.state(); const plan = state.plans.get(id); insist(plan && plan.mode === mode && plan.planHash === planHash(plan) && plan.policyHash === policyHash(this.config), 'PLAN_BINDING_MISMATCH');
    const previous = state.orders.get(plan.clientOrderId);
    if (previous && (previous.submission !== 'reserved' || ['cancelled', 'rejected'].includes(previous.state))) return this.reconcile(ledger, plan.clientOrderId);
    insist(date(plan.validUntil) > this.now() && !state.halted, 'PLAN_EXPIRED_OR_HALTED');
    const grant = mode === 'paper' ? null : verifyGrant(this.config, grantInput, 'trade', mode, this.now(), plan);
    if (previous) {
      insist(hash('reservation-grant', previous.grant) === hash('reservation-grant', grant), 'RESERVATION_AUTHORITY_CHANGED');
      insist(![...state.orders.values()].some(o => o.plan.clientOrderId !== plan.clientOrderId && (['dispatching', 'acceptance-unknown'].includes(o.submission) || o.settlement === 'unknown')), 'RECOVERY_REQUIRED');
    }
    if (mode !== 'paper') { this.liveGate(mode); await this.provider.maintenance(); await this.provider.chainId(); await this.provider.checkPins(plan.market); }
    const fresh = await this.provider.market(plan.market.slug), account = await this.provider.account(fresh, mode);
    const binding = (m: TradePlan['market']) => ({ slug: m.slug, tokens: m.tokens, conditionId: m.conditionId, exchange: m.exchange, adapter: m.adapter, feeModule: m.feeModule, feeModel: m.feeModel, feeEnabled: m.feeEnabled, rulesHash: m.rulesHash, tickPpm: m.tickPpm });
    insist(fresh.status === 'open' && hash('binding', binding(fresh)) === hash('binding', binding(plan.market)), 'MARKET_BINDING_CHANGED');
    insist(account.profileId === plan.account.profileId && (fresh.feeModel === 'collateral' || !fresh.feeEnabled || account.feeRateBps === plan.order.feeRateBps), 'ACCOUNT_OR_FEE_CHANGED');
    if (mode === 'paper') this.paperAccount(state, account, fresh);
    else {
      const held = positionsFrom(state);
      for (const [token, balance] of [[fresh.tokens.yes, account.yesRaw], [fresh.tokens.no, account.noRaw]]) insist((held.find(p => p.tokenId === token)?.sharesRaw ?? '0') === balance, 'POSITION_BALANCE_DRIFT');
    }
    const book = await this.provider.book(fresh, plan.intent.outcome); this.checkBook(plan.intent, book);
    const limits = grant ? effectiveLimits(this.config.limits, grant.limits) : this.config.limits;
    if (!previous) await ledger.reserve(plan, grant, limits, account.usdcRaw, plan.intent.outcome === 'YES' ? account.yesRaw : account.noRaw);
    else await ledger.checkContinuation(plan, limits, account.usdcRaw, plan.intent.outcome === 'YES' ? account.yesRaw : account.noRaw);
    if (mode === 'paper') { await ledger.append('dispatch', { clientOrderId: plan.clientOrderId }); return this.paperFill(plan, ledger, book); }
    const pending = await this.recoverChain(ledger); if (pending) return pending;
    const approvals = await this.provider.approvals(fresh, plan.intent, plan.order, mode, raw(plan.feeReserveRaw));
    if (approvals.length) {
      verifyGrant(this.config, grant, 'approve', mode, this.now(), plan);
      const approved = new Set(plan.approvals.map(a => hash('approval', a)));
      insist(approvals.every(a => approved.has(hash('approval', a))), 'APPROVAL_PLAN_CHANGED');
      return this.chainAction('approve', plan.market.slug, plan.planHash, approvals[0], grant!, mode, ledger);
    }
    // Recheck grants immediately before signing and before dispatch, never after a financial side effect.
    verifyGrant(this.config, grant, 'trade', mode, this.now(), plan);
    const signature = await this.provider.signature(plan);
    verifyGrant(this.config, grant, 'trade', mode, this.now(), plan);
    insist(this.now() - date(book.observedAt) <= this.config.quoteTtlMs, 'STALE_CONTEXT');
    await ledger.append('dispatch', { clientOrderId: plan.clientOrderId });
    try { await this.provider.submit(plan, signature); }
    catch { await ledger.append('unknown', { clientOrderId: plan.clientOrderId }); return { kind: 'order', order: publicOrder((await ledger.state()).orders.get(plan.clientOrderId)!) }; }
    return this.reconcile(ledger, plan.clientOrderId);
  }
  private async paperFill(plan: TradePlan, ledger: PredictionLedger, book: Awaited<ReturnType<LimitlessProvider['book']>>): Promise<unknown> {
    const levels = plan.intent.side === 'BUY' ? book.asks : book.bids;
    const previous = (await ledger.state()).orders.get(plan.clientOrderId)!;
    const identity = hash('paper-fill', { plan: plan.planHash, asks: book.asks, bids: book.bids }).slice(7);
    if (previous.fills.some(f => f.fillId === identity)) return { kind: 'order', order: publicOrder(previous) };
    let remaining = BigInt(plan.order.makerAmount) - previous.fills.reduce((n, f) => n + raw(plan.intent.side === 'BUY' ? f.usdGrossRaw : f.sharesGrossRaw), 0n), usd = 0n, shares = 0n;
    for (const level of levels) {
      if (plan.intent.side === 'BUY' ? level.pricePpm > plan.intent.limitPricePpm : level.pricePpm < plan.intent.limitPricePpm) break;
      const available = raw(level.sharesRaw), p = BigInt(level.pricePpm);
      const take = plan.intent.side === 'BUY' ? (remaining * 1_000_000n / p < available ? remaining * 1_000_000n / p : available) : remaining < available ? remaining : available;
      const cost = take * p / 1_000_000n; if (!take || !cost) continue;
      shares += take; usd += cost; remaining -= plan.intent.side === 'BUY' ? cost : take;
      if (!remaining) break;
    }
    let usdFee = 0n, sharesFee = 0n;
    const { collateralFeeRaw } = await import('./contracts.js');
    if (shares && plan.market.feeEnabled && !plan.intent.postOnly) {
      if (plan.market.feeModel === 'collateral') usdFee = collateralFeeRaw(usd, shares, plan.market.feeCapBps);
      else if (plan.intent.side === 'BUY') sharesFee = (shares * BigInt(plan.market.feeCapBps) + 9999n) / 10000n;
      else usdFee = (usd * BigInt(plan.market.feeCapBps) + 9999n) / 10000n;
    }
    const orderId = `paper-${plan.clientOrderId.slice(0, 32)}`;
    const observation: OrderObservation = { clientOrderId: plan.clientOrderId, orderId, state: plan.intent.orderType === 'FAK' ? remaining ? 'cancelled' : 'filled' : remaining ? shares || previous.fills.length ? 'partially-filled' : 'open' : 'filled', settlement: shares || previous.fills.length ? 'confirmed' : 'none', fills: shares ? [{ fillId: identity, orderId, clientOrderId: plan.clientOrderId, marketSlug: plan.market.slug, tokenId: plan.order.tokenId, side: plan.intent.side, sharesGrossRaw: shares.toString(), sharesFeeRaw: sharesFee.toString(), sharesNetRaw: (shares - sharesFee).toString(), usdGrossRaw: usd.toString(), usdFeeRaw: usdFee.toString(), txHash: zeroHash, blockHash: zeroHash, blockNumber: '0', transactionIndex: 0, logIndex: 0, finality: this.config.finality, occurredAt: new Date(this.now()).toISOString(), fidelity: 'paper' }] : [] };
    await ledger.append('observation', observation); return { kind: 'order', order: publicOrder((await ledger.state()).orders.get(plan.clientOrderId)!) };
  }
  private async reconcile(ledger: PredictionLedger, id?: string): Promise<unknown> {
    const pending = await this.recoverChain(ledger); if (pending) return pending;
    const state = await ledger.state(); if (id) insist(state.orders.has(id), 'ORDER_NOT_FOUND');
    const orders = [...state.orders.values()].filter(o => id ? o.plan.clientOrderId === id : !(o.submission === 'acknowledged' && ['filled', 'cancelled', 'rejected'].includes(o.state) && ['none', 'confirmed', 'failed'].includes(o.settlement)));
    insist(orders.length <= 1000, 'RECONCILIATION_BUDGET');
    for (const order of orders) {
      if (order.plan.mode === 'paper') { if (order.submission !== 'reserved' && ['open', 'partially-filled'].includes(order.state)) await this.paperFill(order.plan, ledger, await this.provider.book(order.plan.market, order.plan.intent.outcome)); continue; }
      if (order.submission === 'reserved') continue;
      if (['filled', 'cancelled', 'rejected'].includes(order.state) && ['none', 'confirmed', 'failed'].includes(order.settlement) && order.submission === 'acknowledged') {
        for (const fill of order.fills) { const receipt = await this.provider.receipt(fill.txHash); insist(receipt && receipt.success && receipt.blockHash === fill.blockHash, 'REORG_DETECTED'); }
        continue;
      }
      try {
        const observation = await this.provider.observe(order.plan);
        await ledger.append('observation', observation);
        // Replay validation happens before another operation can use derived accounting.
        positionsFrom(await ledger.state());
      } catch (error) {
        await ledger.append('unknown', { clientOrderId: order.plan.clientOrderId });
        if (error instanceof PredictionError && /MISMATCH|EXCEEDED|CHANGED|REORG|UNKNOWN$/.test(error.code) && !error.retryable) await ledger.append('halt', { reason: 'reconciliation-evidence-conflict' });
      }
    }
    const latest = await ledger.state(); return id ? { kind: 'order', order: publicOrder(latest.orders.get(id)!) } : { kind: 'orders', orders: [...latest.orders.values()].map(publicOrder) };
  }
  private async cancel(mode: Mode, id: string, supplied: unknown, ledger: PredictionLedger): Promise<unknown> {
    const s = await ledger.state(), order = s.orders.get(id); insist(order && order.plan.mode === mode, 'ORDER_NOT_FOUND');
    if (mode !== 'paper') verifyGrant(this.config, supplied ?? order.grant, 'cancel', mode, this.now(), order.plan, true);
    if (order.submission === 'reserved' || mode === 'paper') {
      await ledger.append('observation', { clientOrderId: id, orderId: order.orderId, state: 'cancelled', settlement: 'none', fills: order.fills });
    } else {
      insist(order.orderId, 'RECOVERY_REQUIRED'); await ledger.append('cancel-request', { clientOrderId: id });
      try { await this.provider.cancel(order.plan, order.orderId); } catch { return { kind: 'order', order: publicOrder((await ledger.state()).orders.get(id)!) }; }
      return this.reconcile(ledger, id);
    }
    return { kind: 'order', order: publicOrder((await ledger.state()).orders.get(id)!) };
  }
  private async chainAction(action: 'approve' | 'redeem', slug: string, id: Hash | null, call: { to: `0x${string}`; data: Hex }, grant: ExecutionGrant, mode: 'assisted' | 'autonomous', ledger: PredictionLedger): Promise<unknown> {
    const s = await ledger.state(); insist(!s.halted && ![...s.chain.values()].some(o => o.status === 'pending'), 'RECOVERY_REQUIRED');
    const limits = effectiveLimits(this.config.limits, grant.limits), day = new Date(this.now()).toISOString().slice(0, 10), used = s.gasByDay.get(day) ?? 0n;
    const remaining = raw(limits.maxGasPerDayRaw) - used;
    let cap = remaining < raw(limits.maxGasPerTxRaw) ? remaining : raw(limits.maxGasPerTxRaw);
    if (id) {
      const plan = s.plans.get(id); insist(plan, 'PLAN_BINDING_MISMATCH');
      const spent = [...s.chain.values()].filter(o => o.planHash === id).reduce((n, o) => n + raw(o.gasUpperRaw), 0n);
      const planRemaining = raw(plan.estimatedGasUpperRaw) - spent;
      if (planRemaining < cap) cap = planRemaining;
    }
    insist(cap > 0n, 'GAS_BUDGET_EXHAUSTED');
    const tx = await this.provider.prepareTransaction(call, cap);
    verifyGrant(this.config, grant, action, mode, this.now(), id ? s.plans.get(id) : undefined);
    const op: ChainOperation = { operationId: hash('chain-operation', { action, txHash: tx.txHash, account: this.config.accountId }), action, planHash: id, marketSlug: slug, nonce: tx.nonce, txHash: tx.txHash, gasUpperRaw: tx.gasUpperRaw, day, status: 'pending', grant, mode };
    await ledger.append('chain-pending', op);
    try { await this.provider.broadcast(tx); } catch { /* Unknown acceptance is durable. No rebroadcast or replacement. */ }
    return { kind: 'chain', operationId: op.operationId, txHash: op.txHash, status: 'pending', action };
  }
  private async recoverChain(ledger: PredictionLedger): Promise<unknown | null> {
    const s = await ledger.state(), op = [...s.chain.values()].find(o => o.status === 'pending' || o.action === 'redeem' && o.status === 'confirmed' && !s.events.some(e => e.kind === 'redeemed' && (e.data as { operationId: Hash }).operationId === o.operationId)); if (!op) return null;
    const receipt = await this.provider.receipt(op.txHash);
    if (!receipt) return { kind: 'chain', operationId: op.operationId, txHash: op.txHash, status: 'pending', action: op.action };
    insist(raw(receipt.gasUsedRaw) <= raw(op.gasUpperRaw), 'GAS_BOUND_EXCEEDED');
    if (op.status === 'pending') await ledger.append('chain-confirmed', { operationId: op.operationId, ...receipt });
    if (!receipt.success) { await ledger.append('halt', { reason: 'chain-transaction-reverted' }); return { kind: 'control', halted: true, reason: 'chain-transaction-reverted' }; }
    if (op.action === 'redeem') {
      const m = await this.provider.market(op.marketSlug), a = await this.provider.account(m, op.mode);
      insist(raw(a.yesRaw) === 0n && raw(a.noRaw) === 0n, 'REDEMPTION_BALANCE_UNCONFIRMED');
      const payoutRaw = await this.provider.redemptionReceived(op.txHash);
      const payouts = await this.provider.tokenPayouts(m, positionsFrom(s));
      insist(payouts.reduce((n, p) => n + raw(p.payoutRaw), 0n) === raw(payoutRaw), 'REDEMPTION_PAYOUT_MISMATCH');
      await ledger.append('redeemed', { marketSlug: op.marketSlug, tokenIds: [m.tokens.yes, m.tokens.no], payoutRaw, payouts, operationId: op.operationId });
    }
    return null;
  }
  private async redeem(mode: Mode, slug: string, input: ExecutionGrant, ledger: PredictionLedger): Promise<unknown> {
    if (mode === 'paper') {
      const state = await ledger.state(); insist(!state.halted && !state.redeemed.has(slug), 'RECOVERY_REQUIRED');
      insist([...state.orders.values()].filter(o => o.plan.market.slug === slug).every(o => ['filled', 'cancelled', 'rejected'].includes(o.state)), 'OPEN_ORDER_BLOCKS_REDEMPTION');
      const market = await this.provider.market(slug); insist(market.status === 'resolved', 'MARKET_NOT_RESOLVED');
      const payouts = await this.provider.tokenPayouts(market, positionsFrom(state));
      await ledger.append('paper-redeemed', { marketSlug: slug, tokenIds: [market.tokens.yes, market.tokens.no], payouts, payoutRaw: payouts.reduce((n, p) => n + raw(p.payoutRaw), 0n).toString() });
      return { kind: 'positions', positions: positionsFrom(await ledger.state()) };
    }
    this.liveGate(mode); const grant = verifyGrant(this.config, input, 'redeem', mode, this.now()); insist(grant.marketSlugs.includes(slug), 'MARKET_UNAUTHORIZED');
    const pending = await this.recoverChain(ledger); if (pending) return pending;
    const state = await ledger.state(); insist(!this.unresolved(state) && !state.redeemed.has(slug), 'RECOVERY_REQUIRED');
    insist([...state.orders.values()].filter(o => o.plan.market.slug === slug).every(o => ['filled', 'cancelled', 'rejected'].includes(o.state)), 'OPEN_ORDER_BLOCKS_REDEMPTION');
    const market = await this.provider.market(slug); insist(market.slug === slug, 'MARKET_BINDING_CHANGED');
    for (const order of state.orders.values()) if (order.plan.market.slug === slug) {
      const identity = (m: TradePlan['market']) => ({ slug: m.slug, conditionId: m.conditionId, tokens: m.tokens, adapter: m.adapter, exchange: m.exchange });
      insist(hash('redemption-market', identity(market)) === hash('redemption-market', identity(order.plan.market)), 'MARKET_BINDING_CHANGED');
    }
    await this.provider.chainId(); await this.provider.checkPins(market);
    const account = await this.provider.account(market, mode), held = positionsFrom(state);
    insist(held.find(p => p.tokenId === market.tokens.yes)?.sharesRaw === account.yesRaw || account.yesRaw === '0', 'POSITION_BALANCE_DRIFT');
    insist(held.find(p => p.tokenId === market.tokens.no)?.sharesRaw === account.noRaw || account.noRaw === '0', 'POSITION_BALANCE_DRIFT');
    try { const call = await this.provider.redemption(market); return this.chainAction('redeem', slug, null, call, grant, mode as 'assisted' | 'autonomous', ledger); }
    catch (e) {
      if (!(e instanceof PredictionError) || e.code !== 'REDEMPTION_APPROVAL_REQUIRED') throw e;
      verifyGrant(this.config, grant, 'approve', mode, this.now()); insist(market.adapter, 'DEPLOYMENT_NOT_APPROVED');
      const { CTF } = await import('./contracts.js');
      return this.chainAction('approve', slug, null, { to: CTF, data: encodeFunctionData({ abi: erc1155Abi, functionName: 'setApprovalForAll', args: [market.adapter, true] }) }, grant, mode as 'assisted' | 'autonomous', ledger);
    }
  }
}
