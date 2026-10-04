import { mkdir, open, rm } from 'node:fs/promises';
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
