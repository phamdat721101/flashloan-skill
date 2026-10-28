//! `arb` subcommand: discovery-scoped, multi-asset exact-simulation DEX-pair flash arbitrage.
//! Dry-run by default and samples a bounded adaptive notional range.
//! `--live` sends ONE tx via PRIVATE_RELAY_URL only after a fresh re-simulation clears
//! priced from live Chainlink feeds; the executor enforces minProfit on-chain.
use alloy::{
    network::{EthereumWallet, TransactionBuilder},
    primitives::{address, Address, U256},
    providers::{Provider, ProviderBuilder},
    rpc::types::TransactionRequest,
    signers::local::PrivateKeySigner,
    sol,
};
use crate::universe;
use std::{collections::HashMap, env, time::Duration};

sol! {
    #[sol(rpc)]
    interface IExec {
        struct DexPairParams { address flashToken; uint256 flashAmount; address targetToken; uint8 buyVenue; uint8 sellVenue; uint24 uniFee; uint256 minProfit; }
        function owner() view returns (address);
        function executeDexPairArbitrage(DexPairParams params) external;
        event DexPairArbitrageExecuted(address indexed flashToken, address indexed targetToken, uint256 flashAmount, uint256 netProfit, uint8 buyVenue, uint8 sellVenue);
    }
    #[sol(rpc)]
    interface IFeed { function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80); function decimals() view returns (uint8); }
}

const USDC: Address = address!("af88d065e77c8cC2239327C5EDb3A432268e5831");
const WETH: Address = address!("82aF49447D8a07e3bd95BD0d56f35241523fBab1");
const USDT: Address = address!("Fd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9");
const ETH_USD: Address = address!("639Fe6ab55C921f74e7fac1ee960C0B6293ba612");
const USDC_USD: Address = address!("50834F3163758fcC1Df9973b6e91f0F0F0434aD3");
const CHAIN_ID: u64 = 42161;
const MAX_ORACLE_AGE_S: u64 = 90_000;
const VENUES: [u8; 3] = [0, 1, 2]; // 0: camelot-v3, 1: uniswap-v3, 2: pancakeswap-v3
const UNI_FEES: [u32; 3] = [100, 500, 3000];
const MIN_NET_PROFIT_USD: f64 = 10.0;
const SIZE_SAMPLES: usize = 12;

#[derive(Clone, Debug)]
struct Asset {
    token: Address,
    symbol: String,
    decimals: u8,
    /// None only for the legacy USDT entry, which historically priced at $1; dynamic assets always carry a feed.
    feed: Option<Address>,
}

fn legacy_assets() -> Vec<Asset> {
    vec![
        Asset { token: WETH, symbol: "WETH".into(), decimals: 18, feed: Some(ETH_USD) },
        Asset { token: USDC, symbol: "USDC".into(), decimals: 6, feed: Some(USDC_USD) },
        Asset { token: USDT, symbol: "USDT".into(), decimals: 6, feed: None },
    ]
}

/// Flash assets are universe assets with a USD feed and a flash lender; unknown assets are skipped, never assumed $1.
fn universe_assets(u: &universe::Universe) -> Result<Vec<Asset>, Box<dyn std::error::Error>> {
    let assets = u.assets.iter()
        .filter(|a| a.usd_feed.is_some() && !a.flash_lenders.is_empty())
        .map(|a| Ok(Asset { token: universe::addr(&a.address)?, symbol: a.symbol.clone().unwrap_or_else(|| a.address.clone()), decimals: a.decimals,
            feed: Some(universe::addr(a.usd_feed.as_deref().unwrap_or_default())?) }))
        .collect::<Result<Vec<_>, String>>()?;
    if assets.is_empty() {
        return Err("NO_PRICED_FLASH_ASSET_IN_UNIVERSE".into());
    }
    Ok(assets)
}

/// `executeDexPairArbitrage((address,uint256,address,uint8,uint8,uint24,uint256))`
const DEX_PAIR_SELECTOR: [u8; 4] = [0x0b, 0xde, 0x7b, 0x85];

fn has_selector(code: &[u8], selector: [u8; 4]) -> bool {
    code.windows(5).any(|w| w[0] == 0x63 && w[1..] == selector)
}

