import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, http, keccak256, parseAbi, type Address } from 'viem';
import { arbitrum } from 'viem/chains';
import { snapshotUniswapV3, snapshotUniswapV4, type StateClient, type V3Snapshot } from '../state-adapters.js';
import { quoteV3ExactInput } from '../liquidity/clmm.js';
import { readArbitrumAnalyticsSnapshot } from '../liquidity/sources.js';
import { projectPool } from '../liquidity/projection.js';
import { digest } from '../liquidity/state.js';

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

test('E2E exact V3 math matches canonical QuoterV2 output and final price at the identical block', { skip: !process.env.E2E_ARBITRUM_RPC_URL }, async () => {
  const publicClient = createPublicClient({ chain: arbitrum, transport: http(process.env.E2E_ARBITRUM_RPC_URL, { timeout: 15000, retryCount: 0 }) });
  const block = await publicClient.getBlock();
  const metadata = parseAbi(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function tickSpacing() view returns(int24)']);
  const slot = await publicClient.readContract({ address: V3_POOL, abi: metadata, functionName: 'slot0', blockNumber: block.number });
  const spacing = Number(await publicClient.readContract({ address: V3_POOL, abi: metadata, functionName: 'tickSpacing', blockNumber: block.number }));
  const center = Math.floor(Math.floor(Number(slot[1]) / spacing) / 256);
  const words = [center - 1, center, center + 1];
  const code = await publicClient.getCode({ address: V3_POOL, blockNumber: block.number }); assert.ok(code);
  const lower = Math.max(-887272, words[0] * 256 * spacing), upper = Math.min(887272, (words[2] * 256 + 255) * spacing);
  const analytics = await readArbitrumAnalyticsSnapshot(process.env.E2E_ARBITRUM_RPC_URL!,'canonical-quoter-e2e','1',[{ protocol: 'uniswap-v3',address: V3_POOL,expectedCodeHash: keccak256(code),adapterRevision: 'canonical-quoter-e2e-code-pin',bitmapWordPositions: words,lowerTick: lower,upperTick: upper }],block.number.toString());
  assert.equal(analytics.snapshot.stateDigest,digest(analytics.pools));
  assert.equal(analytics.pools[0].state.protocol,'uniswap-v3');
  const state: V3Snapshot = { ...analytics.pools[0].state,block: { chainId: 42161,number: block.number,hash: block.hash,timestamp: block.timestamp },pool: V3_POOL,runtimeCodeHash: keccak256(code),token0: analytics.pools[0].token0 as Address,token1: analytics.pools[0].token1 as Address };
  const quoter = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as Address;
  const abi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
  let crossed = false;
  for (const [tokenIn, tokenOut] of [[state.token0, state.token1], [state.token1, state.token0]]) {
    const decimals = await publicClient.readContract({ address: tokenIn, abi: parseAbi(['function decimals() view returns(uint8)']), functionName: 'decimals', blockNumber: block.number });
    // A larger bounded notional exercises actual initialized tick crossings.
    const large = decimals === 18 ? 100n * 10n ** 18n : 500000n * 10n ** BigInt(decimals);
    for (const amount of ['1000', '1000000', large.toString()]) {
      const quoted = quoteV3ExactInput(state, tokenIn, amount, lower, upper);
      const canonical = await publicClient.simulateContract({ address: quoter, abi, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn: BigInt(amount), fee: state.feePips, sqrtPriceLimitX96: 0n }], blockNumber: block.number });
      assert.equal(quoted.amountOut, canonical.result[0].toString());
      assert.equal(quoted.sqrtPriceAfterX96, canonical.result[1].toString());
      const projected = projectPool(analytics.pools[0],{ schemaVersion: '4.0',snapshotDigest: digest(analytics.pools[0]),operationId: `canonical:${tokenIn}:${amount}`,operationClass: 'hypothetical',tokenIn,amountIn: amount });
      assert.equal(projected.amountOut,canonical.result[0].toString());
      assert.equal(projected.projectedState.state.protocol,'uniswap-v3');
      assert.equal((projected.projectedState.state as { sqrtPriceX96: string }).sqrtPriceX96,canonical.result[1].toString());
      if (quoted.crossedTicks.length > 0) crossed = true;
    }
  }
  assert.equal(crossed, true, 'the canonical comparison must include an actual initialized tick crossing');
  assert.equal((await publicClient.getBlock({ blockNumber: block.number })).hash, block.hash);
  console.log(JSON.stringify({ marker: 'v3_exact_math_matches_canonical_quoter', evidence: 'read-only-arbitrum-rpc', blockNumber: block.number.toString(), blockHash: block.hash }));
});
