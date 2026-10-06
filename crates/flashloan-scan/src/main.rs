//! Read-only live scanner: Chainlink-priced, Uniswap V3 cross-fee-tier spread signal on Arbitrum.
//! No signer, no key, no send. Emits JSONL `signal` events; a candidate is never permission to execute.
use alloy::{primitives::{Address, U256, address}, providers::{Provider, ProviderBuilder}, sol};
use std::{env, time::Duration};
mod arb;
mod audit;
mod deploy;

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
    if a.get(1).map(String::as_str) == Some("deploy-v4") {
        if let Err(e) = deploy::run(&a[2..]).await { eprintln!("{{\"event\":\"deploy-v4\",\"status\":\"error\",\"error\":\"{e}\"}}"); std::process::exit(1); }
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
