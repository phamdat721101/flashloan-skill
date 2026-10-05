//! Deterministic, wallet-free live-state route analysis for the flashloan daemon.
//! JSON and network adapters deliberately stay in the daemon crate; this crate only
//! accepts validated live updates and returns candidates or typed rejections.

use alloy::primitives::{Address, U256, keccak256};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap},
    fmt,
    str::FromStr,
};

pub const ARBITRUM_CHAIN_ID: u64 = 42_161;
pub const EXECUTOR_SIGNATURE: &str =
    "executeDexPairArbitrage((address,uint256,address,uint8,uint8,uint24,uint256))";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineConfig {
    pub schema_version: String,
    pub chain_id: u64,
    pub factories: Vec<FactoryConfig>,
    pub risk: RiskPolicy,
    pub execution: ExecutionConfig,
}

impl EngineConfig {
    pub fn validate(&self) -> Result<(), EngineError> {
        if self.schema_version != "2.0" {
            return Err(EngineError::InvalidConfig("schemaVersion must be 2.0"));
        }
        if self.chain_id != ARBITRUM_CHAIN_ID {
            return Err(EngineError::InvalidConfig("chainId must be 42161"));
        }
        if self.factories.is_empty() {
            return Err(EngineError::InvalidConfig(
                "at least one factory is required",
            ));
        }
        if !(2..=6).contains(&self.risk.max_hops) {
            return Err(EngineError::InvalidConfig("risk.maxHops must be 2..=6"));
        }
        if self.risk.max_state_age_ms == 0 {
            return Err(EngineError::InvalidConfig(
                "risk.maxStateAgeMs must be positive",
            ));
        }
        for value in [
            &self.risk.min_pool_liquidity_usd_e8,
            &self.risk.min_route_liquidity_usd_e8,
            &self.risk.canary_notional_usd_e8,
        ] {
            parse_u256(value)?;
        }
        self.factories
            .iter()
            .try_for_each(|factory| parse_address(&factory.address).map(|_| ()))?;
        parse_address(&self.execution.executor.address)?;
        if !self.execution.executor.runtime_code_hash.starts_with("0x") {
            return Err(EngineError::InvalidConfig(
                "executor runtimeCodeHash must be hex",
            ));
        }
        if self.execution.executor.selector != selector_hex() {
            return Err(EngineError::InvalidConfig(
                "executor selector does not match reviewed ABI",
            ));
        }
        if self.execution.relay.protocol != "rpc-send-raw-transaction"
            || self.execution.relay.url_env.is_empty()
        {
            return Err(EngineError::InvalidConfig(
                "only rpc-send-raw-transaction relay with urlEnv is supported",
            ));
        }
        parse_u256(&self.execution.min_profit_wei)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactoryConfig {
    pub venue: VenueKind,
    pub address: String,
    pub start_block: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VenueKind {
    UniswapV2,
    UniswapV3,
    UniswapV4,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RiskPolicy {
    pub max_hops: u8,
    pub max_state_age_ms: u64,
    pub min_pool_liquidity_usd_e8: String,
    pub min_route_liquidity_usd_e8: String,
    pub canary_notional_usd_e8: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionConfig {
    pub executor: ExecutorConfig,
    pub relay: RelayConfig,
    pub min_profit_wei: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutorConfig {
    pub address: String,
    pub runtime_code_hash: String,
    pub selector: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayConfig {
    pub protocol: String,
    pub url_env: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StateSource {
    Sequencer,
    Canonical,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Head {
    pub source: StateSource,
    pub sequence: u64,
    pub block_number: u64,
    pub block_hash: String,
    pub parent_hash: String,
    pub observed_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LiveStatus {
    Bootstrapping,
    TentativeLive,
    CanonicalLive,
    ResyncRequired,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveEpoch {
    pub status: LiveStatus,
    pub sequencer: Option<Head>,
    pub canonical: Option<Head>,
}

#[derive(Clone, Debug, Default)]
pub struct LiveHeads {
    sequencer: Option<Head>,
    canonical: Option<Head>,
    desynced: bool,
}

impl LiveHeads {
    pub fn apply(&mut self, head: Head) -> Result<LiveEpoch, EngineError> {
        let slot = match head.source {
            StateSource::Sequencer => &mut self.sequencer,
            StateSource::Canonical => &mut self.canonical,
        };
        if let Some(previous) = slot {
            if head.sequence <= previous.sequence {
                return Err(EngineError::Rejected("NON_MONOTONIC_SEQUENCE"));
            }
            if head.block_number < previous.block_number {
                self.desynced = true;
            }
        }
        *slot = Some(head);
        if let (Some(sequencer), Some(canonical)) = (&self.sequencer, &self.canonical) {
            let compatible = (sequencer.block_number == canonical.block_number
                && sequencer.block_hash == canonical.block_hash)
                || (sequencer.block_number == canonical.block_number + 1
                    && sequencer.parent_hash == canonical.block_hash);
            if !compatible {
                self.desynced = true;
            }
        }
        Ok(self.epoch())
    }

    pub fn epoch(&self) -> LiveEpoch {
        let status = if self.desynced {
            LiveStatus::ResyncRequired
        } else if let (Some(sequencer), Some(canonical)) = (&self.sequencer, &self.canonical) {
            if sequencer.block_number == canonical.block_number {
                LiveStatus::CanonicalLive
            } else {
                LiveStatus::TentativeLive
            }
        } else {
            LiveStatus::Bootstrapping
        };
        LiveEpoch {
            status,
            sequencer: self.sequencer.clone(),
            canonical: self.canonical.clone(),
        }
    }

    pub fn executable_epoch(&self, now_ms: u64, max_age_ms: u64) -> Result<LiveEpoch, EngineError> {
        let epoch = self.epoch();
        if !matches!(
            epoch.status,
            LiveStatus::TentativeLive | LiveStatus::CanonicalLive
        ) {
            return Err(EngineError::Rejected("LIVE_HEAD_NOT_READY"));
        }
        let newest = epoch
            .sequencer
            .as_ref()
            .expect("status guarantees sequencer");
        if now_ms.saturating_sub(newest.observed_at_ms) > max_age_ms {
            return Err(EngineError::Rejected("STALE_LIVE_STATE"));
        }
        Ok(epoch)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pool {
    pub id: String,
    pub venue: VenueKind,
    pub venue_id: u8,
    pub token0: String,
    pub token1: String,
    pub state: PoolState,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PoolState {
    V2 {
        reserve0: String,
        reserve1: String,
        fee_bps: u16,
    },
    V3 {
        liquidity: String,
        sqrt_price_x96: String,
        sqrt_price_limit_0_to_1_x96: String,
        sqrt_price_limit_1_to_0_x96: String,
        fee_pips: u32,
    },
    V4DiscoveryOnly,
}

impl Pool {
    pub fn quote(
        &self,
        token_in: &str,
        amount_in: U256,
    ) -> Result<Option<(String, U256)>, EngineError> {
        let zero_for_one = if token_in.eq_ignore_ascii_case(&self.token0) {
            true
        } else if token_in.eq_ignore_ascii_case(&self.token1) {
            false
        } else {
            return Ok(None);
        };
        let output_token = if zero_for_one {
            self.token1.clone()
        } else {
            self.token0.clone()
        };
        let out = match &self.state {
            PoolState::V2 {
                reserve0,
                reserve1,
                fee_bps,
            } => quote_v2(
                amount_in,
                parse_u256(if zero_for_one { reserve0 } else { reserve1 })?,
                parse_u256(if zero_for_one { reserve1 } else { reserve0 })?,
                *fee_bps,
            )?,
            PoolState::V3 {
                liquidity,
                sqrt_price_x96,
                sqrt_price_limit_0_to_1_x96,
                sqrt_price_limit_1_to_0_x96,
                fee_pips,
            } => quote_v3_single_tick(
                amount_in,
                parse_u256(liquidity)?,
                parse_u256(sqrt_price_x96)?,
                parse_u256(if zero_for_one {
                    sqrt_price_limit_0_to_1_x96
                } else {
                    sqrt_price_limit_1_to_0_x96
                })?,
                *fee_pips,
                zero_for_one,
            )?,
            PoolState::V4DiscoveryOnly => return Ok(None),
        };
        Ok(out
            .filter(|amount| *amount > U256::ZERO)
            .map(|amount| (output_token, amount)))
    }
}

pub fn quote_v2(
    amount_in: U256,
    reserve_in: U256,
    reserve_out: U256,
    fee_bps: u16,
) -> Result<Option<U256>, EngineError> {
    if amount_in.is_zero() || reserve_in.is_zero() || reserve_out.is_zero() || fee_bps >= 10_000 {
        return Ok(None);
    }
    let adjusted = amount_in
        .checked_mul(U256::from(10_000u64 - fee_bps as u64))
        .ok_or(EngineError::MathOverflow)?
        / U256::from(10_000u64);
    let numerator = reserve_out
        .checked_mul(adjusted)
        .ok_or(EngineError::MathOverflow)?;
    Ok(Some(
        numerator
            / reserve_in
                .checked_add(adjusted)
                .ok_or(EngineError::MathOverflow)?,
    ))
}

/// Exact-input V3 quote restricted to the currently known initialized-tick interval.
/// A route that would cross the supplied nearest-tick limit is rejected instead of estimated.
pub fn quote_v3_single_tick(
    amount_in: U256,
    liquidity: U256,
    sqrt_price_x96: U256,
    limit_x96: U256,
    fee_pips: u32,
    zero_for_one: bool,
) -> Result<Option<U256>, EngineError> {
    const Q96: U256 = U256::from_limbs([0, 1, 0, 0]);
    if amount_in.is_zero()
        || liquidity.is_zero()
        || sqrt_price_x96.is_zero()
        || fee_pips >= 1_000_000
    {
        return Ok(None);
    }
    let amount_after_fee = amount_in
        .checked_mul(U256::from(1_000_000u64 - fee_pips as u64))
        .ok_or(EngineError::MathOverflow)?
        / U256::from(1_000_000u64);
    if zero_for_one {
        let term = amount_after_fee
            .checked_mul(sqrt_price_x96)
            .ok_or(EngineError::MathOverflow)?
            / Q96;
        let next = liquidity
            .checked_mul(sqrt_price_x96)
            .ok_or(EngineError::MathOverflow)?
            / liquidity
                .checked_add(term)
                .ok_or(EngineError::MathOverflow)?;
        if next < limit_x96 || next >= sqrt_price_x96 {
            return Ok(None);
        }
        Ok(Some(
            liquidity
                .checked_mul(sqrt_price_x96 - next)
                .ok_or(EngineError::MathOverflow)?
                / Q96,
        ))
    } else {
        let next = sqrt_price_x96
            .checked_add(
                amount_after_fee
                    .checked_mul(Q96)
                    .ok_or(EngineError::MathOverflow)?
                    / liquidity,
            )
            .ok_or(EngineError::MathOverflow)?;
        if next > limit_x96 || next <= sqrt_price_x96 {
            return Ok(None);
        }
        let numerator = liquidity
            .checked_mul(next - sqrt_price_x96)
            .ok_or(EngineError::MathOverflow)?
            .checked_mul(Q96)
            .ok_or(EngineError::MathOverflow)?;
        Ok(Some(
            numerator
                / next
                    .checked_mul(sqrt_price_x96)
                    .ok_or(EngineError::MathOverflow)?,
        ))
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteCandidate {
    pub token_in: String,
    pub amount_in: String,
    pub amount_out: String,
    pub hops: Vec<RouteHop>,
    pub executable: bool,
    pub rejection_code: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteHop {
    pub pool_id: String,
    pub venue: VenueKind,
    pub venue_id: u8,
    pub token_in: String,
    pub token_out: String,
}

pub fn find_affected_cycles(
    pools: &[Pool],
    anchor_token: &str,
    amount_in: U256,
    max_hops: u8,
) -> Result<Vec<RouteCandidate>, EngineError> {
    if !(2..=6).contains(&max_hops) {
        return Err(EngineError::InvalidConfig("max hops must be 2..=6"));
    }
    let mut search = RouteSearch::new(pools, anchor_token, amount_in, max_hops);
    search.visit(anchor_token, amount_in)?;
    let mut routes = search.routes;
    routes.sort_by(|left, right| {
        parse_u256(&right.amount_out)
            .expect("candidate output is produced from U256")
            .cmp(&parse_u256(&left.amount_out).expect("candidate output is produced from U256"))
    });
    Ok(routes)
}

struct RouteSearch<'a> {
    pools: &'a [Pool],
    anchor: &'a str,
    amount_in: U256,
    max_hops: u8,
    used: BTreeSet<String>,
    hops: Vec<RouteHop>,
    routes: Vec<RouteCandidate>,
}

impl<'a> RouteSearch<'a> {
    fn new(pools: &'a [Pool], anchor: &'a str, amount_in: U256, max_hops: u8) -> Self {
        Self {
            pools,
            anchor,
            amount_in,
            max_hops,
            used: BTreeSet::new(),
            hops: Vec::new(),
            routes: Vec::new(),
        }
    }

    fn visit(&mut self, token: &str, amount: U256) -> Result<(), EngineError> {
        if self.hops.len() == self.max_hops as usize {
            return Ok(());
        }
        for pool in self.pools {
            if self.used.contains(&pool.id) {
                continue;
            }
            let Some((next_token, next_amount)) = pool.quote(token, amount)? else {
                continue;
            };
            self.used.insert(pool.id.clone());
            self.hops.push(RouteHop {
                pool_id: pool.id.clone(),
                venue: pool.venue,
                venue_id: pool.venue_id,
                token_in: token.into(),
                token_out: next_token.clone(),
            });
            if next_token.eq_ignore_ascii_case(self.anchor)
                && self.hops.len() >= 2
                && next_amount > self.amount_in
            {
                let executable = self.hops.len() == 2;
                self.routes.push(RouteCandidate {
                    token_in: self.anchor.into(),
                    amount_in: self.amount_in.to_string(),
                    amount_out: next_amount.to_string(),
                    hops: self.hops.clone(),
                    executable,
                    rejection_code: (!executable).then_some("EXECUTOR_CAPABILITY_UNAVAILABLE"),
                });
            } else if !next_token.eq_ignore_ascii_case(self.anchor) {
                self.visit(&next_token, next_amount)?;
            }
            self.hops.pop();
            self.used.remove(&pool.id);
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct DexPairCall {
    pub flash_token: String,
    pub flash_amount: U256,
    pub target_token: String,
    pub buy_venue: u8,
    pub sell_venue: u8,
    pub uni_fee: u32,
    pub min_profit: U256,
}

impl DexPairCall {
    pub fn from_two_hop(
        candidate: &RouteCandidate,
        pools: &HashMap<String, Pool>,
        min_profit: U256,
    ) -> Result<Self, EngineError> {
        if candidate.hops.len() != 2 {
            return Err(EngineError::Rejected("EXECUTOR_CAPABILITY_UNAVAILABLE"));
        }
        let first = &candidate.hops[0];
        let second = &candidate.hops[1];
        let pool = pools
            .get(&first.pool_id)
            .ok_or(EngineError::Rejected("UNKNOWN_POOL"))?;
        let uni_fee = match &pool.state {
            PoolState::V3 { fee_pips, .. } => *fee_pips,
            _ => 0,
        };
        Ok(Self {
            flash_token: candidate.token_in.clone(),
            flash_amount: parse_u256(&candidate.amount_in)?,
            target_token: first.token_out.clone(),
            buy_venue: first.venue_id,
            sell_venue: second.venue_id,
            uni_fee,
            min_profit,
        })
    }

    pub fn calldata(&self) -> Result<Vec<u8>, EngineError> {
        let flash = parse_address(&self.flash_token)?;
        let target = parse_address(&self.target_token)?;
        if self.uni_fee > 0x00ff_ffff {
            return Err(EngineError::Rejected("INVALID_UNISWAP_FEE"));
        }
        let mut encoded = Vec::with_capacity(4 + 32 * 7);
        encoded.extend_from_slice(&keccak256(EXECUTOR_SIGNATURE.as_bytes()).as_slice()[..4]);
        encoded.extend_from_slice(&word_address(flash));
        encoded.extend_from_slice(&word_u256(self.flash_amount));
        encoded.extend_from_slice(&word_address(target));
        encoded.extend_from_slice(&word_u256(U256::from(self.buy_venue)));
        encoded.extend_from_slice(&word_u256(U256::from(self.sell_venue)));
        encoded.extend_from_slice(&word_u256(U256::from(self.uni_fee)));
        encoded.extend_from_slice(&word_u256(self.min_profit));
        Ok(encoded)
    }
}

pub fn selector_hex() -> String {
    format!(
        "0x{}",
        hex_encode(&keccak256(EXECUTOR_SIGNATURE.as_bytes()).as_slice()[..4])
    )
}
fn parse_address(value: &str) -> Result<Address, EngineError> {
    Address::from_str(value).map_err(|_| EngineError::InvalidConfig("invalid address"))
}
fn parse_u256(value: &str) -> Result<U256, EngineError> {
    U256::from_str(value).map_err(|_| EngineError::InvalidConfig("invalid decimal uint256"))
}
fn word_address(address: Address) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address.as_slice());
    word
}
fn word_u256(value: U256) -> [u8; 32] {
    value.to_be_bytes::<32>()
}
pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineError {
    InvalidConfig(&'static str),
    Rejected(&'static str),
    MathOverflow,
}
impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig(message) => write!(f, "INVALID_CONFIG:{message}"),
            Self::Rejected(code) => write!(f, "REJECTED:{code}"),
            Self::MathOverflow => write!(f, "REJECTED:MATH_OVERFLOW"),
        }
    }
}
impl std::error::Error for EngineError {}

#[cfg(test)]
mod tests {
    use super::*;
    fn v2(
        id: &str,
        token0: &str,
        token1: &str,
        reserve0: &str,
        reserve1: &str,
        venue_id: u8,
    ) -> Pool {
        Pool {
            id: id.into(),
            venue: VenueKind::UniswapV2,
            venue_id,
            token0: token0.into(),
            token1: token1.into(),
            state: PoolState::V2 {
                reserve0: reserve0.into(),
                reserve1: reserve1.into(),
                fee_bps: 30,
            },
        }
    }

    #[test]
    fn constant_product_quote_is_integer_and_positive() {
        assert_eq!(
            quote_v2(
                U256::from(1_000u64),
                U256::from(10_000u64),
                U256::from(20_000u64),
                30
            )
            .unwrap(),
            Some(U256::from(1_813u64))
        );
    }

    #[test]
    fn v3_quote_rejects_tick_crossing_instead_of_estimating() {
        let q96 = U256::from_limbs([0, 1, 0, 0]);
        let within_tick = quote_v3_single_tick(
            U256::from(1_000u64),
            U256::from(1_000_000_000_000u64),
            q96,
            q96 / U256::from(2u64),
            3_000,
            true,
        )
        .unwrap();
        assert!(within_tick.is_some());
        let crossing = quote_v3_single_tick(
            U256::from(1_000u64),
            U256::from(1_000_000_000_000u64),
            q96,
            q96,
            3_000,
            true,
        )
        .unwrap();
        assert!(crossing.is_none());
    }
    #[test]
    fn heads_require_both_feeds_and_reject_divergence() {
        let mut heads = LiveHeads::default();
        heads
            .apply(Head {
                source: StateSource::Canonical,
                sequence: 1,
                block_number: 100,
                block_hash: "0xa".into(),
                parent_hash: "0x9".into(),
                observed_at_ms: 10,
            })
            .unwrap();
        assert_eq!(heads.epoch().status, LiveStatus::Bootstrapping);
        heads
            .apply(Head {
                source: StateSource::Sequencer,
                sequence: 1,
                block_number: 101,
                block_hash: "0xb".into(),
                parent_hash: "0xa".into(),
                observed_at_ms: 11,
            })
            .unwrap();
        assert_eq!(
            heads.executable_epoch(20, 20).unwrap().status,
            LiveStatus::TentativeLive
        );
        heads
            .apply(Head {
                source: StateSource::Canonical,
                sequence: 2,
                block_number: 101,
                block_hash: "0xc".into(),
                parent_hash: "0xa".into(),
                observed_at_ms: 12,
            })
            .unwrap();
        assert_eq!(heads.epoch().status, LiveStatus::ResyncRequired);
    }
    #[test]
    fn affected_cycle_finds_two_hop_profit_and_flags_longer_routes() {
        let pools = vec![
            v2(
                "buy",
                "0x0000000000000000000000000000000000000001",
                "0x0000000000000000000000000000000000000002",
                "100000",
                "200000",
                1,
            ),
            v2(
                "sell",
                "0x0000000000000000000000000000000000000002",
                "0x0000000000000000000000000000000000000001",
                "100000",
                "200000",
                2,
            ),
        ];
        let routes = find_affected_cycles(
            &pools,
            "0x0000000000000000000000000000000000000001",
            U256::from(1_000u64),
            6,
        )
        .unwrap();
        assert_eq!(routes.len(), 1);
        assert!(routes[0].executable);
        assert_eq!(routes[0].hops.len(), 2);
    }
    #[test]
    fn executor_call_matches_reviewed_abi_layout() {
        let call = DexPairCall {
            flash_token: "0x0000000000000000000000000000000000000001".into(),
            flash_amount: U256::from(7u64),
            target_token: "0x0000000000000000000000000000000000000002".into(),
            buy_venue: 1,
            sell_venue: 2,
            uni_fee: 500,
            min_profit: U256::from(3u64),
        };
        let data = call.calldata().unwrap();
        assert_eq!(data.len(), 4 + 32 * 7);
        assert_eq!(selector_hex(), "0x0bde7b85");
        assert_eq!(format!("0x{}", hex_encode(&data[..4])), selector_hex());
        assert_eq!(data[4 + 31], 1);
    }

    #[test]
    fn config_rejects_unreviewed_relay_protocol() {
        let config: EngineConfig = serde_json::from_value(serde_json::json!({
            "schemaVersion": "2.0", "chainId": 42161,
            "factories": [{ "venue": "uniswap-v2", "address": "0x0000000000000000000000000000000000000001", "startBlock": 1 }],
            "risk": { "maxHops": 6, "maxStateAgeMs": 1000, "minPoolLiquidityUsdE8": "2500000", "minRouteLiquidityUsdE8": "10000000", "canaryNotionalUsdE8": "1000000000" },
            "execution": { "executor": { "address": "0x0000000000000000000000000000000000000001", "runtimeCodeHash": "0x01", "selector": selector_hex() }, "relay": { "protocol": "public-rpc", "urlEnv": "PRIVATE_RELAY_URL" }, "minProfitWei": "1" }
        })).unwrap();
        assert!(matches!(
            config.validate(),
            Err(EngineError::InvalidConfig(
                "only rpc-send-raw-transaction relay with urlEnv is supported"
            ))
        ));
    }
}
