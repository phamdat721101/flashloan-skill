//! One-shot, Rust-signed deployment of the dynamic V4 executor.
//!
//! The bytecode is read from a locally built Forge artifact. No pool, target,
//! or route is accepted at deployment: protocol roots are configured later in
//! separate owner transactions after they have been independently verified.
use alloy::{
    network::{EthereumWallet, TransactionBuilder},
    primitives::{keccak256, Address, B256, Bytes},
    providers::{Provider, ProviderBuilder},
    rpc::types::TransactionRequest,
    signers::local::PrivateKeySigner,
    sol,
    sol_types::SolCall,
};
use serde_json::Value;
use std::{env, fs, time::Duration};

const CHAIN_ID: u64 = 42161;

sol! {
    interface IExecutorConfig {
        function configureAaveProvider(address provider, bytes32 codeHash, bool allowed) external;
        function configurePoolManager(address manager, bytes32 codeHash, bool allowed, bool allowHooks) external;
    }
}

fn artifact_bytecode(path: &str) -> Result<Bytes, Box<dyn std::error::Error>> {
    let artifact: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    let object = artifact.pointer("/bytecode/object").and_then(Value::as_str).ok_or("ARTIFACT_BYTECODE_MISSING")?;
    let bytes = alloy::hex::decode(object.trim_start_matches("0x"))?;
    if bytes.is_empty() { return Err("ARTIFACT_BYTECODE_EMPTY".into()); }
    Ok(Bytes::from(bytes))
}

pub async fn run(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let artifact = args.first().ok_or("usage: flashloan-scan deploy-v4 <forge-artifact.json> <aave-provider> <v4-pool-manager>")?;
    let aave_provider: Address = args.get(1).ok_or("AAVE_PROVIDER_REQUIRED")?.parse()?;
    let v4_pool_manager: Address = args.get(2).ok_or("V4_POOL_MANAGER_REQUIRED")?.parse()?;
    let rpc = env::var("ARBITRUM_RPC_URL")?;
    let relay = env::var("PRIVATE_RELAY_URL")?;
    let signer: PrivateKeySigner = env::var("OPERATOR_PRIVATE_KEY")?.parse()?;
    let from: Address = signer.address();
    let bytecode = artifact_bytecode(artifact)?;
    let public = ProviderBuilder::new().connect_http(rpc.parse()?);
    if public.get_chain_id().await? != CHAIN_ID { return Err("CHAIN_MISMATCH".into()); }
    if public.get_balance(from).await?.is_zero() { return Err("DEPLOYER_HAS_NO_ETH".into()); }

    let nonce = public.get_transaction_count(from).await?;
    let draft = TransactionRequest::default().with_from(from).with_deploy_code(bytecode.clone()).with_nonce(nonce).with_chain_id(CHAIN_ID);
    let gas_limit = public.estimate_gas(draft.clone()).await?;
    let fees = public.estimate_eip1559_fees().await?;
    // Re-estimate at the send boundary, because the account nonce and base fee can change.
    let final_gas_limit = public.estimate_gas(draft.clone()).await?;
    let tx = draft.with_gas_limit(final_gas_limit.max(gas_limit)).with_max_fee_per_gas(fees.max_fee_per_gas).with_max_priority_fee_per_gas(fees.max_priority_fee_per_gas);
    let private = ProviderBuilder::new().wallet(EthereumWallet::from(signer.clone())).connect_http(relay.parse()?);
    let hash = *private.send_transaction(tx).await?.tx_hash();
    println!("{}", serde_json::json!({"event":"deploy-v4","status":"sent","txHash":format!("{hash:#x}"),"from":format!("{from:#x}"),"chainId":CHAIN_ID}));
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if let Some(receipt) = public.get_transaction_receipt(hash).await? {
            let address = receipt.contract_address;
            if !receipt.status() || address.is_none() { return Err("DEPLOYMENT_REVERTED_OR_NO_CONTRACT_ADDRESS".into()); }
            let address = address.expect("checked");
            if public.get_code_at(address).await?.is_empty() { return Err("DEPLOYED_CODE_MISSING".into()); }
            println!("{}", serde_json::json!({"event":"deploy-v4","status":"confirmed","txHash":format!("{hash:#x}"),"contract":format!("{address:#x}"),"gasUsed":receipt.gas_used}));
            let provider_code = public.get_code_at(aave_provider).await?;
            let manager_code = public.get_code_at(v4_pool_manager).await?;
            if provider_code.is_empty() || manager_code.is_empty() { return Err("ROOT_CODE_MISSING".into()); }
            let provider_hash: B256 = keccak256(provider_code);
            let manager_hash: B256 = keccak256(manager_code);
            let setup = [
                ("aave-provider", IExecutorConfig::configureAaveProviderCall { provider: aave_provider, codeHash: provider_hash, allowed: true }.abi_encode()),
                ("v4-pool-manager", IExecutorConfig::configurePoolManagerCall { manager: v4_pool_manager, codeHash: manager_hash, allowed: true, allowHooks: false }.abi_encode()),
            ];
            for (root, data) in setup {
                let setup_nonce = public.get_transaction_count(from).await?;
                let setup_draft = TransactionRequest::default().with_to(address).with_from(from).with_input(Bytes::from(data)).with_nonce(setup_nonce).with_chain_id(CHAIN_ID);
                let setup_gas = public.estimate_gas(setup_draft.clone()).await?;
                let setup_fees = public.estimate_eip1559_fees().await?;
                let setup_tx = setup_draft.with_gas_limit(setup_gas).with_max_fee_per_gas(setup_fees.max_fee_per_gas).with_max_priority_fee_per_gas(setup_fees.max_priority_fee_per_gas);
                let setup_private = ProviderBuilder::new().wallet(EthereumWallet::from(signer.clone())).connect_http(relay.parse()?);
                let setup_hash = *setup_private.send_transaction(setup_tx).await?.tx_hash();
                let mut confirmed = false;
                for _ in 0..60 {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if let Some(setup_receipt) = public.get_transaction_receipt(setup_hash).await? {
                        if !setup_receipt.status() { return Err("ROOT_CONFIGURATION_REVERTED".into()); }
                        println!("{}", serde_json::json!({"event":"deploy-v4","status":"root-configured","root":root,"txHash":format!("{setup_hash:#x}"),"codeHash":format!("{:#x}", if root == "aave-provider" { provider_hash } else { manager_hash })}));
                        confirmed = true;
                        break;
                    }
                }
                if !confirmed { return Err("ROOT_CONFIGURATION_RECEIPT_TIMEOUT".into()); }
            }
            return Ok(());
        }
    }
    Err("DEPLOYMENT_RECEIPT_TIMEOUT".into())
}
