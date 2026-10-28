//! Read side of `pool-universe/1` (built and verified by `node dist/evm/cli.js universe`).
//! No discovery or verification logic lives here: the scanner only consumes verified identity and re-reads live state.
use alloy::primitives::{Address, U256};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Universe {
    pub schema_version: String,
    pub chain_id: u64,
    pub expires_at: String,
    pub assets: Vec<Asset>,
    pub pools: Vec<Pool>,
    pub pairs: Vec<Pair>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub address: String,
    pub symbol: Option<String>,
    pub decimals: u8,
    pub usd_feed: Option<String>,
    pub flash_lenders: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pool {
    pub pool_id: String,
    pub address: String,
    pub adapter: String,
    pub venue: String,
    pub fee_pips: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pair {
    pub token0: String,
    pub token1: String,
    pub pool_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorVenues {
    pub verified_block: Option<String>,
    pub map: HashMap<String, u8>,
}

pub fn addr(value: &str) -> Result<Address, String> {
    value.parse().map_err(|_| "INVALID_UNIVERSE_ADDRESS".to_string())
}

/// `YYYY-MM-DDTHH:MM:SS[.fff]Z` → unix seconds (no chrono dependency).
fn unix_seconds(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    if b.len() < 20 || !iso.ends_with('Z') || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |s: &str| s.parse::<i64>().ok();
    let (y, m, d) = (n(&iso[0..4])?, n(&iso[5..7])?, n(&iso[8..10])?);
    let (hh, mm, ss) = (n(&iso[11..13])?, n(&iso[14..16])?, n(&iso[17..19])?);
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    Some(days * 86_400 + hh * 3_600 + mm * 60 + ss)
}

/// Fails closed on schema, chain or expiry mismatch.
pub fn parse(raw: &str, chain_id: u64, now_unix: i64) -> Result<Universe, String> {
    let u: Universe = serde_json::from_str(raw).map_err(|_| "INVALID_POOL_UNIVERSE")?;
    if u.schema_version != "pool-universe/1" {
        return Err("INVALID_POOL_UNIVERSE".into());
    }
    if u.chain_id != chain_id {
        return Err("UNIVERSE_CHAIN_MISMATCH".into());
    }
    match unix_seconds(&u.expires_at) {
        Some(expiry) if expiry > now_unix => Ok(u),
        Some(_) => Err("UNIVERSE_EXPIRED".into()),
        None => Err("INVALID_POOL_UNIVERSE".into()),
    }
}

pub fn load(path: &str, chain_id: u64) -> Result<Universe, String> {
    let raw = std::fs::read_to_string(path).map_err(|_| "UNIVERSE_UNREADABLE")?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "CLOCK")?
        .as_secs() as i64;
    parse(&raw, chain_id, now)
}

/// Dynamic arb mode is gated on an owner-recorded verification of the deployed executor's venue ids.
pub fn load_executor_venues(policy_path: &str) -> Result<ExecutorVenues, String> {
    let raw = std::fs::read_to_string(policy_path).map_err(|_| "ASSET_POLICY_UNREADABLE")?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| "INVALID_ASSET_POLICY")?;
    let venues: ExecutorVenues = serde_json::from_value(value.get("executorVenues").cloned().ok_or("VENUE_MAP_MISSING")?)
        .map_err(|_| "INVALID_ASSET_POLICY")?;
    match venues.verified_block.as_deref() {
        Some(b) if !b.is_empty() && b.bytes().all(|c| c.is_ascii_digit()) => Ok(venues),
        _ => Err("VENUE_MAP_UNVERIFIED".into()),
    }
}

/// token1 per token0 in whole units: (sqrt/2^96)^2 · 10^(d0−d1).
pub fn price_from_sqrt(sqrt: U256, d0: u8, d1: u8) -> f64 {
    let s = f64::from(sqrt) / 2f64.powi(96);
    s * s * 10f64.powi(d0 as i32 - d1 as i32)
}

pub fn price_from_reserves(r0: U256, r1: U256, d0: u8, d1: u8) -> f64 {
    f64::from(r1) / f64::from(r0) * 10f64.powi(d0 as i32 - d1 as i32)
}

/// Smallest-unit amount for `usd` at `price_usd`, rounded up; never assumes a $1/6-decimal default.
pub fn units(usd: f64, price_usd: f64, decimals: u8) -> Option<U256> {
    if !usd.is_finite() || !price_usd.is_finite() || price_usd <= 0.0 || usd < 0.0 {
        return None;
    }
    let v = (usd / price_usd * 10f64.powi(decimals as i32)).ceil();
    (v.is_finite() && v < 3.4e38).then(|| U256::from(v as u128))
}

/// Executor combos (flash, target, buy venue id, sell venue id, uniFee) built only from verified pools on mapped venues.
/// The executor takes one `uniFee`, so every fee-tier leg in a combo must share it; Camelot (Algebra) legs carry no tier.
pub fn dex_combos(u: &Universe, flash: &str, venues: &HashMap<String, u8>) -> Vec<(String, u8, u8, u32)> {
    let by_id: HashMap<&str, &Pool> = u.pools.iter().map(|p| (p.pool_id.as_str(), p)).collect();
    let mut out = Vec::new();
    for pair in u.pairs.iter().filter(|p| p.token0 == flash || p.token1 == flash) {
        let target = if pair.token0 == flash { &pair.token1 } else { &pair.token0 };
        let pools: Vec<&Pool> = pair.pool_ids.iter().filter_map(|id| by_id.get(id.as_str()).copied()).filter(|p| venues.contains_key(&p.venue)).collect();
        for a in &pools {
            for b in &pools {
                let (va, vb) = (venues[&a.venue], venues[&b.venue]);
                if va == vb {
                    continue;
                }
                let tiers: Vec<u32> = [a, b].iter().filter(|p| p.adapter != "ALGEBRA").map(|p| p.fee_pips).collect();
                let Some(&fee) = tiers.first() else { continue };
                let combo = (target.clone(), va, vb, fee);
                if tiers.iter().all(|f| *f == fee) && !out.contains(&combo) {
                    out.push(combo);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const WETH: &str = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
    const USDC: &str = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

    fn universe(expires: &str) -> String {
        format!(r#"{{"schemaVersion":"pool-universe/1","chainId":42161,"network":"arbitrum","expiresAt":"{expires}","assets":[],
        "pools":[{{"poolId":"a","address":"0x01","adapter":"UNISWAP_V3","venue":"uniswap-v3","feePips":500}},
                 {{"poolId":"b","address":"0x02","adapter":"UNISWAP_V3","venue":"pancakeswap-v3","token0":"{WETH}","token1":"{USDC}","feePips":500}},
                 {{"poolId":"c","address":"0x03","adapter":"ALGEBRA","venue":"camelot-v3","token0":"{WETH}","token1":"{USDC}","feePips":300}},
                 {{"poolId":"d","address":"0x04","adapter":"UNISWAP_V3","venue":"sushiswap-v3","token0":"{WETH}","token1":"{USDC}","feePips":500}},
                 {{"poolId":"e","address":"0x05","adapter":"UNISWAP_V3","venue":"uniswap-v3","feePips":3000}}],
        "pairs":[{{"token0":"{WETH}","token1":"{USDC}","poolIds":["a","b","c","d","e"]}}]}}"#)
    }

    #[test]
    fn price_is_decimal_and_orientation_correct() {
        // 2000 USDC per WETH: sqrt(2000e6/1e18)·2^96
        let sqrt = U256::from((2000e-12f64).sqrt() * 2f64.powi(96));
        assert!((price_from_sqrt(sqrt, 18, 6) - 2000.0).abs() < 1e-6);
        assert!((price_from_reserves(U256::from(10u128.pow(20)), U256::from(2u128 * 10u128.pow(11)), 18, 6) - 2000.0).abs() < 1e-9);
        assert!((price_from_reserves(U256::from(10u128.pow(8)), U256::from(25u128 * 10u128.pow(18)), 8, 18) - 25.0).abs() < 1e-9);
    }

    #[test]
    fn to_units_uses_asset_decimals_and_feed() {
        assert_eq!(units(2_000.0, 2_000.0, 18), Some(U256::from(10u128.pow(18))));
        assert_eq!(units(1_000.0, 0.5, 8), Some(U256::from(2_000u128 * 10u128.pow(8))));
        assert_eq!(units(1_000.0, 0.0, 6), None, "no feed price, no units");
    }

    #[test]
    fn rejects_expired_or_wrong_chain_universe() {
        let now = unix_seconds("2026-10-28T03:00:00.000Z").unwrap();
        assert!(parse(&universe("2026-10-28T03:10:00.000Z"), 42161, now).is_ok());
        assert_eq!(parse(&universe("2026-10-28T02:59:59.000Z"), 42161, now).unwrap_err(), "UNIVERSE_EXPIRED");
        assert_eq!(parse(&universe("2026-10-28T03:10:00.000Z"), 8453, now).unwrap_err(), "UNIVERSE_CHAIN_MISMATCH");
        assert_eq!(unix_seconds("1970-01-02T00:00:00Z"), Some(86_400));
    }

    #[test]
    fn combos_limited_to_verified_pools_on_mapped_venues() {
        let now = unix_seconds("2026-10-28T03:00:00.000Z").unwrap();
        let u = parse(&universe("2026-10-28T03:10:00.000Z"), 42161, now).unwrap();
        let venues: HashMap<String, u8> = [("camelot-v3", 0u8), ("uniswap-v3", 1), ("pancakeswap-v3", 2)].into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        let combos = dex_combos(&u, WETH, &venues);
        // sushiswap-v3 is unmapped; uni 3000 vs pancake 500 cannot share one uniFee.
        assert!(combos.iter().all(|c| c.0 == USDC));
        assert!(combos.contains(&(USDC.to_string(), 1, 2, 500)) && combos.contains(&(USDC.to_string(), 2, 1, 500)));
        assert!(combos.contains(&(USDC.to_string(), 0, 1, 3000)) && combos.contains(&(USDC.to_string(), 0, 1, 500)));
        assert!(!combos.iter().any(|c| (c.1, c.2) == (1, 2) && c.3 == 3000));
        assert!(dex_combos(&u, "0x0000000000000000000000000000000000000001", &venues).is_empty());
    }

    #[test]
    fn dynamic_mode_requires_verified_venue_map() {
        let dir = std::env::temp_dir().join(format!("venue-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("policy.json");
        std::fs::write(&path, r#"{"executorVenues":{"verifiedBlock":null,"evidence":"x","map":{"uniswap-v3":1}}}"#).unwrap();
        assert_eq!(load_executor_venues(path.to_str().unwrap()).unwrap_err(), "VENUE_MAP_UNVERIFIED");
        std::fs::write(&path, r#"{"executorVenues":{"verifiedBlock":"123","evidence":"x","map":{"uniswap-v3":1}}}"#).unwrap();
        assert_eq!(load_executor_venues(path.to_str().unwrap()).unwrap().map["uniswap-v3"], 1);
    }
}
