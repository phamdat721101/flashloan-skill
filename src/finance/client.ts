import { CONTRACT_DIGEST, FinanceError, checkAccount, checkAmount, checkAsset, checkConstraints, insist, strictParse, validate, type Account, type Amount, type Constraints, type Network } from './contracts.js';

export type FinanceRequest = { schemaVersion: 'finance.request/1'; requestId: string; idempotency_key: string; network: Network; operation: string; contractDigest?: string; account?: Account; requestedConstraints?: Constraints; amount?: Amount; [k: string]: unknown };
export type FinanceResponse = { schemaVersion: 'finance.response/1'; contractDigest: string; requestId: string; network: Network; status: string; kind: string; data: unknown; errors: Array<{ code: string }>; warnings: string[]; execution: false };
export const MAX_RESPONSE_BYTES = 1 << 20;
export const RESEARCH_DEADLINE_MS = 30_000;

/** Request semantic checks repeated before any transport (rules 1, 2, 7). */
export function checkRequest(input: unknown): FinanceRequest {
  const r = validate<FinanceRequest>('Request', input);
  if (r.operation !== 'capabilities') insist(r.contractDigest === CONTRACT_DIGEST, 'CONTRACT_MISMATCH');
  insist(r.idempotency_key.startsWith(`finance:${r.operation}:`), 'INVALID_INPUT', 'idempotency-namespace');
  if (r.account) checkAccount(r.account, r.network);
  if (r.requestedConstraints) checkConstraints(r.requestedConstraints, r.network);
  if (r.amount) { checkAsset(r.amount.asset, r.network); checkAmount(r.amount, { positive: true }); }
  return r;
}

/**
 * Authenticated MCP client for research/unsigned preparation only. It never sends a signing key,
 * grant or local plan, and refuses any response claiming execution authority.
 */
export class FinanceClient {
  constructor(readonly url: string, private readonly token: string | undefined, readonly fetchImpl: typeof fetch = fetch, readonly now: () => number = Date.now) {
    const u = new URL(url);
    insist(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)), 'POLICY_REJECTED', 'mcp-tls');
  }

  async call(input: unknown, deadlineAt = this.now() + RESEARCH_DEADLINE_MS): Promise<FinanceResponse> {
    const request = checkRequest(input);
    insist(this.token, 'AUTH_REQUIRED');
    const response = await this.post(`finance_${request.operation.replace(/-/g, '_')}`, request, deadlineAt);
    insist(response.requestId === request.requestId && response.network === request.network, 'OWNER_SCOPE_MISMATCH', 'response-binding');
    if (response.kind === 'job') return this.poll(request, response, deadlineAt);
    return response;
  }

  /** Bounded job polling: QUEUED/RUNNING until the shared deadline. SUCCEEDED means a research artifact, not money movement. */
  private async poll(request: FinanceRequest, job: FinanceResponse, deadlineAt: number): Promise<FinanceResponse> {
    let current = job;
    for (let i = 0; ; i++) {
      const data = current.data as { jobId: string; state: string; resultRef: string | null };
      if (data.state === 'SUCCEEDED' && data.resultRef) {
        return this.post('finance_status', { schemaVersion: 'finance.request/1', requestId: request.requestId, idempotency_key: `finance:status:${data.jobId}`, network: request.network, operation: 'status', artifactRef: data.resultRef, contractDigest: CONTRACT_DIGEST }, deadlineAt);
      }
      if (data.state !== 'QUEUED' && data.state !== 'RUNNING') return current;
      insist(this.now() + 500 < deadlineAt, 'DEPENDENCY_TIMEOUT', 'job-deadline');
      await new Promise(r => setTimeout(r, Math.min(250 * 2 ** i, 2_000)));
      current = await this.post('finance_job', { schemaVersion: 'finance.request/1', requestId: request.requestId, idempotency_key: `finance:job:${data.jobId}:${i}`, network: request.network, operation: 'job', jobId: data.jobId, mode: 'get', contractDigest: CONTRACT_DIGEST }, deadlineAt);
    }
  }

  private async post(tool: string, args: unknown, deadlineAt: number): Promise<FinanceResponse> {
    const remaining = deadlineAt - this.now(); insist(remaining > 0, 'DEPENDENCY_TIMEOUT');
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(remaining, 5_000)),
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      });
    } catch { throw new FinanceError('DEPENDENCY_TIMEOUT', 'mcp'); }
    insist(res.status !== 401 && res.status !== 403, 'AUTH_REQUIRED');
    const bytes = new Uint8Array(await res.arrayBuffer()); insist(bytes.length <= MAX_RESPONSE_BYTES, 'DEPENDENCY_TIMEOUT', 'mcp-body-limit');
    const envelope = strictParse(bytes, MAX_RESPONSE_BYTES) as { result?: { content?: Array<{ type: string; text: string }> }; error?: unknown };
    const text = envelope.result?.content?.find(c => c.type === 'text')?.text; insist(text, 'DEPENDENCY_TIMEOUT', 'mcp-envelope');
    const response = validate<FinanceResponse>('Response', strictParse(Buffer.from(text, 'utf8'), MAX_RESPONSE_BYTES));
    insist(response.contractDigest === CONTRACT_DIGEST, 'CONTRACT_MISMATCH', 'response');
    return response;
  }
}

/**
 * R4 handoff: a Finance prediction-context response becomes a read-only request for the independent
 * PredictionRuntime (its own config, budget and grant domain). No Finance grant, plan or budget crosses over.
 */
export function predictionHandoff(response: FinanceResponse, requestId: string): { schemaVersion: 'prediction-request/1'; requestId: string; command: 'market'; payload: { mode: 'paper'; marketSlug: string } } {
  insist(response.kind === 'prediction-context' && response.network === 'base' && response.execution === false, 'CAPABILITY_UNAVAILABLE', 'prediction-context');
  const ctx = response.data as { venue: string; marketRef: string; eligible: string; operatingState: string };
  insist(ctx.venue === 'limitless' && /^[a-z0-9][a-z0-9-]{0,199}$/.test(ctx.marketRef), 'INVALID_INPUT', 'market-ref');
  insist(ctx.eligible !== 'NO' && ctx.operatingState !== 'PAUSED', 'POLICY_REJECTED', 'prediction-venue-unavailable');
  return { schemaVersion: 'prediction-request/1', requestId, command: 'market', payload: { mode: 'paper', marketSlug: ctx.marketRef } };
}
