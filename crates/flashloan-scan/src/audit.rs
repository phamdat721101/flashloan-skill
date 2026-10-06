//! Read-only external Aave V3 flash-loan receipt audit for Arbitrum.
use alloy::{
    primitives::{address, Address, U256},
    providers::{Provider, ProviderBuilder},
    rpc::types::Filter,
    sol,
    sol_types::SolEvent,
};
use std::env;

sol! {
    event AaveFlashLoan(
        address indexed target,
        address indexed initiator,
        address indexed asset,
        uint256 amount,
        uint8 interestRateMode,
        uint256 premium,
        uint16 referralCode
    );
    event MorphoFlashLoan(address indexed sender, address indexed token, uint256 amount);
    event BalancerFlashLoan(address indexed recipient, address indexed token, uint256 amount, uint256 feeAmount);
    event Erc20Transfer(address indexed from, address indexed to, uint256 value);
}

const AAVE_V3_POOL: Address = address!("794a61358D6845594F94dc1DB02A252b5b4814aD");
const MORPHO_BLUE: Address = address!("6c247b1F6182318877311737BaC0844bAa518F5e");
const BALANCER_V2_VAULT: Address = address!("BA12222222228d8Ba445958a75a0704d566BF2C8");
const FINALITY_BLOCKS: u64 = 20;
const DEFAULT_LOOKBACK_BLOCKS: u64 = 2_000_000;

fn as_decimal(value: U256) -> String {
    value.to_string()
}

/// Audits one completed external flash loan. An observed payout is evidence to investigate,
/// not a proof of profit: a balance-before/after trace is still required for that claim.
pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let rpc = env::var("ARBITRUM_RPC_URL")?;
    let lookback = env::var("AUDIT_LOOKBACK_BLOCKS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_LOOKBACK_BLOCKS);
    let provider = ProviderBuilder::new().connect_http(rpc.parse()?);
    let finalized_head = provider
        .get_block_number()
        .await?
        .saturating_sub(FINALITY_BLOCKS);
    let latest = env::var("AUDIT_TO_BLOCK")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(finalized_head)
        .min(finalized_head);
    let from = latest.saturating_sub(lookback);
    let aave_filter = Filter::new()
        .address(AAVE_V3_POOL)
        .event_signature(AaveFlashLoan::SIGNATURE_HASH)
        .from_block(from)
        .to_block(latest);
    let morpho_filter = Filter::new()
        .address(MORPHO_BLUE)
        .event_signature(MorphoFlashLoan::SIGNATURE_HASH)
        .from_block(from)
        .to_block(latest);
    let balancer_filter = Filter::new()
        .address(BALANCER_V2_VAULT)
        .event_signature(BalancerFlashLoan::SIGNATURE_HASH)
        .from_block(from)
        .to_block(latest);
    let mut aave_logs = provider.get_logs(&aave_filter).await?;
    let mut morpho_logs = provider.get_logs(&morpho_filter).await?;
    let mut balancer_logs = provider.get_logs(&balancer_filter).await?;
    let order = |log: &alloy::rpc::types::Log| {
        (
            log.block_number.unwrap_or_default(),
            log.log_index.unwrap_or_default(),
        )
    };
    aave_logs.sort_by_key(order);
    morpho_logs.sort_by_key(order);
    balancer_logs.sort_by_key(order);
    let selected = [
        ("aave-v3", aave_logs.pop()),
        ("morpho-blue", morpho_logs.pop()),
        ("balancer-v2", balancer_logs.pop()),
    ]
    .into_iter()
    .filter_map(|(protocol, log)| log.map(|log| (protocol, log)))
    .max_by_key(|(_, log)| order(log));
    let Some((protocol, log)) = selected else {
        println!(
            "{}",
            serde_json::json!({"event":"audit","status":"no_flashloan","fromBlock":from,"toBlock":latest})
        );
        return Ok(());
    };
    let (target, initiator, asset, amount, premium) = match protocol {
        "aave-v3" => {
            let flash = log.log_decode::<AaveFlashLoan>()?.inner.data;
            (
                flash.target,
                Some(flash.initiator),
                flash.asset,
                flash.amount,
                flash.premium,
            )
        }
        "morpho-blue" => {
            let flash = log.log_decode::<MorphoFlashLoan>()?.inner.data;
            (flash.sender, None, flash.token, flash.amount, U256::ZERO)
        }
        "balancer-v2" => {
            let flash = log.log_decode::<BalancerFlashLoan>()?.inner.data;
            (
                flash.recipient,
                None,
                flash.token,
                flash.amount,
                flash.feeAmount,
            )
        }
        _ => return Err("UNRECOGNIZED_PROTOCOL".into()),
    };
    let tx_hash = log.transaction_hash.ok_or("MISSING_TRANSACTION_HASH")?;
    let receipt = provider
        .get_transaction_receipt(tx_hash)
        .await?
        .ok_or("MISSING_RECEIPT")?;
    let mut repaid = U256::ZERO;
    let mut payout = U256::ZERO;
    let mut payout_recipient: Option<Address> = None;
    for transfer_log in receipt.inner.logs() {
        if transfer_log.address() != asset {
            continue;
        }
        let Ok(transfer) = transfer_log.log_decode::<Erc20Transfer>() else {
            continue;
        };
        let transfer = transfer.inner.data;
        if transfer.to == AAVE_V3_POOL || transfer.to == BALANCER_V2_VAULT {
            repaid += transfer.value;
        }
        if transfer.from == target
            && transfer.to != AAVE_V3_POOL
            && transfer.to != BALANCER_V2_VAULT
            && transfer.value > payout
        {
            payout = transfer.value;
            payout_recipient = Some(transfer.to);
        }
    }
    let premium_observed = repaid.saturating_sub(amount);
    println!(
        "{}",
        serde_json::json!({
            "event":"audit",
            "status":"observed",
            "protocol":protocol,
            "transactionHash":format!("{tx_hash:#x}"),
            "blockNumber":log.block_number.unwrap_or_default(),
            "target":format!("{target:#x}"),
            "initiator":initiator.map(|address| format!("{address:#x}")),
            "asset":format!("{asset:#x}"),
            "loanAmount":as_decimal(amount),
            "premium":as_decimal(premium),
            "repaymentObserved":as_decimal(repaid),
            "premiumObserved":as_decimal(premium_observed),
            "largestSameAssetPayout":as_decimal(payout),
            "payoutRecipient":payout_recipient.map(|address| format!("{address:#x}")),
            "profitProven":false,
            "note":"Receipt-level payout is a lead only; profit requires pre/post-balance or trace verification."
        })
    );
    Ok(())
}
