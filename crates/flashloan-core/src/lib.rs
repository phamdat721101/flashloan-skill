//! Deterministic, wallet-free live-state route analysis for the flashloan daemon.
//! JSON and network adapters deliberately stay in the daemon crate; this crate only
//! accepts validated live updates and returns candidates or typed rejections.

use alloy::primitives::{Address, U256, Uint, keccak256};
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
        if ![ARBITRUM_CHAIN_ID, 8453, 4663].contains(&self.chain_id) {
            return Err(EngineError::InvalidConfig("unsupported EVM chainId"));
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
    /// Discovery paths may omit this field. Speculative execution paths must
    /// bind it to the live epoch before using the pool as mathematical input.
    #[serde(default)]
    pub snapshot: Option<PoolSnapshot>,
    pub state: PoolState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolSnapshot {
    pub block_number: u64,
    pub block_hash: String,
    pub observed_at_ms: u64,
}

pub fn require_current_pool_snapshot(
    pool: &Pool,
    epoch: &LiveEpoch,
    now_ms: u64,
    max_age_ms: u64,
) -> Result<(), EngineError> {
    let Some(snapshot) = &pool.snapshot else {
        return Err(EngineError::Rejected("POOL_SNAPSHOT_MISSING"));
    };
    let Some(head) = epoch.sequencer.as_ref() else {
        return Err(EngineError::Rejected("LIVE_HEAD_NOT_READY"));
    };
    if snapshot.block_number != head.block_number || snapshot.block_hash != head.block_hash {
        return Err(EngineError::Rejected("POOL_SNAPSHOT_HEAD_MISMATCH"));
    }
    if now_ms.saturating_sub(snapshot.observed_at_ms) > max_age_ms {
        return Err(EngineError::Rejected("POOL_SNAPSHOT_STALE"));
    }
    Ok(())
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
    type Wide = Uint<1024, 16>;
    // Retain the fee denominator until the sole final division. Flooring the
    // adjusted input first disagrees with the canonical pair for small inputs.
    let adjusted = Wide::from(amount_in) * Wide::from(10_000u64 - fee_bps as u64);
    let output = Wide::from(reserve_out) * adjusted
        / (Wide::from(reserve_in) * Wide::from(10_000u64) + adjusted);
    Ok(Some(narrow_math(output)?))
}

fn narrow_math(value: Uint<1024, 16>) -> Result<U256, EngineError> {
    U256::checked_from_limbs_slice(value.as_limbs()).ok_or(EngineError::MathOverflow)
}

fn ceil_div(value: Uint<1024, 16>, denominator: Uint<1024, 16>) -> Uint<1024, 16> {
    let quotient = value / denominator;
    if value % denominator == Uint::ZERO { quotient } else { quotient + Uint::from(1u64) }
}

/// The state produced when a known V2 exact-input swap is applied before our
/// own route is evaluated. Reserves deliberately retain the full input amount:
/// the fee remains in the pool, matching the pair contract's reserve update.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2ForwardState {
    pub amount_out: String,
    pub reserve0: String,
    pub reserve1: String,
}

/// Result of a bounded, integer-only two-pool V2 speculation. This is an
/// unsigned plan, never a permission to submit a transaction.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2SpeculativePlan {
    pub target_pool_id: String,
    pub counter_pool_id: String,
    pub flash_amount: String,
    pub expected_amount_out: String,
    pub expected_net_profit: String,
    pub projected_target: V2ForwardState,
}

/// Applies a pending V2 swap to a pool snapshot and returns the resulting
/// reserves. Inputs must be in the pool's token ordering.
pub fn project_v2_forward_state(
    pool: &Pool,
    token_in: &str,
    amount_in: U256,
) -> Result<Option<V2ForwardState>, EngineError> {
    let PoolState::V2 {
        reserve0,
        reserve1,
        fee_bps,
    } = &pool.state
    else {
        return Ok(None);
    };
    let reserve0 = parse_u256(reserve0)?;
    let reserve1 = parse_u256(reserve1)?;
    let zero_for_one = if token_in.eq_ignore_ascii_case(&pool.token0) {
        true
    } else if token_in.eq_ignore_ascii_case(&pool.token1) {
        false
    } else {
        return Ok(None);
    };
    let (reserve_in, reserve_out) = if zero_for_one {
        (reserve0, reserve1)
    } else {
        (reserve1, reserve0)
    };
    let Some(amount_out) = quote_v2(amount_in, reserve_in, reserve_out, *fee_bps)? else {
        return Ok(None);
    };
    let next_in = reserve_in
        .checked_add(amount_in)
        .ok_or(EngineError::MathOverflow)?;
    let next_out = reserve_out
        .checked_sub(amount_out)
        .ok_or(EngineError::MathOverflow)?;
    let (reserve0, reserve1) = if zero_for_one {
        (next_in, next_out)
    } else {
        (next_out, next_in)
    };
    Ok(Some(V2ForwardState {
        amount_out: amount_out.to_string(),
        reserve0: reserve0.to_string(),
        reserve1: reserve1.to_string(),
    }))
}

