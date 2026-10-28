//! Read-only live scanner: Chainlink-priced, Uniswap V3 cross-fee-tier spread signal on Arbitrum.
//! No signer, no key, no send. Emits JSONL `signal` events; a candidate is never permission to execute.
use alloy::{primitives::{Address, U256, address}, providers::{Provider, ProviderBuilder}, sol};
use std::{env, time::Duration};
mod arb;
mod audit;
mod deploy;
mod universe;

sol! {
    #[sol(rpc)]
    interface IFeed { function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80); function decimals() view returns (uint8); }
    #[sol(rpc)]
    interface IPool { function slot0() view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool); }
}

const ETH_USD_FEED: Address = address!("639Fe6ab55C921f74e7fac1ee960C0B6293ba612");
const POOL_005: Address = address!("C6962004f452bE9203591991D15f6b388e09E8D0"); // WETH/USDC 0.05%
const POOL_030: Address = address!("17c14D2c404D167802b16C450d3c99F88F2c4F4d"); // WETH/USDC 0.30%
const MAX_ORACLE_AGE_S: u64 = 120;
const GAS_UNITS: f64 = 450_000.0;
const FLASH_FEE: f64 = 0.0; // Balancer v2 vault; Aave would be 0.0005

// WETH(18)/USDC(6): token0=WETH on Arbitrum's 0x82aF…/0xaf88… ordering is pool-specific; price = (sqrt/2^96)^2 * 1e12 USDC per WETH.
fn px(sqrt: U256) -> f64 {
    let s = f64::from(sqrt) / 2f64.powi(96);
    s * s * 1e12
}

