import {
  concatHex,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  keccak256,
  padHex,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex
} from 'viem';

export interface PinnedBlock {
  chainId: number;
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

/** Deliberately small read-only surface so adapters are unit-testable and cannot sign or send. */
export interface StateClient {
  getChainId(): Promise<number>;
  getBlock(args?: { blockNumber?: bigint }): Promise<{ number: bigint; hash: Hex | null; timestamp: bigint }>;
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber: bigint }): Promise<unknown>;
}

export interface AdapterPolicy {
  chainId: number;
  expectedRuntimeCodeHash: Hex;
  maxBitmapWords: number;
}

export interface TickState {
  tick: number;
  liquidityGross: string;
  liquidityNet: string;
}

export interface V3Snapshot {
  protocol: 'uniswap-v3';
  block: PinnedBlock;
  pool: Address;
  runtimeCodeHash: Hex;
  token0: Address;
  token1: Address;
  feePips: number;
  tickSpacing: number;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  unlocked: boolean;
  bitmapWords: Array<{ wordPosition: number; bitmap: string }>;
  initializedTicks: TickState[];
}

export interface AlgebraSnapshot {
  protocol: 'algebra-integral';
  block: PinnedBlock;
  pool: Address;
  runtimeCodeHash: Hex;
  token0: Address;
  token1: Address;
  feePips: number;
  tickSpacing: number;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  unlocked: boolean;
  bitmapWords: Array<{ wordPosition: number; bitmap: string }>;
  initializedTicks: TickState[];
}

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface V4Snapshot {
  protocol: 'uniswap-v4';
  block: PinnedBlock;
  poolManager: Address;
  poolId: Hex;
  runtimeCodeHash: Hex;
  key: V4PoolKey;
  sqrtPriceX96: string;
  tick: number;
  protocolFeePips: number;
  lpFeePips: number;
  liquidity: string;
  bitmapWords: Array<{ wordPosition: number; bitmap: string }>;
  initializedTicks: TickState[];
}

const V3_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function tickBitmap(int16) view returns (uint256)',
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)'
]);

const ALGEBRA_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function tickSpacing() view returns (int24)',
  'function tickTable(int16) view returns (uint256)',
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 outerFeeGrowth0Token, uint256 outerFeeGrowth1Token, int56 outerTickCumulative, int160 outerSecondsPerLiquidity, uint32 outerSecondsSpent, bool initialized)'
]);

const V4_ABI = parseAbi([
  'function extsload(bytes32 slot) view returns (bytes32)',
  'function extsload(bytes32 startSlot, uint256 nSlots) view returns (bytes32[])'
]);

const MASK_128 = (1n << 128n) - 1n;
const MASK_160 = (1n << 160n) - 1n;
const MASK_24 = (1n << 24n) - 1n;
const V4_POOLS_SLOT = 6n;
const V4_LIQUIDITY_OFFSET = 3n;
const V4_TICKS_OFFSET = 4n;
const V4_TICK_BITMAP_OFFSET = 5n;

function fail(code: string): never { throw new Error(code); }

function asAddress(value: unknown): Address {
  if (typeof value !== 'string') return fail('ADAPTER_INVALID_ADDRESS');
  return getAddress(value) as Address;
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'string' && value.length <= 79 && /^-?(0|[1-9][0-9]*)$/.test(value) && value !== '-0') return BigInt(value);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return fail('ADAPTER_INVALID_INTEGER');
}

function asTuple(value: unknown, length: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < length) return fail('ADAPTER_INVALID_TUPLE');
  return value;
}

function asNumber(value: unknown): number {
  const parsed = asBigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) fail('ADAPTER_INTEGER_OUT_OF_RANGE');
  return Number(parsed);
}

function signed(value: bigint, bits: bigint): bigint {
  const sign = 1n << (bits - 1n);
  const modulus = 1n << bits;
  return value & sign ? value - modulus : value;
}

function hexWord(value: bigint): Hex { return padHex(toHex(value), { size: 32 }); }
function slotAdd(slot: Hex, offset: bigint): Hex { return hexWord(BigInt(slot) + offset); }

function assertBitmapWords(words: readonly number[], max: number): void {
  if (!Number.isInteger(max) || max < 1 || words.length === 0 || words.length > max) fail('ADAPTER_INVALID_BITMAP_WINDOW');
  if (new Set(words).size !== words.length || words.some((word) => !Number.isInteger(word) || word < -32768 || word > 32767)) fail('ADAPTER_INVALID_BITMAP_WORD');
}