/// Computes a two-hop V2 route after applying a target swap to `target_pool`.
/// The closed-form stationary point is evaluated together with its neighbours,
/// so integer division and the flash-loan fee cannot turn a continuous optimum
/// into a false profitable plan.
pub fn speculate_v2_two_hop(
    target_pool: &Pool,
    counter_pool: &Pool,
    flash_token: &str,
    target_amount_in: U256,
    flash_loan_fee_bps: u16,
    fixed_cost: U256,
) -> Result<Option<V2SpeculativePlan>, EngineError> {
    speculate_v2_two_hop_with_target_token(
        target_pool, counter_pool, flash_token, flash_token,
        target_amount_in, flash_loan_fee_bps, fixed_cost,
    )
}

/// The observed swap direction is independent of the asset borrowed by our route.
pub fn speculate_v2_two_hop_with_target_token(
    target_pool: &Pool,
    counter_pool: &Pool,
    flash_token: &str,
    target_token_in: &str,
    target_amount_in: U256,
    flash_loan_fee_bps: u16,
    fixed_cost: U256,
) -> Result<Option<V2SpeculativePlan>, EngineError> {
    const BPS_DENOMINATOR: u64 = 10_000;
    if flash_loan_fee_bps >= BPS_DENOMINATOR as u16 {
        return Ok(None);
    }
    let Some(projected_target) =
        project_v2_forward_state(target_pool, target_token_in, target_amount_in)?
    else {
        return Ok(None);
    };
    let PoolState::V2 {
        fee_bps: target_fee_bps,
        ..
    } = &target_pool.state
    else {
        return Ok(None);
    };
    let PoolState::V2 {
        fee_bps: counter_fee_bps,
        ..
    } = &counter_pool.state
    else {
        return Ok(None);
    };
    if *target_fee_bps >= BPS_DENOMINATOR as u16 || *counter_fee_bps >= BPS_DENOMINATOR as u16 {
        return Ok(None);
    }

    let (r1_x, r1_y) = if flash_token.eq_ignore_ascii_case(&target_pool.token0) {
        (
            parse_u256(&projected_target.reserve0)?,
            parse_u256(&projected_target.reserve1)?,
        )
    } else if flash_token.eq_ignore_ascii_case(&target_pool.token1) {
        (
            parse_u256(&projected_target.reserve1)?,
            parse_u256(&projected_target.reserve0)?,
        )
    } else {
        return Ok(None);
    };
    let target_token = if flash_token.eq_ignore_ascii_case(&target_pool.token0) {
        &target_pool.token1
    } else {
        &target_pool.token0
    };
    let (r2_y, r2_x) = if target_token.eq_ignore_ascii_case(&counter_pool.token0)
        && flash_token.eq_ignore_ascii_case(&counter_pool.token1)
    {
        match &counter_pool.state {
            PoolState::V2 {
                reserve0, reserve1, ..
            } => (parse_u256(reserve0)?, parse_u256(reserve1)?),
            _ => return Ok(None),
        }
    } else if target_token.eq_ignore_ascii_case(&counter_pool.token1)
        && flash_token.eq_ignore_ascii_case(&counter_pool.token0)
    {
        match &counter_pool.state {
            PoolState::V2 {
                reserve0, reserve1, ..
            } => (parse_u256(reserve1)?, parse_u256(reserve0)?),
            _ => return Ok(None),
        }
    } else {
        return Ok(None);
    };

    // Four reserve factors occur before the square root. U256 is not wide
    // enough even for ordinary 18-decimal balances. Keep checked arithmetic
    // and narrow only the final input amount used by the exact swap quotes.
    type SolverUint = Uint<1024, 16>;
    let denominator = SolverUint::from(BPS_DENOMINATOR);
    let gamma1 = denominator - SolverUint::from(*target_fee_bps);
    let gamma2 = denominator - SolverUint::from(*counter_fee_bps);
    let (wide_r1_x, wide_r1_y, wide_r2_y, wide_r2_x) = (
        SolverUint::from(r1_x), SolverUint::from(r1_y),
        SolverUint::from(r2_y), SolverUint::from(r2_x),
    );
    // Out(q) = A*q / (B + C*q), retaining the fee denominators in B and C.
    let a = gamma1
        .checked_mul(gamma2)
        .and_then(|value| value.checked_mul(wide_r1_y))
        .and_then(|value| value.checked_mul(wide_r2_x))
        .ok_or(EngineError::MathOverflow)?;
    let b = wide_r1_x
        .checked_mul(wide_r2_y)
        .and_then(|value| value.checked_mul(denominator))
        .and_then(|value| value.checked_mul(denominator))
        .ok_or(EngineError::MathOverflow)?;
    let c = gamma1
        .checked_mul(
            denominator
                .checked_mul(wide_r2_y)
                .and_then(|value| {
                    gamma2
                        .checked_mul(wide_r1_y)
                        .and_then(|other| value.checked_add(other))
                })
                .ok_or(EngineError::MathOverflow)?,
        )
        .ok_or(EngineError::MathOverflow)?;
    if a.is_zero() || b.is_zero() || c.is_zero() {
        return Ok(None);
    }
    let stationary_square = a
        .checked_mul(b)
        .and_then(|value| value.checked_mul(denominator))
        .ok_or(EngineError::MathOverflow)?
        / SolverUint::from(BPS_DENOMINATOR + flash_loan_fee_bps as u64);
    let root = integer_sqrt(stationary_square);
    if root <= b {
        return Ok(None);
    }
    let wide_center = (root - b) / c;
    let center = narrow_math(wide_center)?;
    let candidates = [
        center.saturating_sub(U256::from(1u64)),
        center,
        center
            .checked_add(U256::from(1u64))
            .ok_or(EngineError::MathOverflow)?,
    ];
    let mut best: Option<(U256, U256, U256)> = None;
    for amount in candidates.into_iter().filter(|amount| !amount.is_zero()) {
        let Some(first_out) = quote_v2(amount, r1_x, r1_y, *target_fee_bps)? else {
            continue;
        };
        let Some(final_out) = quote_v2(first_out, r2_y, r2_x, *counter_fee_bps)? else {
            continue;
        };
        // A generic basis-point estimate must not understate lender debt.
        // Actual per-lender fees still require final exact-payload preflight.
        let loan_fee = narrow_math(ceil_div(
            SolverUint::from(amount) * SolverUint::from(flash_loan_fee_bps),
            denominator,
        ))?;
        let debt_and_cost = amount
            .checked_add(loan_fee)
            .and_then(|value| value.checked_add(fixed_cost))
            .ok_or(EngineError::MathOverflow)?;
        let Some(net_profit) = final_out.checked_sub(debt_and_cost) else {
            continue;
        };
        if net_profit.is_zero() {
            continue;
        }
        if best
            .as_ref()
            .is_none_or(|(_, _, best_profit)| net_profit > *best_profit)
        {
            best = Some((amount, final_out, net_profit));
        }
    }
    Ok(best.map(
        |(flash_amount, expected_amount_out, expected_net_profit)| V2SpeculativePlan {
            target_pool_id: target_pool.id.clone(),
            counter_pool_id: counter_pool.id.clone(),
            flash_amount: flash_amount.to_string(),
            expected_amount_out: expected_amount_out.to_string(),
            expected_net_profit: expected_net_profit.to_string(),
            projected_target,
        },
    ))
}

