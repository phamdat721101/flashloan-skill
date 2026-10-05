import { parseAbi, type PublicClient } from 'viem';
import type { Address } from '../types.js';

const CHAINLINK_ABI = parseAbi(['function decimals() view returns (uint8)', 'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)']);

/** Reads and normalizes a Chainlink USD price to 1e8 at one pinned block. */
export async function readChainlinkUsdE8(client: PublicClient, oracle: Address, blockNumber: bigint, maxAgeSeconds: number, nowSeconds = Math.floor(Date.now() / 1_000)): Promise<bigint> {
  const [decimals, round] = await Promise.all([client.readContract({ address: oracle, abi: CHAINLINK_ABI, functionName: 'decimals', blockNumber }), client.readContract({ address: oracle, abi: CHAINLINK_ABI, functionName: 'latestRoundData', blockNumber })]);
  if (round[1] <= 0n || round[3] === 0n || nowSeconds - Number(round[3]) > maxAgeSeconds) throw new Error('oracle price is missing or stale');
  return decimals === 8 ? round[1] : decimals < 8 ? round[1] * 10n ** BigInt(8 - decimals) : round[1] / 10n ** BigInt(decimals - 8);
}

export function formatUsdE8(value: bigint): string {
  return `${value / 100_000_000n}.${(value % 100_000_000n).toString().padStart(8, '0')}`;
}
