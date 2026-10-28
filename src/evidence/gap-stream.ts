import {validateRecord,type Identity,type EvidenceRef} from './contracts.js';
import {digest,uint} from '../liquidity/state.js';
import {parsePoolState} from '../liquidity/projection.js';
import type {TriggerBlock,WatchHost} from '../liquidity/trigger-watcher.js';
export interface GapStreamUpdate {
  sourceId:string;adapterRevision:string;generation:string;cursor:string;parentCursor:string|null;
  identity:Identity;parentHash:string;payloadKind:'transactions'|'storage-diff'|'canonical-pools';evidence:EvidenceRef;
}
export interface GapStreamAdapter {
  sourceId:string;adapterRevision:string;
  updates(signal:AbortSignal):AsyncIterable<unknown>;
  /** Explicit adapter supplies complete canonical state; raw transaction feeds are never cast to slot diffs. */
  capture(update:GapStreamUpdate,signal:AbortSignal):Promise<TriggerBlock>;
  resync(update:GapStreamUpdate,reason:string,signal:AbortSignal):Promise<TriggerBlock>;
  persist(event:{code:string;update:GapStreamUpdate},signal:AbortSignal):Promise<void>;
}
/** Bounded lineage adapter. Existing watcher owns queue pressure, native evaluation and cancellation. */
export function gapStreamWatchHost(adapter:GapStreamAdapter,host:Omit<WatchHost,'blocks'>):WatchHost {
  return {current:host.current.bind(host),evaluate:host.evaluate.bind(host),persist:host.persist.bind(host),...(host.canonical?{canonical:host.canonical.bind(host)}:{}),...(host.bandInputs?{bandInputs:host.bandInputs.bind(host)}:{}),async *blocks(signal){
    let prior:GapStreamUpdate|undefined;const seen=new Map<string,string>();
    for await(const raw of adapter.updates(signal)){
      if(signal.aborted)return;
      const update=validateRecord<GapStreamUpdate>('GapStreamUpdate',raw,'5.2');
      if(update.sourceId!==adapter.sourceId||update.adapterRevision!==adapter.adapterRevision)throw new Error('STREAM_ADAPTER_MISMATCH');
      const cursor=uint(update.cursor),key=`${update.generation}:${update.cursor}`,hash=digest(update);
      if(seen.has(key)){if(seen.get(key)!==hash)throw new Error('STREAM_CURSOR_CONFLICT');continue;}
      let reason:string|undefined;
      if(prior){
        if(update.identity.networkId!==prior.identity.networkId||update.identity.namespace!==prior.identity.namespace)throw new Error('STREAM_NETWORK_MISMATCH');
        if(update.generation!==prior.generation)reason='STREAM_GENERATION_CHANGED';
        else if(cursor!==uint(prior.cursor)+1n||update.parentCursor!==prior.cursor)reason='STREAM_CURSOR_GAP';
        else if(update.parentHash!==prior.identity.stateHashOrDigest)reason='STREAM_PARENT_DIVERGENCE';
      }
      const block=reason?await adapter.resync(update,reason,signal):await adapter.capture(update,signal);
      if(signal.aborted)return;
      if(block.state.finality==='provisional'||block.state.networkId!==update.identity.networkId||block.state.namespace!==update.identity.namespace||block.state.stateHashOrDigest!==update.identity.stateHashOrDigest||block.state.height!==update.identity.height)throw new Error('STREAM_CAPTURE_MISMATCH');
      if(!block.pools.length||block.pools.length>16)throw new Error('STREAM_COVERAGE_MISSING');
      for(const rawPool of block.pools){const p=parsePoolState(rawPool);if(p.stateClass!=='canonical'||p.identity.network!==block.state.networkId||p.identity.height!==block.state.height||(p.identity.chain==='sui'?p.identity.checkpointDigest:p.identity.blockHash)!==block.state.stateHashOrDigest)throw new Error('STREAM_CAPTURE_MISMATCH');}
      await adapter.persist({code:reason??'STREAM_CANONICAL_CAPTURE',update},signal);
      prior=update;seen.set(key,hash);if(seen.size>1024)seen.delete(seen.keys().next().value!);
      yield reason?{...block,invalidated:true,sourceFailure:reason}:block;
    }
  }};
}
