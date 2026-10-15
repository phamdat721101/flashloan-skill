import { createReadStream } from 'node:fs';
import { lstat, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { ExecutionLock } from '../execution-lock.js';
import { fields, record, ns } from './l2-contracts.js';

export interface L2Segment { fileName: string; kind: 'raw' | 'derived'; createdTimeNs: string; sha256: string }
/** Explicit retention transaction for closed segments. Open journals and model
 * dataset manifests must be pinned by the caller. Dry-run is the CLI default.
 */
export async function retainL2Segments(root: string,segments: readonly L2Segment[],pinned: readonly string[],nowNs: string,dryRun = true): Promise<{ retained: string[]; expired: string[] }> {
  if (!Array.isArray(segments) || segments.length > 1000 || !Array.isArray(pinned) || pinned.length > 10000 || pinned.some(p => !/^[a-f0-9]{64}$/.test(p))) throw new Error('L2_RETENTION_LIMIT');
  const directory = await realpath(root), pins = new Set(pinned), now = ns(nowNs);
  return new ExecutionLock(resolve(directory,'.l2-retention.lock')).runExclusive(async () => {
    const retained: string[] = [], expired: string[] = [], names = new Set<string>(), checkedFiles = new Map<string,{ ino: number; size: number; mtimeMs: number }>();
    for (const raw of segments) {
      const s = record(raw); fields(s,['fileName','kind','createdTimeNs','sha256']);
      if (typeof s.fileName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.jsonl$/.test(s.fileName) || names.has(s.fileName) || !['raw','derived'].includes(String(s.kind)) || !/^[a-f0-9]{64}$/.test(String(s.sha256)) || ns(s.createdTimeNs) > now) throw new Error('L2_INVALID_SEGMENT');
      names.add(s.fileName);
      const file = resolve(directory,s.fileName), info = await lstat(file);
      if (dirname(file) !== directory || !info.isFile() || info.isSymbolicLink()) throw new Error('L2_UNSAFE_SEGMENT_PATH');
      const retention = BigInt(s.kind === 'raw' ? 7 : 90)*86400000000000n;
      if (pins.has(String(s.sha256)) || now-ns(s.createdTimeNs) < retention) { retained.push(s.fileName); continue; }
      const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
      if (hash.digest('hex') !== s.sha256) throw new Error('L2_SEGMENT_HASH_MISMATCH');
      const checked = await lstat(file);
      if (checked.ino !== info.ino || checked.size !== info.size || checked.mtimeMs !== info.mtimeMs) throw new Error('L2_SEGMENT_CHANGED');
      checkedFiles.set(s.fileName,{ ino: checked.ino,size: checked.size,mtimeMs: checked.mtimeMs });
      expired.push(s.fileName);
    }
    // Validate the complete manifest before removing any file.
    if (!dryRun) for (const name of expired) await new ExecutionLock(`${resolve(directory,name)}.lock`).runExclusive(async () => {
      const current = await lstat(resolve(directory,name)), checked = checkedFiles.get(name)!;
      if (!current.isFile() || current.isSymbolicLink() || current.ino !== checked.ino || current.size !== checked.size || current.mtimeMs !== checked.mtimeMs) throw new Error('L2_SEGMENT_CHANGED');
      await unlink(resolve(directory,name));
    });
    return { retained,expired };
  });
}
