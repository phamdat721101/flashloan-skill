import { readFile } from 'node:fs/promises';
import { AERO_EXECUTOR_ABI, AERO_V2_EXECUTOR_ABI } from '../aero/execution.js';
import { toFunctionSelector, toEventSelector, type Abi, type AbiFunction, type AbiEvent } from 'viem';
import { FLASH_EXECUTOR_ABI, IMMUTABLE_V4_EXECUTOR_ABI, PORTABLE_SPLIT_ABI } from '../contracts/flash-executor.js';
import { MULTI_LENDER_ROUTE_ABI } from '../liquidity/arbitrum.js';

export async function checkExecutorAbis(): Promise<void> {
  const artifact = async (name: string): Promise<Abi> => JSON.parse(await readFile(`out/${name}.sol/${name}.json`,'utf8')).abi;
  const compare = (actual: Abi, expected: Abi) => {
    for (const item of expected) if (item.type==='function') {
      const found=actual.find((a): a is AbiFunction => a.type==='function' && a.name===item.name);
      if (!found || toFunctionSelector(found)!==toFunctionSelector(item)) throw new Error(`ABI_SELECTOR_MISMATCH:${item.name}`);
    } else if(item.type==='event') {
      const found=actual.find((a): a is AbiEvent=>a.type==='event'&&a.name===item.name);
      if(!found || toEventSelector(found)!==toEventSelector(item) || JSON.stringify(found.inputs.map(i=>({name:i.name,indexed:!!i.indexed,type:i.type})))!==JSON.stringify(item.inputs.map(i=>({name:i.name,indexed:!!i.indexed,type:i.type}))))throw new Error(`ABI_EVENT_MISMATCH:${item.name}`);
    }
  };
  const multi=await artifact('MultiVenueArbitrageExecutor'), portable=await artifact('PortableMultiSplitFlashExecutor');
  compare(multi,FLASH_EXECUTOR_ABI.filter(i=>i.type==='event'&&i.name==='MultiVenueArbitrageExecuted'));
  compare(multi,MULTI_LENDER_ROUTE_ABI);compare(portable,MULTI_LENDER_ROUTE_ABI);
  for (const [name,fn] of [['MultiVenueArbitrageExecutor','executeArbitrage'],['ImmutableArbitrageExecutor','executeV4Arbitrage']] as const) {
    compare(await artifact(name),name === 'ImmutableArbitrageExecutor' ? IMMUTABLE_V4_EXECUTOR_ABI : FLASH_EXECUTOR_ABI.filter(i=>i.type==='function' && i.name===fn));
  }
  compare(portable,PORTABLE_SPLIT_ABI);
  compare(await artifact('AeroSplitFlashExecutor'),AERO_EXECUTOR_ABI);
  compare(await artifact('AeroSplitFlashExecutorV2'),AERO_V2_EXECUTOR_ABI);
  const split=portable.find((a):a is AbiFunction=>a.type==='function' && a.name==='executeSplitArbitrage');
  if(!split || split.inputs[0]?.type!=='tuple')throw new Error('SPLIT_ABI_MISSING');
  const rust=await readFile('crates/flashloan-core/src/lib.rs','utf8');
  const signature=/pub const EXECUTOR_SIGNATURE: &str =\s*"([^"]+)"/.exec(rust)?.[1];
  const legacy=(FLASH_EXECUTOR_ABI as Abi).find((a):a is AbiFunction=>a.type==='function' && a.name==='executeDexPairArbitrage');
  if(!signature || !legacy || toFunctionSelector(signature)!==toFunctionSelector(legacy))throw new Error('RUST_TYPESCRIPT_SELECTOR_MISMATCH');
}
if(process.argv[1]?.endsWith('abi-check.ts') || process.argv[1]?.endsWith('abi-check.js')) {
  checkExecutorAbis().then(()=>console.log(JSON.stringify({verified:true,check:'artifact-abi-parity'}))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
