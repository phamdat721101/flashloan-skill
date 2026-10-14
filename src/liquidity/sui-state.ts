import { normalizeSuiAddress } from '@mysten/sui/utils';
import { digest, isSuiDigest, parseStateIdentity, uint, type StateIdentity } from './state.js';
import type { SuiCheckpointObservation } from './sources.js';
import type { SourceJournal } from './ingestion.js';

export interface SuiVersionedRef { objectId: string; version: string; digest: string }
function objectId(value: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new Error('INVALID_SUI_OBJECT_ID');
  return normalizeSuiAddress(value);
}

/** Replay only committed, chain-linked observations. Older incomplete effect formats fail closed. */
export async function recoverSuiCheckpointState(journal: SourceJournal, trackedObjectIds: readonly string[]): Promise<SuiCheckpointState> {
  if (journal.binding.chain !== 'sui') throw new Error('SOURCE_CHAIN_MISMATCH');
  const state = new SuiCheckpointState(journal.binding.network as 'mainnet' | 'testnet' | 'localnet', journal.binding.chainIdentifier, trackedObjectIds);
  for await (const record of journal.records()) {
    const checkpoint = record.payload as SuiCheckpointObservation;
    if (record.identity.chain !== 'sui' || !checkpoint || checkpoint.checkpoint !== record.identity.height || checkpoint.checkpointDigest !== record.identity.checkpointDigest) throw new Error('CHECKPOINT_RECORD_IDENTITY_MISMATCH');
    state.apply(checkpoint);
  }
  return state;
}

/** Consistent references for a declared object set, NOT a proof of complete protocol liquidity. */
export class SuiCheckpointState {
  private readonly tracked: Set<string>;
  private objects = new Map<string, SuiVersionedRef>();
  private head: SuiCheckpointObservation | undefined;
  private halted = false;
  constructor(private readonly network: 'mainnet' | 'testnet' | 'localnet', private readonly chainIdentifier: string, trackedObjectIds: readonly string[]) {
    if (!['mainnet', 'testnet', 'localnet'].includes(network) || !isSuiDigest(chainIdentifier) || !trackedObjectIds.length || trackedObjectIds.length > 1000) throw new Error('INVALID_CHECKPOINT_STATE_CONFIG');
    this.tracked = new Set(trackedObjectIds.map(objectId));
    if (this.tracked.size !== trackedObjectIds.length) throw new Error('DUPLICATE_TRACKED_OBJECT');
  }
  apply(input: SuiCheckpointObservation): 'accepted' | 'duplicate' {
    if (this.halted) throw new Error('RESYNC_REQUIRED');
    const checkpoint = structuredClone(input);
    try {
      if (checkpoint.schemaVersion !== '3.0' || checkpoint.chain !== 'sui' || checkpoint.network !== this.network || checkpoint.chainIdentifier !== this.chainIdentifier) throw new Error('SOURCE_CHAIN_MISMATCH');
      parseStateIdentity({ chain: 'sui', network: checkpoint.network, height: checkpoint.checkpoint, checkpointDigest: checkpoint.checkpointDigest });
      if (this.head) {
        if (checkpoint.checkpoint === this.head.checkpoint && digest(checkpoint) === digest(this.head)) return 'duplicate';
        if (uint(checkpoint.checkpoint, 64) !== uint(this.head.checkpoint, 64) + 1n || checkpoint.previousCheckpointDigest !== this.head.checkpointDigest) throw new Error('SOURCE_GAP_OR_DIVERGENCE');
      } else if (checkpoint.checkpoint !== '0' && !isSuiDigest(checkpoint.previousCheckpointDigest)) throw new Error('INCOMPLETE_CHECKPOINT_PARENT');
      if (!Array.isArray(checkpoint.transactions) || checkpoint.transactions.length > 10000) throw new Error('CHECKPOINT_EFFECT_LIMIT');
      if (!isSuiDigest(checkpoint.contentsDigest) || !Array.isArray(checkpoint.committedTransactions) || checkpoint.committedTransactions.length !== checkpoint.transactions.length) throw new Error('INCOMPLETE_CHECKPOINT_CONTENTS');
      const committed = new Map(checkpoint.committedTransactions.map(entry => {
        if (!isSuiDigest(entry.digest) || !isSuiDigest(entry.effectsDigest)) throw new Error('INCOMPLETE_CHECKPOINT_COMMITMENT');
        return [entry.digest, entry.effectsDigest] as const;
      }));
      if (committed.size !== checkpoint.transactions.length) throw new Error('DUPLICATE_CHECKPOINT_TRANSACTION');
      const next = new Map(this.objects), transactionIds = new Set<string>(); let changes = 0;
      for (const transaction of checkpoint.transactions) {
        if (!isSuiDigest(transaction.digest) || committed.get(transaction.digest) !== transaction.effectsDigest || transactionIds.has(transaction.digest) || !Array.isArray(transaction.changes)) throw new Error('INVALID_CHECKPOINT_TRANSACTION');
        transactionIds.add(transaction.digest);
        changes += transaction.changes.length;
        if (changes > 100000) throw new Error('CHECKPOINT_EFFECT_LIMIT');
        for (const change of transaction.changes) {
          const id = objectId(change.objectId);
          if (!this.tracked.has(id)) continue;
          if (change.outputState === 'deleted') { next.delete(id); continue; }
          if (!['object-write', 'package-write'].includes(change.outputState)) throw new Error('UNSUPPORTED_OBJECT_OUTPUT_STATE');
          if (typeof change.outputVersion !== 'string' || !isSuiDigest(change.outputDigest)) throw new Error('INCOMPLETE_OBJECT_WRITE');
          const version = uint(change.outputVersion, 64), prior = next.get(id);
          if (version === 0n || (prior && version <= uint(prior.version, 64))) throw new Error('OBJECT_VERSION_DIVERGENCE');
          next.set(id, { objectId: id, version: change.outputVersion, digest: change.outputDigest });
        }
      }
      this.objects = next; this.head = checkpoint;
      return 'accepted';
    } catch (error) { this.halted = true; throw error; }
  }
  snapshot(): { schemaVersion: '3.0'; identity: StateIdentity; chainIdentifier: string; completeForDeclaredObjectSet: boolean; objects: SuiVersionedRef[]; missingObjectIds: string[]; stateDigest: string } {
    if (!this.head || this.halted) throw new Error('RESYNC_REQUIRED');
    const objects = [...this.objects.values()].sort((a, b) => a.objectId.localeCompare(b.objectId));
    const missingObjectIds = [...this.tracked].filter(id => !this.objects.has(id)).sort();
    return { schemaVersion: '3.0', identity: { chain: 'sui', network: this.network, height: this.head.checkpoint, checkpointDigest: this.head.checkpointDigest }, chainIdentifier: this.chainIdentifier, completeForDeclaredObjectSet: missingObjectIds.length === 0, objects: structuredClone(objects), missingObjectIds, stateDigest: digest(objects) };
  }
}
