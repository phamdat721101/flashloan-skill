import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type MemoryStage = 'scan' | 'solve' | 'simulate' | 'broadcast' | 'receipt';

export interface RuntimeMemoryEvent {
  schemaVersion: '1.0';
  occurredAt: string;
  runId: string;
  stage: MemoryStage;
  outcome: 'accepted' | 'blocked' | 'failed';
  code: string;
  retryable: boolean;
  candidateFingerprint?: string;
  protocol?: string;
  blockNumber?: string;
  detail?: string;
}

const SECRET_KEYS = /private.?key|secret|signature|authorization|rpc.*url|calldata|transaction.*data/i;

function redact(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/0x[\da-fA-F]{64,}/g, '[redacted-hex]').slice(0, 500);
}

/** Runtime records use the configured Nim memory files but never execute a shell command. */
export class NimRuntimeMemory {
  private readonly learned = new Set<string>();

  constructor(private readonly root = '.nim') {}

  private async append(file: string, event: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async record(event: RuntimeMemoryEvent): Promise<void> {
    const safe: RuntimeMemoryEvent = { ...event, detail: redact(event.detail) };
    const record: Record<string, unknown> = { ...safe };
    for (const key of Object.keys(record)) if (SECRET_KEYS.test(key)) delete record[key];
    await this.append(join(this.root, 'memory.jsonl'), record);
    if (safe.outcome !== 'failed' || !safe.code || this.learned.has(safe.code)) return;
    this.learned.add(safe.code);
    await this.append(join(this.root, 'lessons.jsonl'), {
      timestamp: safe.occurredAt,
      category: 'runtime-failure-pattern',
      key: `flashloan-${safe.code.toLowerCase()}`,
      insight: `Reusable runtime failure: ${safe.code}`,
      confidence: 8,
      source: 'flashloan-agent',
      fingerprint: createHash('sha256').update(`${safe.code}:${safe.protocol ?? ''}`).digest('hex')
    });
  }
}