#[tokio::main]
async fn main() {
    let a: Vec<String> = env::args().collect();
    if a.get(1).map(String::as_str) == Some("arb") {
        if let Err(e) = arb::run(a.iter().any(|x| x == "--live")).await { eprintln!("{{\"event\":\"arb\",\"status\":\"error\",\"error\":\"{e}\"}}"); std::process::exit(1); }
        return;
    }
    if a.get(1).map(String::as_str) == Some("audit") {
        if let Err(e) = audit::run().await { eprintln!("{{\"event\":\"audit\",\"status\":\"error\",\"error\":\"{e}\"}}"); std::process::exit(1); }
        return;
    }
    // Explicit Node host adapter: one shared manifest/budget implementation for new EVM deployments.
    if a.get(1).map(String::as_str) == Some("deploy-evm") {
        let status = std::process::Command::new("node").arg("dist/evm/cli.js").arg("deploy").args(&a[2..]).status();
        match status { Ok(s) if s.success() => {}, _ => { eprintln!("EVM_DEPLOYMENT_FAILED"); std::process::exit(1); } }
        return;
    }
    if a.get(1).map(String::as_str) == Some("deploy-v4") {
        if let Err(e) = deploy::run(&a[2..]).await { eprintln!("{{\"event\":\"deploy-v4\",\"status\":\"error\",\"error\":\"{e}\"}}"); std::process::exit(1); }
        return;
    }
    if a.get(1).map(String::as_str) == Some("deploy-multi") {
        if let Err(e) = deploy::run_multi(&a[2..]).await { eprintln!("{{\"event\":\"deploy-multi\",\"status\":\"error\",\"error\":\"{e}\"}}"); std::process::exit(1); }
        return;
    }
    if let Ok(path) = env::var("UNIVERSE_PATH") {
        if let Err(e) = universe_signal(&path).await { eprintln!("{{\"event\":\"signal\",\"status\":\"error\",\"error\":\"{e}\"}}"); std::process::exit(1); }
        return;
    }
    let (Ok(rpc), Some(notional), Some(min_profit)) = (
        env::var("ARBITRUM_RPC_URL"),
        env::args().nth(1).and_then(|v| v.parse::<f64>().ok()),
        env::args().nth(2).and_then(|v| v.parse::<f64>().ok()),
    ) else {
        eprintln!("usage: ARBITRUM_RPC_URL=… flashloan-scan <notional_usd> <min_net_profit_usd>");
        std::process::exit(2);
    };
    let p = ProviderBuilder::new().connect_http(rpc.parse().expect("valid RPC url"));
    let feed = IFeed::new(ETH_USD_FEED, &p);
    let (pa, pb) = (IPool::new(POOL_005, &p), IPool::new(POOL_030, &p));
    loop {
        let r = async {
            let block = p.get_block_number().await.map_err(|e| e.to_string())?;
            let now = p.get_block_by_number(block.into()).await.map_err(|e| e.to_string())?.ok_or("no block")?.header.timestamp;
            let d = feed.decimals().call().await.map_err(|e| e.to_string())?;
            let o = feed.latestRoundData().call().await.map_err(|e| e.to_string())?;
            let oracle = f64::from(o.answer.into_raw()) / 10f64.powi(d as i32);
            let age = now.saturating_sub(o.updatedAt.to::<u64>());
            let a = px(U256::from(pa.slot0().call().await.map_err(|e| e.to_string())?.sqrtPriceX96));
            let b = px(U256::from(pb.slot0().call().await.map_err(|e| e.to_string())?.sqrtPriceX96));
            let gas_wei = p.get_gas_price().await.map_err(|e| e.to_string())? as f64;
            Ok::<_, String>((block, oracle, age, a, b, gas_wei))
        }.await;
        match r {
            Err(e) => println!("{}", serde_json::json!({"event":"signal","status":"error","error":e})),
            Ok((block, oracle, age, a, b, gas_wei)) => {
                let spread = (a - b).abs() / a.min(b);
                let gross = notional * (spread - 0.0005 - 0.003 - FLASH_FEE); // both tiers' swap fees
                let gas_usd = gas_wei * GAS_UNITS / 1e18 * oracle;
                let net = gross - gas_usd;
                let stale = age > MAX_ORACLE_AGE_S;
                let dev = ((a.max(b) / oracle) - 1.0).abs();
                let status = if stale { "blocked:oracle_stale" } else if dev > 0.02 { "blocked:dex_oracle_divergence" } else if net >= min_profit { "candidate" } else { "no_edge" };
                println!("{}", serde_json::json!({"event":"signal","status":status,"block":block,"oracleUsd":oracle,"oracleAgeS":age,
                    "pool005":a,"pool030":b,"spreadBps":spread*1e4,"grossUsd":gross,"gasUsd":gas_usd,"netUsd":net,
                    "minNetUsd":min_profit,"priceImpactModelled":false,"note":"upper bound; requires exact eth_call simulation before any send"}));
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// First 32-byte words of a raw eth_call (F5: fork-specific slot0/globalState tails are never decoded).
async fn words<P: Provider>(p: &P, to: Address, selector: [u8; 4], n: usize) -> Result<Vec<U256>, String> {
    let tx = alloy::rpc::types::TransactionRequest::default().to(to).input(selector.to_vec().into());
    let out = p.call(tx).await.map_err(|e| e.to_string())?;
    if out.len() < 32 * n { return Err("SHORT_RETURN".into()); }
    Ok((0..n).map(|i| U256::from_be_slice(&out[32 * i..32 * (i + 1)])).collect())
}

/// Dynamic per-pair spread signal over a verified `pool-universe/1`; read-only, never sends.
async fn universe_signal(path: &str) -> Result<(), String> {
    let (rpc, notional, min_profit) = match (env::var("ARBITRUM_RPC_URL"), env::args().nth(1).and_then(|v| v.parse::<f64>().ok()), env::args().nth(2).and_then(|v| v.parse::<f64>().ok())) {
        (Ok(r), Some(n), Some(m)) => (r, n, m),
        _ => return Err("usage: UNIVERSE_PATH=… ARBITRUM_RPC_URL=… flashloan-scan <notional_usd> <min_net_profit_usd>".into()),
    };
    let u = universe::load(path, 42161)?;
    let max_pairs = env::var("MAX_PAIRS").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(16).max(1);
    let once = env::var("SIGNAL_ONCE").is_ok();
    let p = ProviderBuilder::new().connect_http(rpc.parse().map_err(|_| "INVALID_RPC_URL")?);
    if p.get_chain_id().await.map_err(|e| e.to_string())? != 42161 { return Err("CHAIN_MISMATCH".into()); }
    let asset = |a: &str| u.assets.iter().find(|x| x.address == a);
    let pools: std::collections::HashMap<&str, &universe::Pool> = u.pools.iter().map(|x| (x.pool_id.as_str(), x)).collect();
    loop {
        if universe::load(path, 42161).is_err() { return Err("UNIVERSE_EXPIRED".into()); }
        let block = p.get_block_number().await.map_err(|e| e.to_string())?;
        let gas_wei = p.get_gas_price().await.map_err(|e| e.to_string())? as f64;
        let feed_usd = |feed: Option<String>| { let p = &p; async move {
            let f = IFeed::new(universe::addr(&feed?).ok()?, p);
            let (d, o) = (f.decimals().call().await.ok()?, f.latestRoundData().call().await.ok()?);
            Some(f64::from(o.answer.into_raw()) / 10f64.powi(d as i32))
        } };
        let eth_usd = feed_usd(Some(format!("{ETH_USD_FEED:#x}"))).await.ok_or("ORACLE")?;
        let results = futures_util::future::join_all(u.pairs.iter().take(max_pairs).map(|pair| { let p = &p; let pools = &pools; async move {
            let (d0, d1) = (asset(&pair.token0).map(|a| a.decimals), asset(&pair.token1).map(|a| a.decimals));
            let (Some(d0), Some(d1)) = (d0, d1) else { return (pair, Err("DECIMALS_MISSING".to_string())) };
            let reads = futures_util::future::join_all(pair.pool_ids.iter().filter_map(|id| pools.get(id.as_str()).copied()).map(|pool| async move {
                let to = universe::addr(&pool.address)?;
                let price = match pool.adapter.as_str() {
                    "UNISWAP_V2" => { let w = words(p, to, [0x09, 0x02, 0xf1, 0xac], 2).await?; universe::price_from_reserves(w[0], w[1], d0, d1) }
                    "ALGEBRA" => universe::price_from_sqrt(words(p, to, [0xe7, 0x6c, 0x01, 0xe4], 1).await?[0], d0, d1),
                    _ => universe::price_from_sqrt(words(p, to, [0x38, 0x50, 0xc7, 0xbd], 1).await?[0], d0, d1),
                };
                Ok::<_, String>((pool, price))
            })).await;
            let ok: Vec<_> = reads.into_iter().filter_map(Result::ok).filter(|(_, x)| x.is_finite() && *x > 0.0).collect();
            let (f0, f1) = (feed_usd(asset(&pair.token0).and_then(|a| a.usd_feed.clone())).await, feed_usd(asset(&pair.token1).and_then(|a| a.usd_feed.clone())).await);
            (pair, Ok((ok, f0.zip(f1).map(|(a, b)| a / b))))
        } })).await;
        for (pair, r) in results {
            let line = match r {
                Err(e) => serde_json::json!({"event":"signal","status":"error","error":e,"pair":[pair.token0,pair.token1]}),
                Ok((quotes, _)) if quotes.len() < 2 => serde_json::json!({"event":"signal","status":"error","error":"FEWER_THAN_TWO_LIVE_POOLS","pair":[pair.token0,pair.token1]}),
                Ok((quotes, oracle)) => {
                    let lo = quotes.iter().min_by(|a, b| a.1.total_cmp(&b.1)).unwrap();
                    let hi = quotes.iter().max_by(|a, b| a.1.total_cmp(&b.1)).unwrap();
                    let spread = (hi.1 - lo.1) / lo.1;
                    let fee_floor = (lo.0.fee_pips + hi.0.fee_pips) as f64 / 1e6;
                    let gross = notional * (spread - fee_floor - FLASH_FEE);
                    let gas_usd = gas_wei * GAS_UNITS / 1e18 * eth_usd;
                    let net = gross - gas_usd;
                    let dev = oracle.map(|o| ((hi.1 / o) - 1.0).abs());
                    let status = if dev.is_some_and(|d| d > 0.02) { "blocked:dex_oracle_divergence" } else if net >= min_profit { "candidate" } else { "no_edge" };
                    serde_json::json!({"event":"signal","status":status,"block":block,"pair":[pair.token0,pair.token1],"buyPool":lo.0.pool_id,"sellPool":hi.0.pool_id,
                        "buyPrice":lo.1,"sellPrice":hi.1,"spreadBps":spread*1e4,"feeFloorBps":fee_floor*1e4,"grossUsd":gross,"gasUsd":gas_usd,"netUsd":net,"minNetUsd":min_profit,
                        "oracleChecked":oracle.is_some(),"poolsLive":quotes.len(),"priceImpactModelled":false,"note":"upper bound; requires exact eth_call simulation before any send"})
                }
            };
            println!("{line}");
        }
        if once { return Ok(()); }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