function ticksFromBitmaps(words: ReadonlyMap<number, bigint>, tickSpacing: number): number[] {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) fail('ADAPTER_INVALID_TICK_SPACING');
  const result: number[] = [];
  for (const [wordPosition, bitmap] of words) {
    if (bitmap < 0n || bitmap >= 1n << 256n) fail('ADAPTER_INVALID_BITMAP_WORD');
    for (let bit = 0; bit < 256; bit++) {
      if ((bitmap & (1n << BigInt(bit))) !== 0n) result.push((wordPosition * 256 + bit) * tickSpacing);
    }
  }
  return result.sort((left, right) => left - right);
}

function initializedTick(tick: number, grossValue: unknown, netValue: unknown, initialized = true): TickState {
  const gross = asBigInt(grossValue), net = asBigInt(netValue);
  const absNet = net < 0n ? -net : net;
  if (!initialized || gross <= 0n || gross >= 1n << 128n || net < -(1n << 127n) || net >= 1n << 127n || absNet > gross) fail('ADAPTER_BITMAP_TICK_MISMATCH');
  return { tick, liquidityGross: gross.toString(), liquidityNet: net.toString() };
}

/** A quote horizon needs every bitmap word and initialized tick in its interval. */
export function assertTickWindowCoverage(snapshot: Pick<V3Snapshot, 'tick' | 'tickSpacing' | 'bitmapWords' | 'initializedTicks'>, lowerTick: number, upperTick: number): void {
  if (!Number.isInteger(lowerTick) || !Number.isInteger(upperTick) || lowerTick < -887272 || upperTick > 887272 || lowerTick >= upperTick || snapshot.tick < lowerTick || snapshot.tick > upperTick || !Number.isInteger(snapshot.tickSpacing) || snapshot.tickSpacing <= 0) fail('ADAPTER_INVALID_QUOTE_HORIZON');
  const firstWord = Math.floor(Math.floor(lowerTick / snapshot.tickSpacing) / 256);
  const lastWord = Math.floor(Math.floor(upperTick / snapshot.tickSpacing) / 256);
  const words = new Map(snapshot.bitmapWords.map(word => [word.wordPosition, BigInt(word.bitmap)]));
  if (words.size !== snapshot.bitmapWords.length) fail('ADAPTER_INVALID_BITMAP_WORD');
  for (let position = firstWord; position <= lastWord; position++) {
    const value = words.get(position);
    if (value === undefined || value < 0n || value >= 1n << 256n) fail('ADAPTER_TICK_COVERAGE_INCOMPLETE');
  }
  const ticks = new Map(snapshot.initializedTicks.map(tick => [tick.tick, tick]));
  if (ticks.size !== snapshot.initializedTicks.length) fail('ADAPTER_BITMAP_TICK_MISMATCH');
  for (const [tick, state] of ticks) {
    if (!Number.isInteger(tick) || tick % snapshot.tickSpacing !== 0) fail('ADAPTER_BITMAP_TICK_MISMATCH');
    if (tick < lowerTick || tick > upperTick) continue;
    const compressed = tick / snapshot.tickSpacing, wordPosition = Math.floor(compressed / 256), bit = compressed - wordPosition * 256;
    if (((words.get(wordPosition) ?? 0n) & (1n << BigInt(bit))) === 0n) fail('ADAPTER_BITMAP_TICK_MISMATCH');
    initializedTick(tick, state.liquidityGross, state.liquidityNet);
  }
  for (const tick of ticksFromBitmaps(words, snapshot.tickSpacing)) {
    if (tick < lowerTick || tick > upperTick) continue;
    const state = ticks.get(tick);
    if (!state) fail('ADAPTER_TICK_COVERAGE_INCOMPLETE');
    initializedTick(tick, state.liquidityGross, state.liquidityNet);
  }
}

async function pinBlock(client: StateClient, policy: AdapterPolicy): Promise<PinnedBlock> {
  if (await client.getChainId() !== policy.chainId) fail('ADAPTER_CHAIN_MISMATCH');
  const head = await client.getBlock();
  if (head.hash === null) fail('ADAPTER_HEAD_HASH_MISSING');
  return { chainId: policy.chainId, number: head.number, hash: head.hash, timestamp: head.timestamp };
}

