import { mkdir, open, rm, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class ExecutionLock {
  constructor(private readonly filePath: string) {}

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true });
    let handle;
    try {
      handle = await open(this.filePath, 'wx', 0o600);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('another flashloan execution is already in progress');
      throw error;
    }
    try {
      await handle.writeFile(`${process.pid}\n`);
      return await operation();
    } finally {
      await handle.close();
      await rm(this.filePath, { force: true });
    }
  }
}

/** Explicit crash recovery. Never removes a lock held by a live or inaccessible PID. */
export async function recoverDeadExecutionLock(filePath: string): Promise<boolean> {
  const recoveryPath = `${filePath}.recovery`;
  await mkdir(dirname(filePath), { recursive: true });
  const recovery = await open(recoveryPath, 'wx', 0o600);
  try {
    await recovery.writeFile(`${process.pid}\n`); await recovery.sync();
    let raw: string;
    try { raw = await readFile(filePath, 'utf8'); }
    catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
    if (!/^[1-9][0-9]*\n$/.test(raw)) throw new Error('INVALID_LOCK_OWNER');
    const pid = Number(raw.trim());
    if (!Number.isSafeInteger(pid)) throw new Error('INVALID_LOCK_OWNER');
    try { process.kill(pid, 0); throw new Error('LOCK_OWNER_STILL_ALIVE'); }
    catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    if (await readFile(filePath, 'utf8') !== raw) throw new Error('LOCK_OWNER_CHANGED');
    await rm(filePath); return true;
  } finally { await recovery.close(); await rm(recoveryPath); }
}
