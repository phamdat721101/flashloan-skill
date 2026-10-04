import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';
import { FLASH_EXECUTOR_ABI, FLASH_EXECUTOR_ADDRESS } from '../contracts/flash-executor.js';

test('E2E validates the reviewed executor snapshot against an explicit Arbitrum fork endpoint', { skip: !process.env.E2E_ARBITRUM_RPC_URL }, async () => {
  const client = createPublicClient({ chain: arbitrum, transport: http(process.env.E2E_ARBITRUM_RPC_URL) });
  assert.equal(await client.getChainId(), 42161);
  const bytecode = await client.getCode({ address: FLASH_EXECUTOR_ADDRESS });
  assert.ok(bytecode && bytecode !== '0x');
  const owner = await client.readContract({ address: FLASH_EXECUTOR_ADDRESS, abi: FLASH_EXECUTOR_ABI, functionName: 'owner' });
  assert.match(owner, /^0x[0-9a-fA-F]{40}$/);
});
