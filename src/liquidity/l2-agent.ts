import { digest } from './state.js';
import { fields, record, text, ns, ratioNumber, type MicrostructureFrame } from './l2-contracts.js';
import { L2ContextEngine } from './l2-ingestion.js';
import { L2RiskJournal } from './l2-execution.js';

const VERSION = '2025-11-25';
const toolSchema = (properties: Record<string,unknown>,required: string[]) => ({ type: 'object',properties,required,additionalProperties: false });
export const L2_TOOLS = [
  { name: 'l2_inspect_pool_microstructure',description: 'Read current canonical market facts with evidence and coverage.',inputSchema: toolSchema({ pool_id: { type: 'string' } },['pool_id']) },
  { name: 'l2_stage_speculative_trigger',description: 'Request expiring shadow route evaluation. Does not authorize signing or submission.',inputSchema: toolSchema({ pool_id: { type: 'string' },expires_at_ns: { type: 'string',pattern: '^[0-9]+$' },required_labels: { type: 'array',items: { type: 'string' },maxItems: 20 } },['pool_id','expires_at_ns','required_labels']) },
  { name: 'l2_run_post_trade_reflection',description: 'Read durable receipt-sourced risk reflection. Cannot override risk limits or clear a halt.',inputSchema: toolSchema({ lane: { type: 'string' } },['lane']) }
] as const;
export function frameNarrative(f: MicrostructureFrame): string {
  const skew = f.metrics.skew2pct.value;
  return `${f.poolId}: ${f.metrics.tradeCount} observed trades in the rolling hour; ${skew ? `depth skew ${ratioNumber(skew).toFixed(3)}` : 'depth unavailable'}. Labels: ${f.labels.join(', ') || 'none'}. ${f.quality.complete ? 'Covered observation window.' : `Incomplete: ${f.quality.reasons.join(', ')}.`} These are observations, not guaranteed future moves.`;
}
const poolUri = (f: MicrostructureFrame) => `l2://${f.identity.chain}/${f.identity.network}/pool/${encodeURIComponent(f.poolId)}/state`;
export class L2AgentServer {
  private initialized = false;
  private ready = false;
  private subscriptions = new Set<string>();
  private staged = new Map<string,{ frameId: string; expiresAtNs: string; poolId: string }>();
  private published: Map<string,string>;
  constructor(private engine: L2ContextEngine,private readonly now = () => (BigInt(Date.now())*1000000n).toString(),private readonly risk?: L2RiskJournal) { this.published = new Map(engine.snapshot().map(f => [f.poolId,f.frameId])); }
  replaceEngine(engine: L2ContextEngine): unknown[] {
    const before = this.published;
    const after = new Map(engine.snapshot().map(f => [f.poolId,f.frameId]));
    this.engine = engine; this.published = after;
    return [...this.subscriptions].filter(uri => {
      const match = /\/pool\/([^/]+)\/state$/.exec(uri);
      return match ? before.get(decodeURIComponent(match[1])) !== after.get(decodeURIComponent(match[1])) : [...new Set([...before.keys(),...after.keys()])].some(key => before.get(key) !== after.get(key));
    }).map(uri => ({ jsonrpc: '2.0',method: 'notifications/resources/updated',params: { uri } }));
  }
  private current(poolId: string): MicrostructureFrame { text(poolId,256); return this.engine.inspect(poolId,this.now()); }
  private resource(uri: string): unknown {
    text(uri,2048);
    const match = /^l2:\/\/(arbitrum|sui)\/([^/]+)\/(?:pool\/([^/]+)\/state|watchlist\/ranked)$/.exec(uri);
    if (!match) throw new Error('L2_RESOURCE_NOT_FOUND');
    const frames = this.engine.snapshot().filter(f => f.identity.chain === match[1] && f.identity.network === match[2]);
    if (match[3]) {
      const frame = this.current(decodeURIComponent(match[3]));
      if (frame.identity.chain !== match[1] || frame.identity.network !== match[2]) throw new Error('L2_RESOURCE_NOT_FOUND');
      return { frame,narrative: frameNarrative(frame) };
    }
    // Research ranking uses observable anomaly magnitude, never a live execution score.
    return { schemaVersion: '1.0',ranking: 'descriptive-only',candidates: frames.filter(f => { try { this.current(f.poolId); return true; } catch { return false; } }).sort((a,b) => Math.abs(b.metrics.skew2pct.value ? ratioNumber(b.metrics.skew2pct.value) : 0)-Math.abs(a.metrics.skew2pct.value ? ratioNumber(a.metrics.skew2pct.value) : 0) || a.poolId.localeCompare(b.poolId)).slice(0,5).map(f => ({ frameId: f.frameId,poolId: f.poolId,identity: f.identity,labels: f.labels,quality: f.quality,metrics: f.metrics,resource: poolUri(f),evidence: { digest: digest(f.evidence),count: f.evidence.length,sample: f.evidence.slice(-5) },narrative: frameNarrative(f) })) };
  }
  async handle(raw: unknown): Promise<unknown | null> {
    let id: unknown = null;
    try {
      const request = record(raw);
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (request.id !== undefined && typeof request.id !== 'string' && !(typeof request.id === 'number' && Number.isSafeInteger(request.id)))) return { jsonrpc: '2.0',id:null,error: { code: -32600,message: 'Invalid Request' } };
      id = request.id ?? null;
      const notification = request.id === undefined;
      if (request.method === 'notifications/cancelled') return null; // All current handlers are bounded and read-only.
      if (request.method === 'notifications/initialized') { if (this.initialized) this.ready = true; return null; }
      if (notification) return null;
      let result: unknown;
      if (request.method === 'initialize') {
        if (this.initialized) throw new Error('L2_ALREADY_INITIALIZED');
        const p = record(request.params); text(p.protocolVersion,64); record(p.capabilities); record(p.clientInfo);
        this.initialized = true;
        result = { protocolVersion: VERSION,capabilities: { resources: { subscribe: true },tools: {} },serverInfo: { name: 'flashloan-level-2',version: '1.0.0' } };
      } else if (request.method === 'ping') result = {};
      else {
        if (!this.ready) throw new Error('L2_NOT_INITIALIZED');
        if (request.method === 'tools/list') result = { tools: L2_TOOLS };
        else if (request.method === 'resources/templates/list') result = { resourceTemplates: [{ uriTemplate: 'l2://{chain}/{network}/pool/{pool_id}/state',name: 'Pool market context',mimeType: 'application/json' },{ uriTemplate: 'l2://{chain}/{network}/watchlist/ranked',name: 'Descriptive watchlist',mimeType: 'application/json' }] };
        else if (request.method === 'resources/list') {
          const frames = this.engine.snapshot();
          result = { resources: frames.map(f => ({ uri: poolUri(f),name: f.poolId,mimeType: 'application/json' })) };
        } else if (request.method === 'resources/read') {
          const p = record(request.params); fields(p,['uri']); text(p.uri,2048);
          result = { contents: [{ uri: p.uri,mimeType: 'application/json',text: JSON.stringify(this.resource(p.uri)) }] };
        } else if (['resources/subscribe','resources/unsubscribe'].includes(request.method)) {
          const p = record(request.params); fields(p,['uri']); text(p.uri,2048); this.resource(p.uri);
          if (request.method === 'resources/subscribe') { if (this.subscriptions.size >= 100) throw new Error('L2_SUBSCRIPTION_LIMIT'); this.subscriptions.add(p.uri); } else this.subscriptions.delete(p.uri);
          result = {};
        } else if (request.method === 'tools/call') {
          const p = record(request.params); fields(p,['name','arguments']); const a = record(p.arguments);
          let output: unknown;
          try {
            if (p.name === 'l2_inspect_pool_microstructure') {
              fields(a,['pool_id']); text(a.pool_id,256); const frame = this.current(a.pool_id); output = { frame,narrative: frameNarrative(frame) };
            } else if (p.name === 'l2_stage_speculative_trigger') {
              fields(a,['pool_id','expires_at_ns','required_labels']); text(a.pool_id,256);
              const frame = this.current(a.pool_id), now = ns(this.now());
              for (const [key,value] of this.staged) if (ns(value.expiresAtNs) <= now) this.staged.delete(key);
              if (this.staged.size >= 20 || !Array.isArray(a.required_labels) || a.required_labels.length > 20 || a.required_labels.some(l => typeof l !== 'string' || !frame.labels.includes(l)) || ns(a.expires_at_ns) <= now || ns(a.expires_at_ns) > now+30000000000n) throw new Error('L2_INVALID_STAGE_REQUEST');
              const stage = { frameId: frame.frameId,poolId: frame.poolId,expiresAtNs: a.expires_at_ns as string }, requestId = digest(stage);
              this.staged.set(requestId,stage); output = { requestId,status: 'shadow-evaluation-requested',...stage };
            } else if (p.name === 'l2_run_post_trade_reflection') {
              fields(a,['lane']); text(a.lane,64);
              if (!this.risk) throw new Error('L2_REFLECTION_UNCONFIGURED');
              const state = (await this.risk.state()).states.get(a.lane);
              if (!state) throw new Error('L2_REFLECTION_UNAVAILABLE'); output = state;
            } else return { jsonrpc: '2.0',id,error: { code: -32602,message: 'Unknown tool' } };
            result = { content: [{ type: 'text',text: JSON.stringify(output) }],isError: false };
          } catch (error) { result = { content: [{ type: 'text',text: error instanceof Error && /^L2_[A-Z_]+$/.test(error.message) ? error.message : 'L2_TOOL_FAILED' }],isError: true }; }
        } else return { jsonrpc: '2.0',id,error: { code: -32601,message: 'Method not found' } };
      }
      return { jsonrpc: '2.0',id,result };
    } catch (error) { return { jsonrpc: '2.0',id,error: { code: error instanceof Error && error.message === 'L2_RESOURCE_NOT_FOUND' ? -32002 : -32602,message: error instanceof Error && /^L2_[A-Z_]+$/.test(error.message) ? error.message : 'Invalid params' } }; }
  }
  updates(): unknown[] {
    return [...this.subscriptions].map(uri => ({ jsonrpc: '2.0',method: 'notifications/resources/updated',params: { uri } }));
  }
  requests(): Array<{ frameId: string; expiresAtNs: string; poolId: string }> {
    const now = ns(this.now()); return [...this.staged.values()].filter(v => ns(v.expiresAtNs) > now).map(v => structuredClone(v));
  }
}
/** Bounded UTF-8 line framing, without readline's unbounded unterminated lines. */
export async function serveL2Stdio(server: L2AgentServer,input: AsyncIterable<Uint8Array>,write: (line: string) => Promise<void>): Promise<void> {
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    pending = Buffer.concat([pending,chunk]);
    let index: number;
    while ((index = pending.indexOf(10)) >= 0) {
      if (index > 4*1024*1024) throw new Error('L2_MCP_INPUT_LIMIT');
      const line = pending.subarray(0,index); pending = pending.subarray(index+1);
      let result: unknown;
      try { result = await server.handle(JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(line))); }
      catch { result = { jsonrpc: '2.0',id: null,error: { code: -32700,message: 'Parse error' } }; }
      if (result !== null) {
        const output = JSON.stringify(result)+'\n';
        if (Buffer.byteLength(output) > 4*1024*1024) throw new Error('L2_MCP_OUTPUT_LIMIT');
        await write(output);
      }
    }
    if (pending.length > 4*1024*1024) throw new Error('L2_MCP_INPUT_LIMIT');
  }
  if (pending.length) throw new Error('L2_MCP_TORN_REQUEST');
}
