import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ScanCheckpoint, ScanEnvelope } from './types.js';

export interface ScanEntities {
  aaveBorrowers: string[];
  morphoBorrowers: Array<{ marketId: string; borrower: string }>;
}

export class ScanStore {
  constructor(private readonly stateDir: string) {}

  private checkpointPath(): string { return join(this.stateDir, 'checkpoint.json'); }
  private entitiesPath(): string { return join(this.stateDir, 'entities.json'); }

  async loadCheckpoint(): Promise<ScanCheckpoint | undefined> {
    try { return JSON.parse(await readFile(this.checkpointPath(), 'utf8')) as ScanCheckpoint; }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async saveCheckpoint(checkpoint: ScanCheckpoint): Promise<void> {
    const path = this.checkpointPath();
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(checkpoint), 'utf8');
    await rename(temporary, path);
  }

  async loadEntities(): Promise<ScanEntities> {
    try {
      const value = JSON.parse(await readFile(this.entitiesPath(), 'utf8')) as Partial<ScanEntities>;
      return { aaveBorrowers: value.aaveBorrowers ?? [], morphoBorrowers: value.morphoBorrowers ?? [] };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { aaveBorrowers: [], morphoBorrowers: [] };
      throw error;
    }
  }

  async saveEntities(entities: ScanEntities): Promise<void> {
    const path = this.entitiesPath();
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(entities), 'utf8');
    await rename(temporary, path);
  }

  async appendEnvelope(outputFile: string, envelope: ScanEnvelope): Promise<void> {
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', flag: 'a' });
  }
}
