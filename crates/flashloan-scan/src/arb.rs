//! `arb` subcommand: multi-asset exact-simulation DEX-pair flash arbitrage. Dry-run by default.
//! `--live` sends ONE tx via PRIVATE_RELAY_URL only after a fresh re-simulation clears
//! priced from live Chainlink feeds; the executor enforces minProfit on-chain.
use alloy::{
    network::{EthereumWallet, TransactionBuilder},
    primitives::{Address, U256, address},
    providers::{Provider, ProviderBuilder},
    rpc::types::TransactionRequest,
    signers::local::PrivateKeySigner,
    sol,
};
use std::{env, time::Duration};

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
const ARB: Address = address!("912CE59144191C1204E64559FE8253a0e49E6548");
const WBTC: Address = address!("2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f");
const LINK: Address = address!("f97f4df75117a78c1A5a0DBb814Af92458539FB4");
const WSTETH: Address = address!("5979D7b546E38E414F7E9822514be443A4800529");

const ETH_USD: Address = address!("639Fe6ab55C921f74e7fac1ee960C0B6293ba612");
const USDC_USD: Address = address!("50834F3163758fcC1Df9973b6e91f0F0F0434aD3");
const CHAIN_ID: u64 = 42161;
const MAX_ORACLE_AGE_S: u64 = 90_000;
const VENUES: [u8; 3] = [0, 1, 2]; // 0: camelot-v3, 1: uniswap-v3, 2: pancakeswap-v3
const UNI_FEES: [u32; 3] = [100, 500, 3000];

#[derive(Clone, Copy, Debug)]
struct Asset {
    token: Address,
    symbol: &'static str,
}

const FLASH_ASSETS: [Asset; 3] = [
    Asset { token: WETH, symbol: "WETH" },
    Asset { token: USDC, symbol: "USDC" },
    Asset { token: USDT, symbol: "USDT" },
];

const DEFAULT_TARGETS: [Address; 7] = [ARB, WETH, USDC, USDT, WSTETH, WBTC, LINK];

fn envf(k: &str, d: f64) -> f64 { env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d) }