async function runtimeHash(client: StateClient, address: Address, block: PinnedBlock, expected: Hex): Promise<Hex> {
  const code = await client.getCode({ address, blockNumber: block.number });
  if (!code || code === '0x') fail('ADAPTER_CODE_MISSING');
  const actual = keccak256(code);
  if (actual.toLowerCase() !== expected.toLowerCase()) fail('ADAPTER_CODE_HASH_MISMATCH');
  return actual;
}

async function verifyHead(client: StateClient, block: PinnedBlock): Promise<void> {
  const reread = await client.getBlock({ blockNumber: block.number });
  if (reread.hash?.toLowerCase() !== block.hash.toLowerCase()) fail('ADAPTER_REORG_DETECTED');
}

async function read(client: StateClient, address: Address, abi: readonly unknown[], functionName: string, block: PinnedBlock, args: readonly unknown[] = []): Promise<unknown> {
  return client.readContract({ address, abi, functionName, args, blockNumber: block.number });
}

export async function snapshotUniswapV3(client: StateClient, pool: Address, bitmapWordPositions: readonly number[], policy: AdapterPolicy): Promise<V3Snapshot> {
  assertBitmapWords(bitmapWordPositions, policy.maxBitmapWords);
  const block = await pinBlock(client, policy);
  const runtimeCodeHash = await runtimeHash(client, pool, block, policy.expectedRuntimeCodeHash);
  const [token0, token1, fee, tickSpacing, slot0, liquidity, bitmapValues] = await Promise.all([
    read(client, pool, V3_ABI, 'token0', block), read(client, pool, V3_ABI, 'token1', block), read(client, pool, V3_ABI, 'fee', block),
    read(client, pool, V3_ABI, 'tickSpacing', block), read(client, pool, V3_ABI, 'slot0', block), read(client, pool, V3_ABI, 'liquidity', block),
    Promise.all(bitmapWordPositions.map((word) => read(client, pool, V3_ABI, 'tickBitmap', block, [word])))
  ]);
  const spacing = asNumber(tickSpacing);
  const bitmaps = new Map(bitmapWordPositions.map((word, index) => [word, asBigInt(bitmapValues[index])]));
  const ticks = ticksFromBitmaps(bitmaps, spacing);
  const tickValues = await Promise.all(ticks.map((tick) => read(client, pool, V3_ABI, 'ticks', block, [tick])));
  const state = asTuple(slot0, 7);
  const initializedTicks = ticks.map((tick, index) => {
    const value = asTuple(tickValues[index], 8);
    return initializedTick(tick, value[0], value[1], value[7] === true);
  });
  await verifyHead(client, block);
  return { protocol: 'uniswap-v3', block, pool, runtimeCodeHash, token0: asAddress(token0), token1: asAddress(token1), feePips: asNumber(fee), tickSpacing: spacing, sqrtPriceX96: asBigInt(state[0]).toString(), tick: asNumber(state[1]), liquidity: asBigInt(liquidity).toString(), unlocked: state[6] === true, bitmapWords: bitmapWordPositions.map((word) => ({ wordPosition: word, bitmap: bitmaps.get(word)!.toString() })), initializedTicks };
}

