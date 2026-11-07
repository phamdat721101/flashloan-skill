import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createPublicClient, decodeEventLog, encodeFunctionData, erc20Abi, erc1155Abi, hashTypedData, http, keccak256, parseAbi, parseEventLogs, serializeTransaction, zeroAddress, zeroHash, type Address, type Hex, type TypedData, type PublicClient, type Transport } from 'viem';
import { base } from 'viem/chains';
import { addr, BASE_CHAIN_ID, CTF, date, hash, insist, PredictionError, raw, SDK_VERSION, sdkNumber, USDC, validate, type AccountSnapshot, type ApprovalCall, type Evidence, type FillRecord, type MarketSnapshot, type Mode, type OrderObservation, type PredictionConfig, type TradeIntent, type TradePlan, type UnsignedOrder } from './contracts.js';
import { endpoint, hmacSecrets, loadTradingAccount } from './config.js';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => { insist(v && typeof v === 'object' && !Array.isArray(v), 'PROVIDER_SCHEMA_UNSUPPORTED'); return v as Obj; };
const list = (v: unknown): unknown[] => { insist(Array.isArray(v) && v.length <= 10000, 'PROVIDER_SCHEMA_UNSUPPORTED'); return v; };
const string = (v: unknown): string => { insist(typeof v === 'string', 'PROVIDER_SCHEMA_UNSUPPORTED'); return v; };
const number = (v: unknown): number => { insist(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0, 'PROVIDER_SCHEMA_UNSUPPORTED'); return v; };
const bytes32 = (v: unknown): Hex => { const s = string(v); insist(/^0x[a-fA-F0-9]{64}$/.test(s), 'PROVIDER_SCHEMA_UNSUPPORTED'); return s as Hex; };
const numericId = (v: unknown) => typeof v === 'number' ? String(number(v)) : string(v);
const rawSize = (v: unknown): string => {
  const value = typeof v === 'number' ? String(number(v)) : string(v);
  insist(raw(value) <= (1n << 256n) - 1n, 'PROVIDER_UNITS_UNKNOWN');
  return value;
};
const sourceHash = (v: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}` as const;
const six = (v: unknown): bigint => {
  insist(typeof v === 'number' || typeof v === 'string', 'PROVIDER_UNITS_UNKNOWN');
  const s = String(v); insist(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(s), 'PROVIDER_UNITS_UNKNOWN');
  const [a, b = ''] = s.split('.'); return BigInt(a) * 1_000_000n + BigInt(b.padEnd(6, '0'));
};
const redemptionAbi = parseAbi(['function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)', 'function payoutDenominator(bytes32 conditionId) view returns (uint256)', 'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)']);
const negRiskAbi = parseAbi(['function redeemPositions(bytes32 conditionId, uint256[] amounts)']);
const feeOracleAbi = parseAbi(['function getL1Fee(bytes) view returns (uint256)', 'function getOperatorFee(uint256) view returns (uint256)']);
const feeOracle = '0x420000000000000000000000000000000000000F' as const;
const fillAbi = parseAbi(['event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)']);
export const ORDER_TYPES = { Order: [{ name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' }, { name: 'taker', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'makerAmount', type: 'uint256' }, { name: 'takerAmount', type: 'uint256' }, { name: 'expiration', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'feeRateBps', type: 'uint256' }, { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' }] } as const;
export const orderDomain = (m: MarketSnapshot) => ({ name: 'Limitless CTF Exchange', version: '1', chainId: BASE_CHAIN_ID, verifyingContract: m.exchange });
export function orderDigest(plan: TradePlan): Hex { const { price: _, ...order } = plan.order; return hashTypedData({ domain: orderDomain(plan.market), types: ORDER_TYPES, primaryType: 'Order', message: order as never }); }
interface SdkHttp {
  clearApiKey(): void;
  get<T = unknown>(path: string, config?: Obj): Promise<T>;
  post<T = unknown>(path: string, data?: unknown, config?: Obj): Promise<T>;
  delete<T = unknown>(path: string, config?: Obj): Promise<T>;
}
interface Sdk {
  HttpClient: new (config: Obj) => SdkHttp;
  OrderBuilder: new (maker: string, fee: number, tick: number) => { buildOrder(args: Obj): UnsignedOrder };
  OrderSigner: new (wallet: Obj) => { signOrder(order: UnsignedOrder, config: { chainId: number; contractAddress: string }): Promise<string> };
  WebSocketClient: new (config: Obj) => { connect(): Promise<void>; disconnect(): Promise<void>; on(event: string, callback: (...args: unknown[]) => void): unknown; subscribe(channel: string, options: Obj): Promise<void> };
}
let cachedSdk: Promise<Sdk> | undefined;
export function loadSdk(): Promise<Sdk> {
  return cachedSdk ??= (async () => {
    try {
      const name = '@limitless-exchange/sdk';
      const resolved = createRequire(import.meta.url).resolve(name);
      const p = JSON.parse(await readFile(join(dirname(resolved), '..', 'package.json'), 'utf8'));
      insist(p.version === SDK_VERSION, 'SDK_VERSION_MISMATCH');
      const sdk = await import(name) as Sdk;
      insist(typeof sdk.OrderBuilder === 'function' && typeof sdk.OrderSigner === 'function' && typeof sdk.HttpClient === 'function', 'SDK_INTERFACE_MISMATCH');
      return sdk;
    } catch (e) { if (e instanceof PredictionError) throw e; throw new PredictionError('DEPENDENCY_UNAVAILABLE'); }
  })();
}
export interface Book { observedAt: string; asks: Array<{ pricePpm: number; sharesRaw: string }>; bids: Array<{ pricePpm: number; sharesRaw: string }>; minRewardSharesRaw: string }
export interface PreparedTransaction { serialized: Hex; txHash: Hex; nonce: string; gasUpperRaw: string }

/** Public SDK primitives only; credentials/signatures never cross the result boundary. */
export class LimitlessProvider {
  private publicHttp?: Promise<SdkHttp>;
  private privateHttp?: Promise<SdkHttp>;
  readonly rpc: PublicClient<Transport, typeof base>;
  private nextRpcId = 0;
  constructor(readonly config: PredictionConfig, readonly now: () => number = Date.now) {
    endpoint(config.apiUrl, config.transportProfile, 'api.limitless.exchange'); endpoint(config.rpcUrl, config.transportProfile);
    this.rpc = createPublicClient({ chain: base, transport: http(config.rpcUrl, { retryCount: 0, timeout: 10000, fetchOptions: { redirect: 'error' } }) });
  }
  private client(auth: boolean): Promise<SdkHttp> {
    const key = auth ? 'privateHttp' : 'publicHttp';
    return this[key] ??= loadSdk().then(sdk => {
      const credentials = auth ? hmacSecrets(this.config) : undefined;
      const c = new sdk.HttpClient({ baseURL: this.config.apiUrl, timeout: 10000, ...(credentials ? { hmacCredentials: { tokenId: credentials.tokenId, secret: credentials.tokenSecret } } : {}) });
      c.clearApiKey(); // Explicitly suppress the SDK's ambient legacy-key fallback, including public reads.
      return c;
    });
  }
  private options(): Obj { return { timeout: 10000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024, maxBodyLength: 2 * 1024 * 1024 }; }
  async request(method: 'get' | 'post' | 'delete', path: string, body?: unknown, auth = false, readOnly = false): Promise<unknown> {
    insist(path.startsWith('/') && !path.startsWith('//') && !/[\r\n]/.test(path), 'TRANSPORT_INVALID');
    const client = await this.client(auth), attempts = method === 'get' || readOnly ? 3 : 1;
    for (let i = 0; ; i++) {
      try { return method === 'post' ? await client.post(path, body, this.options()) : method === 'get' ? await client.get(path, this.options()) : await client.delete(path, this.options()); }
      catch (error) {
        const status = Number((error as { status?: unknown }).status ?? 0);
        if (i + 1 < attempts && (status === 429 || status >= 500 || status === 0)) { await new Promise(r => setTimeout(r, 100 * 2 ** i)); continue; }
        throw new PredictionError(status ? `PROVIDER_HTTP_${status}` : 'PROVIDER_TRANSPORT_UNKNOWN', attempts > 1 && (status === 429 || status >= 500 || status === 0));
      }
    }
  }
  async chainId(): Promise<void> { insist(await this.rpc.getChainId() === BASE_CHAIN_ID, 'WRONG_CHAIN'); }
  async hints(slugs: string[], changed: () => void): Promise<() => Promise<void>> {
    endpoint(this.config.wsUrl, this.config.transportProfile, 'ws.limitless.exchange');
    insist(slugs.length <= this.config.maxWatchedMarkets && !Object.hasOwn(process.env, 'LIMITLESS_API_KEY'), 'WS_CONFIGURATION_INVALID');
    const sdk = await loadSdk(), ws = new sdk.WebSocketClient({ url: this.config.wsUrl, autoReconnect: true, maxReconnectAttempts: 3, timeout: 3000 });
    for (const event of ['orderbookUpdate', 'marketResolved', 'disconnect', 'error']) ws.on(event, changed);
    try { await ws.connect(); await ws.subscribe('subscribe_market_prices', { marketSlugs: slugs }); } catch { changed(); await ws.disconnect(); }
    return () => ws.disconnect();
  }
  evidence(source: string, value: unknown): Evidence { return { source, observedAt: new Date(this.now()).toISOString(), hash: sourceHash(value), fidelity: this.config.transportProfile === 'fixture' ? 'fixture' : 'provider' }; }
  async maintenance(): Promise<void> {
    const r = object(await this.request('get', '/maintenance/status'));
    // Any active effect blocks placement; unknown representations fail closed.
    insist(list(r.active).length === 0 && Array.isArray(r.scheduled), 'TRADING_RESTRICTED');
  }
  async markets(): Promise<MarketSnapshot[]> {
    const r = object(await this.request('get', '/markets/active?limit=20'));
    return list(r.data).slice(0, 20).flatMap(v => { try { return [this.normalizeMarket(v)]; } catch { return []; } });
  }
  async market(slug: string): Promise<MarketSnapshot> { return this.normalizeMarket(await this.request('get', `/markets/${encodeURIComponent(slug)}`)); }
  private normalizeMarket(value: unknown): MarketSnapshot {
    const r = object(value), collateral = object(r.collateralToken), venue = object(r.venue), tokens = object(r.tokens), metadata = object(r.metadata);
    insist(r.tradeType === 'clob' && r.marketType !== 'group', 'MARKET_TYPE_UNSUPPORTED');
    insist(addr(string(collateral.address)) === USDC && collateral.decimals === 6, 'COLLATERAL_UNSUPPORTED');
    const status = string(r.status); insist(['FUNDED', 'RESOLVED', 'CLOSED', 'EXPIRED'].includes(status), 'MARKET_STATUS_UNKNOWN');
    const feeModel = venue.feeModuleType === 'COLLATERAL' ? 'collateral' : 'legacy';
    insist(venue.feeModuleType === undefined || venue.feeModuleType === null || venue.feeModuleType === 'COLLATERAL', 'FEE_PROGRAM_UNKNOWN');
    const tick = r.priceTick === undefined ? 1000 : Number(six(r.priceTick));
    insist(tick > 0 && 1_000_000 % tick === 0 && typeof metadata.fee === 'boolean', 'PROVIDER_SCHEMA_UNSUPPORTED');
    const yes = string(tokens.yes), no = string(tokens.no); raw(yes); raw(no); insist(yes !== no && raw(yes) > 0n && raw(no) > 0n, 'OUTCOME_TOKEN_MISMATCH');
    const body = {
      schemaVersion: 'prediction-market/1' as const, marketId: numericId(r.id), slug: string(r.slug), conditionId: bytes32(r.conditionId), chainId: 8453 as const,
      type: (venue.adapter ? 'negrisk' : 'binary') as MarketSnapshot['type'], status: (status === 'RESOLVED' ? 'resolved' : status !== 'FUNDED' || r.expired === true || Number(r.expirationTimestamp) <= this.now() ? 'closed' : 'open') as MarketSnapshot['status'],
      tokens: { yes, no }, exchange: addr(string(venue.exchange)), adapter: venue.adapter ? addr(string(venue.adapter)) : null,
      feeModule: feeModel === 'collateral' ? addr(string(venue.feeModule)) : null, feeModel: feeModel as MarketSnapshot['feeModel'], feeEnabled: metadata.fee,
      tickPpm: tick, sizeStepRaw: String(1_000_000 / tick), feeRateBps: 0, feeCapBps: metadata.fee ? feeModel === 'collateral' ? 500 : 300 : 0,
      rulesHash: hash('rules', { description: typeof r.description === 'string' ? r.description : '', expirationTimestamp: number(r.expirationTimestamp), conditionId: string(r.conditionId) }),
      observedAt: new Date(this.now()).toISOString(), evidence: [this.evidence(`${this.config.apiUrl}/markets/${encodeURIComponent(string(r.slug))}`, value)]
    };
    return validate('MarketSnapshot', { ...body, snapshotId: hash('market', body) });
  }
  async account(market: MarketSnapshot, mode: Mode): Promise<AccountSnapshot> {
    if (mode === 'paper') return { schemaVersion: 'prediction-account/1', accountId: this.config.accountId, address: this.config.address, profileId: 0, mode: 'eoa', usdcRaw: this.config.paperCashRaw, yesRaw: '0', noRaw: '0', feeRateBps: market.feeCapBps, observedAt: new Date(this.now()).toISOString(), blockHash: zeroHash, blockNumber: '0' };
    await this.chainId();
    const p = object(await this.request('get', '/profiles/me', undefined, true));
    insist(addr(string(p.account)) === this.config.address && p.tradeWalletOption === 'eoa', 'WALLET_MODE_MISMATCH');
    const rank = p.rank ? object(p.rank) : {};
    const fee = number(p.effectiveFeeRateBps ?? rank.feeRateBps);
    const block = await this.rpc.getBlock({ blockTag: this.config.finality }); insist(block.hash, 'FINALITY_UNAVAILABLE');
    const [usdc, yes, no] = await this.readBounded([
      () => this.rpc.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [this.config.address], blockNumber: block.number }),
      () => this.rpc.readContract({ address: CTF, abi: erc1155Abi, functionName: 'balanceOf', args: [this.config.address, BigInt(market.tokens.yes)], blockNumber: block.number }),
      () => this.rpc.readContract({ address: CTF, abi: erc1155Abi, functionName: 'balanceOf', args: [this.config.address, BigInt(market.tokens.no)], blockNumber: block.number })
    ]);
    return validate('AccountSnapshot', { schemaVersion: 'prediction-account/1', accountId: this.config.accountId, address: this.config.address, profileId: number(p.id), mode: 'eoa', usdcRaw: usdc.toString(), yesRaw: yes.toString(), noRaw: no.toString(), feeRateBps: fee, observedAt: new Date(this.now()).toISOString(), blockHash: block.hash, blockNumber: block.number.toString() });
  }
  async book(market: MarketSnapshot, outcome: 'YES' | 'NO'): Promise<Book> {
    const b = object(await this.request('get', `/markets/${encodeURIComponent(market.slug)}/orderbook`));
    insist(b.tokenId === market.tokens.yes, 'ORDERBOOK_TOKEN_MISMATCH');
    const levels = (input: unknown, complement: boolean) => list(input).map(v => { const r = object(v), p = Number(six(r.price)); insist(p > 0 && p < 1e6, 'ORDERBOOK_PRICE_INVALID'); return { pricePpm: complement ? 1_000_000 - p : p, sharesRaw: rawSize(r.size) }; });
    const asks = levels(outcome === 'YES' ? b.asks : b.bids, outcome === 'NO').sort((a, c) => a.pricePpm - c.pricePpm), bids = levels(outcome === 'YES' ? b.bids : b.asks, outcome === 'NO').sort((a, c) => c.pricePpm - a.pricePpm);
    // REST sizes are already six-decimal token units. minSize governs LP rewards,
    // not admission of smaller trades. Only prices need decimal conversion.
    return { observedAt: new Date(this.now()).toISOString(), asks, bids, minRewardSharesRaw: rawSize(b.minSize) };
  }
  async checkPins(market: MarketSnapshot): Promise<void> {
    const required = [[USDC, 'usdc'], [CTF, 'ctf'], [market.exchange, 'exchange'], ...(market.adapter ? [[market.adapter, 'adapter']] : []), ...(market.feeModule ? [[market.feeModule, 'feeModule']] : [])] as Array<[Address, string]>;
    for (const [address, role] of required) {
      const pin = this.config.pins.find(p => p.address === address && p.role === role); insist(pin, 'DEPLOYMENT_NOT_APPROVED');
      const code = await this.rpc.getCode({ address }); insist(code && code !== '0x' && keccak256(code) === pin.codeHash, 'DEPLOYMENT_CODE_DRIFT');
    }
  }
  async approvals(m: MarketSnapshot, intent: TradeIntent, order: UnsignedOrder, mode: Mode, feeReserve: bigint): Promise<ApprovalCall[]> {
    const calls: ApprovalCall[] = [];
    const erc20 = async (spender: Address, amount: bigint) => {
      const current = mode === 'paper' ? amount : await this.rpc.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [this.config.address, spender] });
      if (current < amount) calls.push({ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }), value: '0x0', permission: 'erc20-bounded', spender, amountRaw: amount.toString() });
    };
    const operator = async (spender: Address) => {
      const current = mode === 'paper' || await this.rpc.readContract({ address: CTF, abi: erc1155Abi, functionName: 'isApprovedForAll', args: [this.config.address, spender] });
      if (!current) calls.push({ to: CTF, data: encodeFunctionData({ abi: erc1155Abi, functionName: 'setApprovalForAll', args: [spender, true] }), value: '0x0', permission: 'erc1155-operator', spender, amountRaw: '0' });
    };
    if (intent.side === 'BUY') await erc20(m.exchange, BigInt(order.makerAmount)); else { await operator(m.exchange); if (m.adapter) await operator(m.adapter); }
    if (m.feeModule && !intent.postOnly) await erc20(m.feeModule, intent.side === 'BUY' ? feeReserve : BigInt(order.takerAmount) * BigInt(m.feeCapBps) / 10000n + 10n);
    return calls;
  }
  async build(intent: TradeIntent, market: MarketSnapshot, account: AccountSnapshot): Promise<UnsignedOrder> {
    const sdk = await loadSdk(); insist(intent.limitPricePpm % market.tickPpm === 0, 'PRICE_TICK_INVALID');
    let shares: bigint;
    if (intent.orderType === 'FAK' && intent.side === 'BUY') {
      const cap = raw(intent.spendCapRaw!); shares = cap * 1_000_000n / BigInt(intent.limitPricePpm);
      insist(shares * BigInt(intent.limitPricePpm) === cap * 1_000_000n, 'AMOUNT_ALIGNMENT_REQUIRED');
    } else shares = raw(intent.orderType === 'GTC' ? intent.sharesRaw! : intent.sharesCapRaw!);
    insist(shares > 0n && shares % raw(market.sizeStepRaw) === 0n, 'SIZE_STEP_INVALID');
    const fee = market.feeModel === 'collateral' || !market.feeEnabled ? 0 : account.feeRateBps;
    const built = new sdk.OrderBuilder(this.config.address, fee, market.tickPpm / 1e6).buildOrder({ tokenId: intent.outcome === 'YES' ? market.tokens.yes : market.tokens.no, price: intent.limitPricePpm / 1e6, size: sdkNumber(shares.toString()), side: intent.side === 'BUY' ? 0 : 1, expiration: '0', nonce: 0 });
    const { price: _, ...order } = built;
    order.salt = randomBytes(6).readUIntBE(0, 6) || 1;
    const collateral = intent.side === 'BUY' ? (shares * BigInt(intent.limitPricePpm) + 999999n) / 1000000n : shares * BigInt(intent.limitPricePpm) / 1000000n;
    insist(BigInt(order.makerAmount) === (intent.side === 'BUY' ? collateral : shares) && BigInt(order.takerAmount) === (intent.side === 'BUY' ? shares : collateral), 'SDK_AMOUNT_MISMATCH');
    if (intent.orderType === 'FAK' && intent.side === 'BUY') insist(BigInt(order.makerAmount) <= raw(intent.spendCapRaw!), 'SDK_AMOUNT_MISMATCH');
    return validate('UnsignedOrder', order);
  }
  async signature(plan: TradePlan): Promise<string> {
    const sdk = await loadSdk(), account = await loadTradingAccount(this.config);
    const wallet = { address: account.address, getAddress: async () => account.address, signTypedData: async (domain: unknown, types: unknown, message: unknown) => account.signTypedData({ domain, types, primaryType: 'Order', message } as never) };
    return new sdk.OrderSigner(wallet).signOrder(plan.order, { chainId: BASE_CHAIN_ID, contractAddress: plan.market.exchange });
  }
  async submit(plan: TradePlan, signature: string): Promise<unknown> {
    return this.request('post', '/orders', { order: { ...plan.order, price: plan.intent.limitPricePpm / 1e6, signature }, ownerId: plan.account.profileId, orderType: plan.intent.orderType, marketSlug: plan.market.slug, clientOrderId: plan.clientOrderId, timestamp: this.now(), recvWindow: 5000, stpPolicy: 'cancel_taker', ...(plan.intent.orderType === 'GTC' ? { postOnly: plan.intent.postOnly } : {}) }, true);
  }
  async cancel(plan: TradePlan, orderId: string): Promise<void> { await this.request('delete', `/orders/${encodeURIComponent(orderId)}`, undefined, true); }
  async observe(plan: TradePlan): Promise<OrderObservation> {
    const response = object(await this.request('post', '/orders/status/batch', { orders: [{ clientOrderId: plan.clientOrderId }] }, true, true));
    const rows = list(response.results); insist(rows.length === 1, 'ORDER_STATUS_INCOMPLETE'); const row = object(rows[0]);
    if (row.status === 'not_found') return { clientOrderId: plan.clientOrderId, orderId: null, state: 'unknown', settlement: 'unknown', fills: [] };
    insist(row.status === 'found' && row.clientOrderId === plan.clientOrderId, 'ORDER_STATUS_INCOMPLETE');
    const data = object(row.data), order = object(data.order), execution = object(data.execution);
    insist(addr(string(order.maker)) === this.config.address && string(order.tokenId) === plan.order.tokenId && String(order.salt) === String(plan.order.salt) && number(order.ownerId) === plan.account.profileId, 'ORDER_BINDING_MISMATCH');
    const status = string(execution.settlementStatus), statuses: Record<string, OrderObservation['settlement']> = { UNMATCHED: 'none', MATCHED: 'matched', MINED: 'mined', CONFIRMED: 'confirmed', RETRYING: 'retrying', FAILED: 'failed', DELAYED: 'delayed', CANCELED: 'none' };
    insist(Object.hasOwn(statuses, status), 'PROVIDER_STATUS_UNKNOWN');
    const orderId = string(order.id), fills = await this.historyFills(plan, orderId, execution);
    const filled = fills.reduce((n, f) => n + raw(plan.intent.side === 'BUY' ? f.usdGrossRaw : f.sharesGrossRaw), 0n);
    const cancelled = order.status === 'CANCELED' || status === 'CANCELED';
    let state: OrderObservation['state'] = cancelled ? 'cancelled' : filled >= BigInt(plan.order.makerAmount) ? 'filled' : filled ? 'partially-filled' : 'open';
    if (plan.intent.orderType === 'FAK' && ['MINED', 'CONFIRMED', 'UNMATCHED'].includes(status)) state = filled >= BigInt(plan.order.makerAmount) ? 'filled' : 'cancelled';
    return validate('OrderObservation', { clientOrderId: plan.clientOrderId, orderId, state, settlement: statuses[status], fills });
  }
  private async historyFills(plan: TradePlan, orderId: string, execution: Obj): Promise<FillRecord[]> {
    const txs = new Set<Hex>(); if (execution.txHash) txs.add(bytes32(execution.txHash));
    let cursor: string | null = null, covered = false;
    // Unlike /portfolio/trades (AMM-only), history includes CLOB fills. Bound pagination and fail closed on gaps.
    for (let page = 0; page < 20; page++) {
      const response = object(await this.request('get', `/portfolio/history?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, undefined, true));
      const rows = list(response.data);
      for (const v of rows) { const r = object(v); const time = number(r.blockTimestamp) * 1000; if (time < date(plan.createdAt) - 60_000) covered = true; if (r.market && object(r.market).slug === plan.market.slug && /^(Buy|Sell|Limit Buy|Limit Sell|Market Buy|Market Sell)$/.test(String(r.strategy)) && time >= date(plan.createdAt) - 60_000) txs.add(bytes32(r.transactionHash)); }
      insist(response.nextCursor === null || typeof response.nextCursor === 'string', 'HISTORY_SCHEMA_UNKNOWN'); cursor = response.nextCursor as string | null;
      if (covered || !cursor) { covered = true; break; }
    }
    insist(covered && txs.size <= 100, 'HISTORY_GAP');
    const result: FillRecord[] = [], digest = orderDigest(plan), cutoff = await this.rpc.getBlock({ blockTag: this.config.finality });
    for (const tx of txs) {
      let receipt; try { receipt = await this.rpc.getTransactionReceipt({ hash: tx }); } catch { throw new PredictionError('SETTLEMENT_EVIDENCE_INCOMPLETE'); }
      insist(receipt.status === 'success' && receipt.blockNumber <= cutoff.number, 'SETTLEMENT_EVIDENCE_INCOMPLETE');
      const canonical = await this.rpc.getBlock({ blockNumber: receipt.blockNumber }); insist(canonical.hash === receipt.blockHash, 'REORG_DETECTED');
      const matched = parseEventLogs({ abi: fillAbi, logs: receipt.logs.filter(l => l.address.toLowerCase() === plan.market.exchange.toLowerCase()), strict: true }).filter(l => l.args.orderHash === digest && addr(l.args.maker) === this.config.address);
      if (!matched.length) continue;
      let usd = 0n, shares = 0n, fee = 0n;
      for (const log of matched) {
        const a = log.args, buy = plan.intent.side === 'BUY';
        insist((buy ? a.makerAssetId === 0n && a.takerAssetId === BigInt(plan.order.tokenId) : a.makerAssetId === BigInt(plan.order.tokenId) && a.takerAssetId === 0n), 'FILL_ASSET_MISMATCH');
        usd += buy ? a.makerAmountFilled : a.takerAmountFilled; shares += buy ? a.takerAmountFilled : a.makerAmountFilled; fee += a.fee;
      }
      let usdFee = plan.intent.side === 'SELL' ? fee : 0n, sharesFee = plan.intent.side === 'BUY' ? fee : 0n;
      if (plan.market.feeModel === 'collateral') {
        const own = parseEventLogs({ abi: fillAbi, logs: receipt.logs.filter(l => l.address.toLowerCase() === plan.market.exchange.toLowerCase()), strict: true }).filter(l => addr(l.args.maker) === this.config.address);
        insist(own.every(l => l.args.orderHash === digest), 'FILL_FEE_ATTRIBUTION_AMBIGUOUS');
        usdFee = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs.filter(l => l.address.toLowerCase() === USDC.toLowerCase()), strict: true }).filter(l => addr(l.args.from) === this.config.address && addr(l.args.to) === plan.market.feeModule).reduce((n, l) => n + l.args.value, 0n); sharesFee = 0n;
      }
      insist(sharesFee <= shares && usd <= shares && (plan.intent.side === 'BUY' ? usd * 1_000_000n <= shares * BigInt(plan.intent.limitPricePpm) : usd * 1_000_000n >= shares * BigInt(plan.intent.limitPricePpm)), 'FILL_PRICE_BOUND_EXCEEDED');
      result.push(validate('FillRecord', { fillId: hash('fill-id', { tx, digest }).slice(7), orderId, clientOrderId: plan.clientOrderId, marketSlug: plan.market.slug, tokenId: plan.order.tokenId, side: plan.intent.side, sharesGrossRaw: shares.toString(), sharesFeeRaw: sharesFee.toString(), sharesNetRaw: (shares - sharesFee).toString(), usdGrossRaw: usd.toString(), usdFeeRaw: usdFee.toString(), txHash: tx, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString(), transactionIndex: number(receipt.transactionIndex), logIndex: number(matched[0].logIndex), finality: this.config.finality, occurredAt: new Date(Number(canonical.timestamp) * 1000).toISOString(), fidelity: this.config.transportProfile === 'fixture' ? 'fixture' : 'chain' }));
    }
    // A claimed settled match without canonical fill proof remains unknown, never a zero-fill success.
    if (['MINED', 'CONFIRMED'].includes(String(execution.settlementStatus))) insist(result.length > 0, 'SETTLEMENT_EVIDENCE_INCOMPLETE');
    return result;
  }
  async estimate(calls: Array<{ to: Address; data: Hex }>): Promise<bigint> {
    let total = 0n;
    for (const call of calls) { const gas = await this.rpc.estimateGas({ account: this.config.address, ...call }); const fees = await this.rpc.estimateFeesPerGas(); insist(fees.maxFeePerGas !== undefined, 'GAS_UNAVAILABLE'); const serialized = serializeTransaction({ chainId: BASE_CHAIN_ID, type: 'eip1559', to: call.to, data: call.data, nonce: 0, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n }); total += gas * fees.maxFeePerGas + await this.additionalFees(serialized, gas); }
    return total;
  }
  private async readBounded<T>(reads: Array<() => Promise<T>>): Promise<T[]> {
    const result: T[] = [];
    for (let i = 0; i < reads.length; i += this.config.readConcurrency) result.push(...await Promise.all(reads.slice(i, i + this.config.readConcurrency).map(read => read())));
    return result;
  }
  private async additionalFees(serialized: Hex, gas: bigint): Promise<bigint> {
    const l1 = await this.rpc.readContract({ address: feeOracle, abi: feeOracleAbi, functionName: 'getL1Fee', args: [serialized] });
    const operator = await this.rpc.readContract({ address: feeOracle, abi: feeOracleAbi, functionName: 'getOperatorFee', args: [gas] });
    return 2n * (l1 + operator); // Preparation reserve; L1 charges are variable and cannot be capped in an L2 transaction.
  }
  async prepareTransaction(call: { to: Address; data: Hex }, gasCap: bigint): Promise<PreparedTransaction> {
    const account = await loadTradingAccount(this.config), nonce = await this.rpc.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const gas = await this.rpc.estimateGas({ account: account.address, ...call }), fees = await this.rpc.estimateFeesPerGas();
    insist(fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined && gas * fees.maxFeePerGas <= gasCap, 'GAS_BUDGET_EXHAUSTED');
    const serialized = await account.signTransaction({ chainId: BASE_CHAIN_ID, nonce, to: call.to, data: call.data, value: 0n, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, type: 'eip1559' });
    const total = gas * fees.maxFeePerGas + await this.additionalFees(serialized, gas); insist(total <= gasCap, 'GAS_BUDGET_EXHAUSTED');
    return { serialized, txHash: keccak256(serialized), nonce: String(nonce), gasUpperRaw: total.toString() };
  }
  async broadcast(tx: PreparedTransaction): Promise<void> { const id = await this.rpc.sendRawTransaction({ serializedTransaction: tx.serialized }); insist(id === tx.txHash, 'TRANSACTION_HASH_MISMATCH'); }
  async receipt(txHash: Hex): Promise<{ gasUsedRaw: string; blockHash: Hex; success: boolean } | null> {
    let r; try { r = await this.rpc.getTransactionReceipt({ hash: txHash }); } catch { return null; }
    const head = await this.rpc.getBlock({ blockTag: this.config.finality }); if (r.blockNumber > head.number) return null;
    const b = await this.rpc.getBlock({ blockNumber: r.blockNumber }); insist(b.hash === r.blockHash, 'REORG_DETECTED');
    const rawReceipt = object(await this.rpc.request({ method: 'eth_getTransactionReceipt', params: [txHash] }));
    insist(typeof rawReceipt.l1Fee === 'string', 'RECEIPT_FEE_EVIDENCE_INCOMPLETE');
    const operator = await this.rpc.readContract({ address: feeOracle, abi: feeOracleAbi, functionName: 'getOperatorFee', args: [r.gasUsed], blockNumber: r.blockNumber });
    return { gasUsedRaw: (r.gasUsed * r.effectiveGasPrice + BigInt(rawReceipt.l1Fee) + operator).toString(), blockHash: r.blockHash, success: r.status === 'success' };
  }
  async redemptionReceived(txHash: Hex): Promise<string> {
    const r = await this.rpc.getTransactionReceipt({ hash: txHash });
    return parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: r.logs.filter(l => l.address.toLowerCase() === USDC.toLowerCase()), strict: true }).filter(l => addr(l.args.to) === this.config.address).reduce((n, l) => n + l.args.value, 0n).toString();
  }
  async tokenPayouts(m: MarketSnapshot, balances: Array<{ tokenId: string; sharesRaw: string }>): Promise<Array<{ tokenId: string; payoutRaw: string }>> {
    const denominator = await this.rpc.readContract({ address: CTF, abi: redemptionAbi, functionName: 'payoutDenominator', args: [m.conditionId], blockTag: this.config.finality }); insist(denominator > 0n, 'MARKET_UNRESOLVED');
    return Promise.all([m.tokens.yes, m.tokens.no].map(async (tokenId, i) => ({ tokenId, payoutRaw: (raw(balances.find(b => b.tokenId === tokenId)?.sharesRaw ?? '0') * await this.rpc.readContract({ address: CTF, abi: redemptionAbi, functionName: 'payoutNumerators', args: [m.conditionId, BigInt(i)], blockTag: this.config.finality }) / denominator).toString() })));
  }
  async redemption(m: MarketSnapshot): Promise<{ to: Address; data: Hex; payoutRaw: string }> {
    insist(m.status === 'resolved', 'MARKET_UNRESOLVED');
    const block = await this.rpc.getBlock({ blockTag: this.config.finality });
    const denominator = await this.rpc.readContract({ address: CTF, abi: redemptionAbi, functionName: 'payoutDenominator', args: [m.conditionId], blockNumber: block.number }); insist(denominator > 0n, 'MARKET_UNRESOLVED');
    const balances = await Promise.all([m.tokens.yes, m.tokens.no].map(t => this.rpc.readContract({ address: CTF, abi: erc1155Abi, functionName: 'balanceOf', args: [this.config.address, BigInt(t)], blockNumber: block.number })));
    const numerators = await Promise.all([0n, 1n].map(i => this.rpc.readContract({ address: CTF, abi: redemptionAbi, functionName: 'payoutNumerators', args: [m.conditionId, i], blockNumber: block.number })));
    const payout = balances.reduce((n, v, i) => n + v * numerators[i] / denominator, 0n); insist(balances.some(v => v > 0n), 'NO_REDEEMABLE_BALANCE');
    if (m.adapter) { insist(await this.rpc.readContract({ address: CTF, abi: erc1155Abi, functionName: 'isApprovedForAll', args: [this.config.address, m.adapter] }), 'REDEMPTION_APPROVAL_REQUIRED'); return { to: m.adapter, data: encodeFunctionData({ abi: negRiskAbi, functionName: 'redeemPositions', args: [m.conditionId, balances] }), payoutRaw: payout.toString() }; }
    return { to: CTF, data: encodeFunctionData({ abi: redemptionAbi, functionName: 'redeemPositions', args: [USDC, zeroHash, m.conditionId, [1n, 2n]] }), payoutRaw: payout.toString() };
  }
}