pub async fn run(live: bool) -> Result<(), Box<dyn std::error::Error>> {
    let rpc = env::var("ARBITRUM_RPC_URL")?;
    let exec_addr: Address = env::var("FLASH_EXECUTOR_ADDRESS")?.parse()?;
    let min_net = envf("MIN_NET_PROFIT_USD", 0.000001);
    let max_gas_usd = envf("MAX_GAS_USD", 5.0);
    let max_flash_usd = envf("MAX_FLASH_USD", 500_000.0);
    let sizes: Vec<f64> = env::var("FLASH_SIZES_USD")
        .unwrap_or("0.25,0.5,1,2,5,10,25,50,100,250,500".into())
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .filter(|s| *s <= max_flash_usd)
        .collect();

    let targets: Vec<Address> = env::var("TARGET_TOKENS")
        .ok()
        .map(|v| v.split(',').filter_map(|a| a.trim().parse().ok()).collect())
        .unwrap_or(DEFAULT_TARGETS.to_vec());

    let p = ProviderBuilder::new().connect_http(rpc.parse()?);
    let exec = IExec::new(exec_addr, &p);
    if p.get_chain_id().await? != CHAIN_ID { return Err("CHAIN_MISMATCH".into()); }
    if p.get_code_at(exec_addr).await?.is_empty() { return Err("EXECUTOR_NOT_DEPLOYED".into()); }
    let owner = exec.owner().call().await?;

    let (signer, relay) = if live {
        let signer: PrivateKeySigner = env::var("OPERATOR_PRIVATE_KEY")?.parse()?;
        if signer.address() != owner { return Err("SIGNER_NOT_OWNER".into()); }
        (Some(signer), Some(env::var("PRIVATE_RELAY_URL")?))
    } else { (None, None) };

    loop {
        let price = |feed: Address| { let p = &p; async move {
            let f = IFeed::new(feed, p);
            let d = f.decimals().call().await?;
            let r = f.latestRoundData().call().await?;
            let now = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Latest).await?.ok_or("no block")?.header.timestamp;
            if now.saturating_sub(r.updatedAt.to::<u64>()) > MAX_ORACLE_AGE_S { return Err::<f64, Box<dyn std::error::Error>>("ORACLE_STALE".into()); }
            Ok(f64::from(r.answer.into_raw()) / 10f64.powi(d as i32))
        }};
        let (eth_usd, usdc_usd) = match (price(ETH_USD).await, price(USDC_USD).await) {
            (Ok(a), Ok(b)) => (a, b),
            (a, b) => {
                println!("{}", serde_json::json!({"event":"arb","status":"blocked","code":"ORACLE","detail":format!("{:?}/{:?}", a.err().map(|e| e.to_string()), b.err().map(|e| e.to_string()))}));
                tokio::time::sleep(Duration::from_secs(4)).await;
                continue;
            }
        };
        let gas_price = p.get_gas_price().await? as f64;

        let to_units = |token: Address, usd: f64| -> U256 {
            if token == WETH {
                let eth = usd / eth_usd;
                U256::from((eth * 1e18).ceil() as u128)
            } else if token == USDC {
                let usdc = usd / usdc_usd;
                U256::from((usdc * 1e6).ceil() as u128)
            } else {
                U256::from((usd * 1e6).ceil() as u128)
            }
        };

        let min_profit_units = |token: Address, min_usd: f64| -> U256 {
            if min_usd <= 0.0001 {
                U256::from(1)
            } else {
                let u = to_units(token, min_usd);
                if u.is_zero() { U256::from(1) } else { u }
            }
        };

        let mut hit = None;
        let probe = sizes[0];

        // Multi-asset combo generator
        let mut all_combos = Vec::new();
        for flash in &FLASH_ASSETS {
            for &t in &targets {
                if t == flash.token { continue; }
                for &b in &VENUES {
                    for &s in &VENUES {
                        if s == b { continue; }
                        for &fee in &UNI_FEES {
                            all_combos.push((flash.token, flash.symbol, t, b, s, fee));
                        }
                    }
                }
            }
        }

        // Fast parallel probe
        let alive: Vec<_> = futures_util::future::join_all(all_combos.iter().map(|&(ft, sym, t, b, sl, f)| {
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
                let r = exec.executeDexPairArbitrage(params).from(owner).estimate_gas().await;
                if let (Err(e), true) = (&r, env::var("ARB_DEBUG").is_ok()) {
                    eprintln!("probe {sym}->{t:#x} b={b} s={sl} f={f}: {}", e.to_string().chars().take(80).collect::<String>());
                }
                r.is_ok().then_some((ft, sym, t, b, sl, f))
            }
        })).await.into_iter().flatten().collect();

        'search: for &size in &sizes {
            for &(ft, sym, t, buy, sell, fee) in &alive {
                let amt = to_units(ft, size);
                let mp = min_profit_units(ft, min_net);
                let params = IExec::DexPairParams {
                    flashToken: ft,
                    flashAmount: amt,
                    targetToken: t,
                    buyVenue: buy,
                    sellVenue: sell,
                    uniFee: fee.try_into().unwrap(),
                    minProfit: mp,
                };
                let Ok(gas) = exec.executeDexPairArbitrage(params.clone()).from(owner).estimate_gas().await else { continue };
                let gas_usd = gas as f64 * gas_price / 1e18 * eth_usd;
                if gas_usd > max_gas_usd { continue; }

                if exec.executeDexPairArbitrage(params.clone()).from(owner).call().await.is_ok() {
                    hit = Some((size, ft, sym, t, buy, sell, fee, gas, gas_usd, params));
                    break 'search;
                }
            }
        }

        let alive_n = alive.len();
        match hit {
            None => println!("{}", serde_json::json!({
                "event":"arb",
                "status":"no_edge",
                "ethUsd":eth_usd,
                "usdcUsd":usdc_usd,
                "minNetUsd":min_net,
                "sizesUsd":sizes,
                "pairsAlive":alive_n,
                "combosProbed":all_combos.len()
            })),
            Some((size, ft, sym, t, buy, sell, fee, gas, gas_usd, params)) => {
                println!("{}", serde_json::json!({
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
                }));

                let (Some(signer), Some(relay)) = (&signer, &relay) else {
                    tokio::time::sleep(Duration::from_secs(4)).await;
                    continue;
                };

                // Fresh re-simulation immediately before broadcast
                if exec.executeDexPairArbitrage(params.clone()).from(owner).call().await.is_err() {
                    println!("{}", serde_json::json!({"event":"arb","status":"stale_before_send"}));
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
                println!("{}", serde_json::json!({"event":"arb","status":"sent","txHash":format!("{hash:#x}")}));

                for _ in 0..60 {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if let Some(rc) = p.get_transaction_receipt(hash).await? {
                        let profit = rc.inner.logs().iter()
                            .find_map(|l| l.log_decode::<IExec::DexPairArbitrageExecuted>().ok())
                            .map(|e| e.inner.data.netProfit.to_string());
                        println!("{}", serde_json::json!({
                            "event":"arb",
                            "status":"receipt",
                            "success":rc.status(),
                            "blockNumber":rc.block_number,
                            "gasUsed":rc.gas_used,
                            "netProfitUnits":profit,
                            "flashAsset":sym
                        }));
                        return Ok(()); // one-shot live execution: operator reviews P&L
                    }
                }
                println!("{}", serde_json::json!({"event":"arb","status":"receipt_timeout","txHash":format!("{hash:#x}")}));
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}
