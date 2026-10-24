import { parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { evmProfile } from './evm-chains.js';

const gasOracle = parseAbi(['function getL1FeeUpperBound(uint256) view returns(uint256)']);
const priceAbi = parseAbi(['function decimals() view returns(uint8)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
export interface GasValuation {
  asset: Address; decimals: number; nativeUsdFeed: Address; assetUsdFeed: Address; maxAgeSeconds: number;
}
export async function priceUsdE8(client: PublicClient, feed: Address, blockNumber: bigint, maxAgeSeconds: number): Promise<bigint> {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) throw new Error('INVALID_PRICE_AGE');
  const [decimals, round, block] = await Promise.all([
    client.readContract({ address: feed, abi: priceAbi, functionName: 'decimals', blockNumber }),
    client.readContract({ address: feed, abi: priceAbi, functionName: 'latestRoundData', blockNumber }),
    client.getBlock({ blockNumber })
  ]);
  if (decimals > 18 || round[1] <= 0n || round[3] === 0n || round[4] < round[0] || block.timestamp < round[3] || block.timestamp - round[3] > BigInt(maxAgeSeconds)) throw new Error('INVALID_OR_STALE_PRICE');
  const price = round[1] * 100000000n / 10n ** BigInt(decimals);
  if (!price) throw new Error('INVALID_OR_STALE_PRICE');
  return price;
}
export async function nativeCostInAsset(client: PublicClient, cost: bigint, blockNumber: bigint, valuation: GasValuation): Promise<bigint> {
  if (!Number.isInteger(valuation.decimals) || valuation.decimals < 0 || valuation.decimals > 18) throw new Error('INVALID_ASSET_DECIMALS');
  const [native, asset] = await Promise.all([
    priceUsdE8(client, valuation.nativeUsdFeed, blockNumber, valuation.maxAgeSeconds),
    priceUsdE8(client, valuation.assetUsdFeed, blockNumber, valuation.maxAgeSeconds)
  ]);
  if (asset < 99000000n || asset > 101000000n) throw new Error('STABLECOIN_DEPEG');
  const numerator = cost * native * 10n ** BigInt(valuation.decimals), denominator = 10n ** 18n * asset;
  return (numerator + denominator - 1n) / denominator;
}
/** priorityFeePerGas, when given, replaces the estimated tip while keeping the estimated base headroom. */
export async function estimateEvmFees(client: PublicClient, chainId: number, from: Address, to: Address | undefined, data: Hex, priorityFeePerGas?: bigint) {
  const profile = evmProfile(chainId);
  const [gas, estimated] = await Promise.all([client.estimateGas({ account: from, to, data }), client.estimateFeesPerGas()]);
  const fees = priorityFeePerGas === undefined ? estimated : { maxFeePerGas: estimated.maxFeePerGas - estimated.maxPriorityFeePerGas + priorityFeePerGas, maxPriorityFeePerGas: priorityFeePerGas };
  // Nitro includes data availability in estimated gas. OP Stack charges L1 data separately.
  const publicationFee = profile.feeModel === 'op-stack' ? await client.readContract({
    address: '0x420000000000000000000000000000000000000F', abi: gasOracle, functionName: 'getL1FeeUpperBound', args: [BigInt((data.length - 2) / 2 + 256)]
  }) : 0n;
  return { gas, fees, publicationFee, nativeCost: gas * fees.maxFeePerGas + publicationFee };
}
export function receiptNativeCost(chainId: number, receipt: { gasUsed: bigint; effectiveGasPrice: bigint }, raw: unknown): bigint {
  let cost = receipt.gasUsed * receipt.effectiveGasPrice;
  if (evmProfile(chainId).feeModel === 'op-stack') {
    const fee = (raw as { l1Fee?: unknown } | null)?.l1Fee;
    if (typeof fee !== 'string' || !/^0x[0-9a-fA-F]+$/.test(fee)) throw new Error('RECEIPT_L1_FEE_UNKNOWN');
    cost += BigInt(fee);
  }
  return cost;
}
