import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, http, keccak256, type Address } from 'viem';
import { arbitrum } from 'viem/chains';
import { snapshotUniswapV3, snapshotUniswapV4, type StateClient } from '../state-adapters.js';

const V3_POOL = '0xC6962004f452bE9203591991D15f6b388e09E8D0' as Address;
const V4_MANAGER = '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32' as Address;
const V4_MANAGER_HASH = '0xe4b2759e456c9c4ef763e3b4e257c5105e1ba283d7de8b131dd321197de794a4' as const;

test('E2E reads V3 and no-hook V4 state from one pinned Arbitrum head', { skip: !process.env.E2E_ARBITRUM_RPC_URL }, async () => {
  const publicClient = createPublicClient({ chain: arbitrum, transport: http(process.env.E2E_ARBITRUM_RPC_URL) });
  const client = publicClient as unknown as StateClient;
  const v3Code = await publicClient.getCode({ address: V3_POOL });
  assert.ok(v3Code && v3Code !== '0x');
  const v3 = await snapshotUniswapV3(client, V3_POOL, [0], { chainId: 42161, expectedRuntimeCodeHash: keccak256(v3Code), maxBitmapWords: 1 });
  assert.equal(v3.block.chainId, 42161);
  assert.ok(BigInt(v3.sqrtPriceX96) > 0n);
  assert.ok(BigInt(v3.liquidity) > 0n);

  const v4 = await snapshotUniswapV4(client, V4_MANAGER, {
    currency0: '0x2F714d7b9A035d4ce24af8d9b6091c07E37f43Fb',
    currency1: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    fee: 203181,
    tickSpacing: 10,
    hooks: '0x0000000000000000000000000000000000000000'
  }, [0], { chainId: 42161, expectedRuntimeCodeHash: V4_MANAGER_HASH, maxBitmapWords: 1 });
  assert.equal(v4.runtimeCodeHash, V4_MANAGER_HASH);
  assert.ok(BigInt(v4.sqrtPriceX96) > 0n);
  // An initialized pool can legitimately have no active in-range liquidity.
  // The adapter must preserve that exact zero rather than invent a quote.
  assert.ok(BigInt(v4.liquidity) >= 0n);
});
