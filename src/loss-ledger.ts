import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface LedgerState { day: string; realizedLossUsd: number; halted?: boolean; haltReason?: string }

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
    await this.write({ day, realizedLossUsd, halted: prior?.day === day ? prior.halted : false, haltReason: prior?.day === day ? prior.haltReason : undefined });
  }

  async halt(reason: string, now = new Date()): Promise<void> {
    const day = now.toISOString().slice(0, 10);
    const prior = await this.read();
    await this.write({ day, realizedLossUsd: prior?.day === day ? prior.realizedLossUsd : 0, halted: true, haltReason: reason.slice(0, 240) });
  }

  async isHalted(now = new Date()): Promise<boolean> {
    const state = await this.read();
    return state?.day === now.toISOString().slice(0, 10) && state.halted === true;
  }

  private async read(): Promise<LedgerState | undefined> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as LedgerState;
      if (typeof value.day !== 'string' || !Number.isFinite(value.realizedLossUsd) || value.realizedLossUsd < 0 || (value.halted !== undefined && typeof value.halted !== 'boolean')) throw new Error('loss ledger is malformed');
      return value;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async write(state: LedgerState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
