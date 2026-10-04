import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface LedgerState { day: string; realizedLossUsd: number }

export class DailyLossLedger {
  constructor(private readonly filePath: string) {}

  async currentLossUsd(now = new Date()): Promise<number> {
    const state = await this.read();
    return state?.day === now.toISOString().slice(0, 10) ? state.realizedLossUsd : 0;
  }

  async recordProfit(realizedProfitUsd: number, now = new Date()): Promise<void> {
    if (!Number.isFinite(realizedProfitUsd)) throw new Error('realized profit must be finite');
    const day = now.toISOString().slice(0, 10);
    const prior = await this.read();
    const realizedLossUsd = Math.max(0, (prior?.day === day ? prior.realizedLossUsd : 0) + Math.min(0, realizedProfitUsd) * -1);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ day, realizedLossUsd }) + '\n', { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  private async read(): Promise<LedgerState | undefined> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as LedgerState;
      if (typeof value.day !== 'string' || !Number.isFinite(value.realizedLossUsd) || value.realizedLossUsd < 0) throw new Error('loss ledger is malformed');
      return value;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