fn integer_sqrt(value: Uint<1024, 16>) -> Uint<1024, 16> {
    type Wide = Uint<1024, 16>;
    if value <= Wide::from(1u64) {
        return value;
    }
    let mut lower = Wide::from(1u64);
    let mut upper = value / Wide::from(2u64) + Wide::from(1u64);
    while lower < upper {
        let midpoint = lower + (upper - lower) / Wide::from(2u64);
        if midpoint <= value / midpoint {
            lower = midpoint + Wide::from(1u64);
        } else {
            upper = midpoint;
        }
    }
    lower - Wide::from(1u64)
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
    const Q96: U256 = U256::from_limbs([0, 1u64 << 32, 0, 0]);
    type Wide = Uint<1024, 16>;
    if amount_in.is_zero()
        || liquidity.is_zero()
        || sqrt_price_x96.is_zero()
        || fee_pips >= 1_000_000
        || liquidity > U256::from(u128::MAX)
        || sqrt_price_x96 >= (U256::from(1u64) << 160)
        || limit_x96.is_zero()
        || limit_x96 >= (U256::from(1u64) << 160)
    {
        return Ok(None);
    }
    let amount_after_fee = narrow_math(Wide::from(amount_in)
        * Wide::from(1_000_000u64 - fee_pips as u64) / Wide::from(1_000_000u64))?;
    let numerator1 = liquidity * Q96;
    if zero_for_one {
        // Match SqrtPriceMath's precise path and its uint256-overflow fallback.
        let precise_denominator = amount_after_fee.checked_mul(sqrt_price_x96)
            .and_then(|product| numerator1.checked_add(product));
        let next = match precise_denominator {
            Some(denominator) => narrow_math(ceil_div(
                Wide::from(numerator1) * Wide::from(sqrt_price_x96), Wide::from(denominator),
            ))?,
            None => {
                let denominator = (numerator1 / sqrt_price_x96).checked_add(amount_after_fee)
                    .ok_or(EngineError::MathOverflow)?;
                narrow_math(ceil_div(Wide::from(numerator1), Wide::from(denominator)))?
            }
        };
        if next < limit_x96 || next >= sqrt_price_x96 {
            return Ok(None);
        }
        Ok(Some(narrow_math(Wide::from(liquidity) * Wide::from(sqrt_price_x96 - next) / Wide::from(Q96))?))
    } else {
        let next = sqrt_price_x96
            .checked_add(
                narrow_math(Wide::from(amount_after_fee) * Wide::from(Q96) / Wide::from(liquidity))?,
            )
            .ok_or(EngineError::MathOverflow)?;
        if next > limit_x96 || next <= sqrt_price_x96 || next >= (U256::from(1u64) << 160) {
            return Ok(None);
        }
        Ok(Some(narrow_math(Wide::from(numerator1) * Wide::from(next - sqrt_price_x96)
            / Wide::from(next) / Wide::from(sqrt_price_x96))?))
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
            snapshot: None,
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
    fn forward_v2_projection_keeps_the_fee_in_the_input_reserve() {
        let pool = v2(
            "target",
            "0x0000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000002",
            "10000",
            "20000",
            1,
        );
        let projected = project_v2_forward_state(
            &pool,
            "0x0000000000000000000000000000000000000001",
            U256::from(1_000u64),
        )
        .unwrap()
        .unwrap();
        assert_eq!(projected.amount_out, "1813");
        assert_eq!(projected.reserve0, "11000");
        assert_eq!(projected.reserve1, "18187");
    }

    #[test]
    fn speculation_is_profitable_only_after_target_projection_and_rounding() {
        let target = v2(
            "target",
            "0x0000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000002",
            "100000",
            "200000",
            1,
        );
        let counter = v2(
            "counter",
            "0x0000000000000000000000000000000000000002",
            "0x0000000000000000000000000000000000000001",
            "100000",
            "200000",
            2,
        );
        let plan = speculate_v2_two_hop(
            &target,
            &counter,
            "0x0000000000000000000000000000000000000001",
            U256::from(1_000u64),
            9,
            U256::ZERO,
        )
        .unwrap()
        .unwrap();
        assert_eq!(plan.target_pool_id, "target");
        assert!(parse_u256(&plan.flash_amount).unwrap() > U256::ZERO);
        assert!(parse_u256(&plan.expected_net_profit).unwrap() > U256::ZERO);
    }

    #[test]
    fn speculation_handles_large_18_decimal_reserves() {
        let x = "0x0000000000000000000000000000000000000001";
        let y = "0x0000000000000000000000000000000000000002";
        let reserve = "1000000000000000000000000000000";
        let target = v2("target", x, y, reserve, reserve, 1);
        let counter = v2("counter", y, x, reserve, reserve, 2);
        let plan = speculate_v2_two_hop_with_target_token(
            &target, &counter, x, y,
            parse_u256("100000000000000000000000000000").unwrap(),
            5, U256::ZERO,
        ).unwrap().expect("profitable large-reserve route must not overflow");
        assert!(parse_u256(&plan.flash_amount).unwrap() > U256::ZERO);
        assert!(parse_u256(&plan.expected_net_profit).unwrap() > U256::ZERO);
        let amount = parse_u256(&plan.flash_amount).unwrap();
        let first = quote_v2(amount,
            parse_u256(&plan.projected_target.reserve0).unwrap(),
            parse_u256(&plan.projected_target.reserve1).unwrap(), 30).unwrap().unwrap();
        let final_out = quote_v2(first, parse_u256(reserve).unwrap(), parse_u256(reserve).unwrap(), 30).unwrap().unwrap();
        assert_eq!(final_out.to_string(), plan.expected_amount_out);
    }

    #[test]
    fn speculative_target_direction_can_differ_from_flash_asset() {
        let x = "0x0000000000000000000000000000000000000001";
        let y = "0x0000000000000000000000000000000000000002";
        let target = v2("target", x, y, "100000", "100000", 1);
        let counter = v2("counter", y, x, "100000", "100000", 2);
        let plan = speculate_v2_two_hop_with_target_token(
            &target, &counter, x, y, U256::from(10_000u64), 0, U256::ZERO,
        ).unwrap().expect("dumping y creates a route borrowing x");
        assert_eq!(plan.projected_target.reserve1, "110000");
        assert!(parse_u256(&plan.projected_target.reserve0).unwrap() < U256::from(100_000u64));
        assert!(parse_u256(&plan.expected_net_profit).unwrap() > U256::ZERO);
        assert!(speculate_v2_two_hop_with_target_token(
            &target, &counter, x, "unknown", U256::from(10_000u64), 0, U256::ZERO,
        ).unwrap().is_none());
    }

    #[test]
    fn speculation_rejects_a_counter_pool_with_the_wrong_assets() {
        let target = v2(
            "target",
            "0x0000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000002",
            "100000",
            "200000",
            1,
        );
        let counter = v2(
            "counter",
            "0x0000000000000000000000000000000000000003",
            "0x0000000000000000000000000000000000000004",
            "100000",
            "200000",
            2,
        );
        assert!(
            speculate_v2_two_hop(
                &target,
                &counter,
                "0x0000000000000000000000000000000000000001",
                U256::from(1_000u64),
                0,
                U256::ZERO,
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn speculative_paths_require_a_fresh_pool_snapshot_from_the_live_head() {
        let pool = v2(
            "target",
            "0x0000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000002",
            "100000",
            "200000",
            1,
        );
        let epoch = LiveEpoch {
            status: LiveStatus::TentativeLive,
            sequencer: Some(Head {
                source: StateSource::Sequencer,
                sequence: 1,
                block_number: 101,
                block_hash: "0xb".into(),
                parent_hash: "0xa".into(),
                observed_at_ms: 101,
            }),
            canonical: None,
        };
        assert_eq!(
            require_current_pool_snapshot(&pool, &epoch, 110, 100).unwrap_err(),
            EngineError::Rejected("POOL_SNAPSHOT_MISSING")
        );
    }

    #[test]
    fn v2_fee_rounding_keeps_fractional_input_until_final_division() {
        assert_eq!(quote_v2(U256::from(1u64), U256::from(1u64), U256::from(1000u64), 30)
            .unwrap().unwrap(), U256::from(499u64));
        for amount in 1u64..=100 {
            let expected = amount * 997 * 20000 / (10000 * 1000 + amount * 997);
            assert_eq!(quote_v2(U256::from(amount), U256::from(10000u64), U256::from(20000u64), 30)
                .unwrap().unwrap(), U256::from(expected));
        }
    }

    #[test]
    fn v3_canonical_q96_and_directional_rounding_match_exact_vectors() {
        let q96 = parse_u256("79228162514264337593543950336").unwrap();
        for zero_for_one in [true, false] {
            let limit = if zero_for_one { q96 / U256::from(4u64) } else { q96 * U256::from(4u64) };
            assert_eq!(quote_v3_single_tick(U256::from(1000u64), U256::from(1000u64), q96, limit, 0, zero_for_one)
                .unwrap().unwrap(), U256::from(500u64));
            let expected = if zero_for_one { 333u64 } else { 23u64 };
            assert_eq!(quote_v3_single_tick(U256::from(100u64), U256::from(1000u64), q96 * U256::from(2u64), limit, 0, zero_for_one)
                .unwrap().unwrap(), U256::from(expected));
        }
        assert_eq!(quote_v3_single_tick(U256::from(1000u64), U256::from(1_000_000_000_000u64), q96, q96 / U256::from(2u64), 3000, true)
            .unwrap().unwrap(), U256::from(996u64));
        assert!(quote_v3_single_tick(U256::from(1u64), U256::from(u128::MAX) + U256::from(1u64), q96, q96 / U256::from(2u64), 0, true).unwrap().is_none());
    }

    #[test]
    fn v3_quote_rejects_tick_crossing_instead_of_estimating() {
        let q96 = parse_u256("79228162514264337593543950336").unwrap();
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