export async function snapshotAlgebraIntegral(client: StateClient, pool: Address, bitmapWordPositions: readonly number[], policy: AdapterPolicy): Promise<AlgebraSnapshot> {
  assertBitmapWords(bitmapWordPositions, policy.maxBitmapWords);
  const block = await pinBlock(client, policy);
  const runtimeCodeHash = await runtimeHash(client, pool, block, policy.expectedRuntimeCodeHash);
  const [token0, token1, globalState, liquidity, tickSpacing, bitmapValues] = await Promise.all([
    read(client, pool, ALGEBRA_ABI, 'token0', block), read(client, pool, ALGEBRA_ABI, 'token1', block), read(client, pool, ALGEBRA_ABI, 'globalState', block),
    read(client, pool, ALGEBRA_ABI, 'liquidity', block), read(client, pool, ALGEBRA_ABI, 'tickSpacing', block),
    Promise.all(bitmapWordPositions.map((word) => read(client, pool, ALGEBRA_ABI, 'tickTable', block, [word])))
  ]);
  const spacing = asNumber(tickSpacing);
  const bitmaps = new Map(bitmapWordPositions.map((word, index) => [word, asBigInt(bitmapValues[index])]));
  const ticks = ticksFromBitmaps(bitmaps, spacing);
  const tickValues = await Promise.all(ticks.map((tick) => read(client, pool, ALGEBRA_ABI, 'ticks', block, [tick])));
  const state = asTuple(globalState, 7);
  const initializedTicks = ticks.map((tick, index) => {
    const value = asTuple(tickValues[index], 8);
    return initializedTick(tick, value[0], value[1], value[7] === true);
  });
  await verifyHead(client, block);
  return { protocol: 'algebra-integral', block, pool, runtimeCodeHash, token0: asAddress(token0), token1: asAddress(token1), feePips: asNumber(state[2]), tickSpacing: spacing, sqrtPriceX96: asBigInt(state[0]).toString(), tick: asNumber(state[1]), liquidity: asBigInt(liquidity).toString(), unlocked: state[6] === true, bitmapWords: bitmapWordPositions.map((word) => ({ wordPosition: word, bitmap: bitmaps.get(word)!.toString() })), initializedTicks };
}

export function poolIdFromKey(key: V4PoolKey): Hex {
  if (key.currency0.toLowerCase() >= key.currency1.toLowerCase() || key.tickSpacing <= 0 || key.hooks.toLowerCase() !== zeroAddress) fail('V4_POOL_KEY_REJECTED');
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}

function v4PoolStateSlot(poolId: Hex): Hex { return keccak256(concatHex([poolId, hexWord(V4_POOLS_SLOT)])); }
function v4MappingSlot(key: bigint, mappingSlot: Hex): Hex { return keccak256(encodePacked(['int256', 'bytes32'], [key, mappingSlot])); }

export async function snapshotUniswapV4(client: StateClient, poolManager: Address, key: V4PoolKey, bitmapWordPositions: readonly number[], policy: AdapterPolicy): Promise<V4Snapshot> {
  assertBitmapWords(bitmapWordPositions, policy.maxBitmapWords);
  const poolId = poolIdFromKey(key);
  const block = await pinBlock(client, policy);
  const runtimeCodeHash = await runtimeHash(client, poolManager, block, policy.expectedRuntimeCodeHash);
  const stateSlot = v4PoolStateSlot(poolId);
  const [slot0Word, liquidityWord, bitmapValues] = await Promise.all([
    read(client, poolManager, V4_ABI, 'extsload', block, [stateSlot]),
    read(client, poolManager, V4_ABI, 'extsload', block, [slotAdd(stateSlot, V4_LIQUIDITY_OFFSET)]),
    Promise.all(bitmapWordPositions.map((word) => read(client, poolManager, V4_ABI, 'extsload', block, [v4MappingSlot(BigInt(word), slotAdd(stateSlot, V4_TICK_BITMAP_OFFSET))])))
  ]);
  const slot0 = BigInt(slot0Word as Hex);
  const spacing = key.tickSpacing;
  const bitmaps = new Map(bitmapWordPositions.map((word, index) => [word, BigInt(bitmapValues[index] as Hex)]));
  const ticks = ticksFromBitmaps(bitmaps, spacing);
  const tickWords = await Promise.all(ticks.map((tick) => read(client, poolManager, V4_ABI, 'extsload', block, [v4MappingSlot(BigInt(tick), slotAdd(stateSlot, V4_TICKS_OFFSET))])));
  const initializedTicks = ticks.map((tick, index) => {
    const word = BigInt(tickWords[index] as Hex);
    const gross = word & MASK_128;
    return initializedTick(tick, gross, signed(word >> 128n, 128n));
  });
  await verifyHead(client, block);
  return { protocol: 'uniswap-v4', block, poolManager, poolId, runtimeCodeHash, key, sqrtPriceX96: (slot0 & MASK_160).toString(), tick: Number(signed((slot0 >> 160n) & MASK_24, 24n)), protocolFeePips: Number((slot0 >> 184n) & MASK_24), lpFeePips: Number((slot0 >> 208n) & MASK_24), liquidity: (BigInt(liquidityWord as Hex) & MASK_128).toString(), bitmapWords: bitmapWordPositions.map((word) => ({ wordPosition: word, bitmap: bitmaps.get(word)!.toString() })), initializedTicks };
}