fn envf(k: &str, d: f64) -> f64 {
    env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn required_min_net_profit_usd() -> Result<f64, Box<dyn std::error::Error>> {
    validate_min_net_profit_usd(envf("MIN_NET_PROFIT_USD", MIN_NET_PROFIT_USD))
}

fn validate_min_net_profit_usd(value: f64) -> Result<f64, Box<dyn std::error::Error>> {
    if !value.is_finite() || value < MIN_NET_PROFIT_USD {
        return Err(format!("MIN_NET_PROFIT_USD_MUST_BE_AT_LEAST_{MIN_NET_PROFIT_USD}").into());
    }
    Ok(value)
}

fn sizing_ladder(min_usd: f64, max_usd: f64) -> Result<Vec<f64>, Box<dyn std::error::Error>> {
    if !min_usd.is_finite() || !max_usd.is_finite() || min_usd <= 0.0 || max_usd < min_usd {
        return Err("INVALID_FLASH_SIZE_BOUNDS".into());
    }
    if min_usd == max_usd {
        return Ok(vec![min_usd]);
    }
    let ratio = (max_usd / min_usd).powf(1.0 / (SIZE_SAMPLES - 1) as f64);
    let mut sizes = (0..SIZE_SAMPLES)
        .map(|index| min_usd * ratio.powi(index as i32))
        .collect::<Vec<_>>();
    *sizes.last_mut().expect("SIZE_SAMPLES is non-zero") = max_usd;
    Ok(sizes)
}

fn discovered_targets() -> Result<Vec<Address>, Box<dyn std::error::Error>> {
    let raw =
        env::var("DISCOVERED_TARGET_TOKENS").map_err(|_| "DISCOVERED_TARGET_TOKENS_REQUIRED")?;
    let targets = raw
        .split(',')
        .filter(|token| !token.trim().is_empty())
        .map(|token| {
            token
                .trim()
                .parse::<Address>()
                .map_err(|_| "INVALID_DISCOVERED_TARGET_TOKEN")
        })
        .collect::<Result<Vec<_>, _>>()?;
    if targets.is_empty() {
        return Err("DISCOVERED_TARGET_TOKENS_REQUIRED".into());
    }
    Ok(targets)
}

pub async fn run(live: bool) -> Result<(), Box<dyn std::error::Error>> {
    let rpc = env::var("ARBITRUM_RPC_URL")?;
    let exec_addr: Address = env::var("FLASH_EXECUTOR_ADDRESS")?.parse()?;
    let min_net = required_min_net_profit_usd()?;
    let max_gas_usd = envf("MAX_GAS_USD", 5.0);
    let max_flash_usd = envf("MAX_FLASH_USD", 500_000.0);
    let min_flash_usd = envf("MIN_FLASH_USD", 1_000.0);
    let sizes = sizing_ladder(min_flash_usd, max_flash_usd)?;
    // Dynamic mode (UNIVERSE_PATH): verified pools only, gated on an owner-verified executor venue map.
    let dynamic = match env::var("UNIVERSE_PATH") {
        Ok(path) => {
            let u = universe::load(&path, CHAIN_ID)?;
            let venues = universe::load_executor_venues(&env::var("ASSET_POLICY_PATH").map_err(|_| "ASSET_POLICY_PATH_REQUIRED")?)?;
            Some((u, venues))
        }
        Err(_) => None,
    };
    let assets = match &dynamic { Some((u, _)) => universe_assets(u)?, None => legacy_assets() };
    let target_filter = if dynamic.is_some() { discovered_targets().ok() } else { Some(discovered_targets()?) };

    let p = ProviderBuilder::new().connect_http(rpc.parse()?);
    let exec = IExec::new(exec_addr, &p);
    if p.get_chain_id().await? != CHAIN_ID {
        return Err("CHAIN_MISMATCH".into());
    }
    let code = p.get_code_at(exec_addr).await?;
    if code.is_empty() {
        return Err("EXECUTOR_NOT_DEPLOYED".into());
    }
    // MultiVenue executors route by pool address (`evm universe-probe`); without this selector every probe would read as no_edge.
    if !has_selector(&code, DEX_PAIR_SELECTOR) {
        return Err("EXECUTOR_LACKS_DEX_PAIR_ENTRYPOINT".into());
    }
    let owner = exec.owner().call().await?;

    let (signer, relay) = if live {
        if env::var("ALLOW_PRIVATE_RELAY_SEND").as_deref() != Ok("true") {
            return Err("LIVE_SEND_NOT_EXPLICITLY_ENABLED".into());
        }
        let signer: PrivateKeySigner = env::var("OPERATOR_PRIVATE_KEY")?.parse()?;
        if signer.address() != owner {
            return Err("SIGNER_NOT_OWNER".into());
        }
        (Some(signer), Some(env::var("PRIVATE_RELAY_URL")?))
    } else {
        (None, None)
    };

    loop {
        let price = |feed: Address| {
            let p = &p;
            async move {
                let f = IFeed::new(feed, p);
                let d = f.decimals().call().await?;
                let r = f.latestRoundData().call().await?;
                let now = p
                    .get_block_by_number(alloy::eips::BlockNumberOrTag::Latest)
                    .await?
                    .ok_or("no block")?
                    .header
                    .timestamp;
                if now.saturating_sub(r.updatedAt.to::<u64>()) > MAX_ORACLE_AGE_S {
                    return Err::<f64, Box<dyn std::error::Error>>("ORACLE_STALE".into());
                }
                Ok(f64::from(r.answer.into_raw()) / 10f64.powi(d as i32))
            }
        };
        let mut feeds: Vec<Address> = assets.iter().filter_map(|a| a.feed).chain([ETH_USD]).collect();
        feeds.sort();
        feeds.dedup();
        let quotes = futures_util::future::join_all(feeds.iter().map(|f| price(*f))).await;
        if quotes.iter().any(Result::is_err) {
            let detail = quotes.iter().filter_map(|q| q.as_ref().err().map(|e| e.to_string())).collect::<Vec<_>>().join("/");
            println!("{}", serde_json::json!({"event":"arb","status":"blocked","code":"ORACLE","detail":detail}));
            tokio::time::sleep(Duration::from_secs(4)).await;
            continue;
        }
        let usd: HashMap<Address, f64> = feeds.iter().copied().zip(quotes.into_iter().map(|q| q.unwrap_or_default())).collect();
        let (eth_usd, usdc_usd) = (usd[&ETH_USD], usd.get(&USDC_USD).copied());
        let gas_price = p.get_gas_price().await? as f64;

        let to_units = |token: Address, amount_usd: f64| -> U256 {
            assets.iter().find(|a| a.token == token)
                .and_then(|a| universe::units(amount_usd, a.feed.map_or(1.0, |f| usd[&f]), a.decimals))
                .unwrap_or(U256::ZERO)
        };

        let min_profit_units = |token: Address, min_usd: f64| -> U256 {
            if min_usd <= 0.0001 {
                U256::from(1)
            } else {
                let u = to_units(token, min_usd);
                if u.is_zero() {
                    U256::from(1)
                } else {
                    u
                }
            }
        };

        let mut hit = None;
        let probe = sizes[0];

        let mut all_combos = Vec::new();
        for flash in &assets {
            if let Some((u, venues)) = &dynamic {
                for (t, b, sl, fee) in universe::dex_combos(u, &format!("{:#x}", flash.token), &venues.map) {
                    let t = universe::addr(&t)?;
                    if target_filter.as_ref().is_none_or(|f| f.contains(&t)) {
                        all_combos.push((flash.token, flash.symbol.as_str(), t, b, sl, fee));
                    }
                }
                continue;
            }
            for &t in target_filter.iter().flatten() {
                if t == flash.token {
                    continue;
                }
                for &b in &VENUES {
                    for &s in &VENUES {
                        if s == b {
                            continue;
                        }
                        for &fee in &UNI_FEES {
                            all_combos.push((flash.token, flash.symbol.as_str(), t, b, s, fee));
                        }
                    }
                }
            }
        }

        // Fast parallel probe
        let alive: Vec<_> =
            futures_util::future::join_all(all_combos.iter().map(|&(ft, sym, t, b, sl, f)| {
                let exec = &exec;
                async move {
                    let probe_amt = to_units(ft, probe);
                    let params = IExec::DexPairParams {
                        flashToken: ft,
                        flashAmount: probe_amt,
                        targetToken: t,
                        buyVenue: b,
                        sellVenue: sl,
                        uniFee: f.try_into().unwrap(),
                        minProfit: U256::from(1),
                    };
                    let r = exec
                        .executeDexPairArbitrage(params)
                        .from(owner)
                        .estimate_gas()
                        .await;
                    if let (Err(e), true) = (&r, env::var("ARB_DEBUG").is_ok()) {
                        eprintln!(
                            "probe {sym}->{t:#x} b={b} s={sl} f={f}: {}",
                            e.to_string().chars().take(80).collect::<String>()
                        );
                    }
                    r.is_ok().then_some((ft, sym, t, b, sl, f))
                }
            }))
            .await
            .into_iter()
            .flatten()
            .collect();

        'search: for &size in &sizes {
            for &(ft, sym, t, buy, sell, fee) in &alive {
                let amt = to_units(ft, size);
                let probe_params = IExec::DexPairParams {
                    flashToken: ft,
                    flashAmount: amt,
                    targetToken: t,
                    buyVenue: buy,
                    sellVenue: sell,
                    uniFee: fee.try_into().unwrap(),
                    minProfit: U256::from(1),
                };
                let Ok(gas) = exec
                    .executeDexPairArbitrage(probe_params)
                    .from(owner)
                    .estimate_gas()
                    .await
                else {
                    continue;
                };
                let gas_usd = gas as f64 * gas_price / 1e18 * eth_usd;
                if gas_usd > max_gas_usd {
                    continue;
                }

                let params = IExec::DexPairParams {
                    flashToken: ft,
                    flashAmount: amt,
                    targetToken: t,
                    buyVenue: buy,
                    sellVenue: sell,
                    uniFee: fee.try_into().unwrap(),
                    minProfit: min_profit_units(ft, min_net + gas_usd),
                };

                if exec
                    .executeDexPairArbitrage(params.clone())
                    .from(owner)
                    .call()
                    .await
                    .is_ok()
                {
                    hit = Some((size, ft, sym, t, buy, sell, fee, gas, gas_usd, params));
                    break 'search;
                }
            }
        }

        let alive_n = alive.len();
        match hit {
            None => println!(
                "{}",
                serde_json::json!({
                    "event":"arb",
                    "status":"no_edge",
                    "ethUsd":eth_usd,
                    "usdcUsd":usdc_usd,
                    "minNetUsd":min_net,
                    "sizesUsd":sizes,
                    "pairsAlive":alive_n,
                    "combosProbed":all_combos.len()
                })
            ),
            Some((size, ft, sym, t, buy, sell, fee, gas, gas_usd, params)) => {
                println!(
                    "{}",
                    serde_json::json!({
                        "event":"arb",
                        "status":"candidate",
                        "flashAsset":sym,
                        "flashToken":format!("{ft:#x}"),
                        "sizeUsd":size,
                        "target":format!("{t:#x}"),
                        "buyVenue":buy,
                        "sellVenue":sell,
                        "uniFee":fee,
                        "gas":gas,
                        "gasUsd":gas_usd,
                        "live":live
                    })
                );

                let (Some(signer), Some(relay)) = (&signer, &relay) else {
                    tokio::time::sleep(Duration::from_secs(4)).await;
                    continue;
                };

                // Fresh re-simulation immediately before broadcast
                if exec
                    .executeDexPairArbitrage(params.clone())
                    .from(owner)
                    .call()
                    .await
                    .is_err()
                {
                    println!(
                        "{}",
                        serde_json::json!({"event":"arb","status":"stale_before_send"})
                    );
                    continue;
                }

                let nonce = p.get_transaction_count(owner).await?;
                let fees = p.estimate_eip1559_fees().await?;
                let data = exec.executeDexPairArbitrage(params).calldata().clone();
                let tx = TransactionRequest::default()
                    .with_to(exec_addr)
                    .with_input(data)
                    .with_from(owner)
                    .with_nonce(nonce)
                    .with_gas_limit(gas * 13 / 10)
                    .with_max_fee_per_gas(fees.max_fee_per_gas)
                    .with_max_priority_fee_per_gas(fees.max_priority_fee_per_gas)
                    .with_chain_id(CHAIN_ID);

                let rp = ProviderBuilder::new()
                    .wallet(EthereumWallet::from(signer.clone()))
                    .connect_http(relay.parse()?);

                let hash = *rp.send_transaction(tx).await?.tx_hash();
                println!(
                    "{}",
                    serde_json::json!({"event":"arb","status":"sent","txHash":format!("{hash:#x}")})
                );

                for _ in 0..60 {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if let Some(rc) = p.get_transaction_receipt(hash).await? {
                        let profit = rc
                            .inner
                            .logs()
                            .iter()
                            .find_map(|l| l.log_decode::<IExec::DexPairArbitrageExecuted>().ok())
                            .map(|e| e.inner.data.netProfit.to_string());
                        println!(
                            "{}",
                            serde_json::json!({
                                "event":"arb",
                                "status":"receipt",
                                "success":rc.status(),
                                "blockNumber":rc.block_number,
                                "gasUsed":rc.gas_used,
                                "netProfitUnits":profit,
                                "flashAsset":sym
                            })
                        );
                        return Ok(()); // one-shot live execution: operator reviews P&L
                    }
                }
                println!(
                    "{}",
                    serde_json::json!({"event":"arb","status":"receipt_timeout","txHash":format!("{hash:#x}")})
                );
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{sizing_ladder, universe_assets, validate_min_net_profit_usd, MIN_NET_PROFIT_USD};

    #[test]
    fn detects_dex_pair_dispatch_selector_only_as_push4() {
        use super::{has_selector, DEX_PAIR_SELECTOR};
        assert!(has_selector(&[0x60, 0x00, 0x63, 0x0b, 0xde, 0x7b, 0x85, 0x14], DEX_PAIR_SELECTOR));
        assert!(!has_selector(&[0x60, 0x0b, 0xde, 0x7b, 0x85], DEX_PAIR_SELECTOR), "bare bytes are not a dispatch entry");
    }

    #[test]
    fn edge_04_skips_assets_without_feed_or_lender_and_never_defaults_to_one_dollar() {
        let raw = r#"{"schemaVersion":"pool-universe/1","chainId":42161,"expiresAt":"2999-01-01T00:00:00Z","pools":[],"pairs":[],"assets":[
          {"address":"0x82af49447d8a07e3bd95bd0d56f35241523fbab1","symbol":"WETH","decimals":18,"usdFeed":"0x639fe6ab55c921f74e7fac1ee960c0b6293ba612","flashLenders":[{"kind":"BALANCER_V2"}]},
          {"address":"0x912ce59144191c1204e64559fe8253a0e49e6548","symbol":"ARB","decimals":18,"usdFeed":"0xb2a824043730fe05f3da2efafa1cbbe83fa548d6","flashLenders":[]},
          {"address":"0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f","symbol":"WBTC","decimals":8,"usdFeed":null,"flashLenders":[{"kind":"BALANCER_V2"}]}]}"#;
        let u = crate::universe::parse(raw, 42161, 0).unwrap();
        let assets = universe_assets(&u).unwrap();
        assert_eq!(assets.iter().map(|a| a.symbol.as_str()).collect::<Vec<_>>(), vec!["WETH"]);
        assert!(assets.iter().all(|a| a.feed.is_some()));
        let none = crate::universe::parse(&raw.replace("[{\"kind\":\"BALANCER_V2\"}]", "[]"), 42161, 0).unwrap();
        assert_eq!(universe_assets(&none).unwrap_err().to_string(), "NO_PRICED_FLASH_ASSET_IN_UNIVERSE");
        println!("universe_no_unpriced_flash_asset_proven");
    }

    #[test]
    fn samples_a_bounded_dynamic_size_range_without_static_tiers() {
        let sizes = sizing_ladder(1_000.0, 500_000.0).unwrap();
        assert_eq!(sizes.first(), Some(&1_000.0));
        assert_eq!(sizes.last(), Some(&500_000.0));
        assert_eq!(sizes.len(), 12);
        assert!(sizes.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn keeps_the_profit_floor_at_ten_dollars() {
        assert_eq!(MIN_NET_PROFIT_USD, 10.0);
        assert!(validate_min_net_profit_usd(9.99).is_err());
        assert_eq!(validate_min_net_profit_usd(10.0).unwrap(), 10.0);
    }
}
