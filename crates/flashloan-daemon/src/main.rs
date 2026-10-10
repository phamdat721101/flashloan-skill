use alloy::primitives::U256;
use flashloan_core::{
    DexPairCall, EngineConfig, Head, LiveHeads, Pool, find_affected_cycles, hex_encode,
    require_current_pool_snapshot, speculate_v2_two_hop,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, env, fs, process::ExitCode, str::FromStr};

#[derive(Debug, Deserialize)]
#[serde(
    tag = "eventType",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum InboundEvent {
    Head {
        head: Head,
    },
    PoolUpsert {
        pool: Pool,
    },
    Scan {
        anchor_token: String,
        amount_in: String,
        now_ms: u64,
    },
    /// A target swap is projected into its pool snapshot before choosing a
    /// two-hop V2 flash amount. The emitted plan is analytical and unsigned.
    SpeculateV2 {
        target_pool_id: String,
        counter_pool_id: String,
        flash_token: String,
        target_amount_in: String,
        flash_loan_fee_bps: u16,
        fixed_cost: String,
        now_ms: u64,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonEvent<'a> {
    schema_version: &'a str,
    event_type: &'a str,
    status: &'a str,
    code: Option<String>,
    data: serde_json::Value,
}

fn emit(event_type: &str, status: &str, code: Option<String>, data: serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string(&DaemonEvent {
            schema_version: "2.0",
            event_type,
            status,
            code,
            data
        })
        .expect("serializable event")
    );
}

fn usage() -> ExitCode {
    eprintln!(
        "usage: flashloan-daemon replay <config.json> <events.jsonl> | validate-config <config.json>"
    );
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 && args.len() != 4 {
        return usage();
    }
    let config: EngineConfig = match fs::read_to_string(&args[2])
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
    {
        Some(value) => value,
        None => {
            eprintln!("INVALID_CONFIG: cannot parse config");
            return ExitCode::from(1);
        }
    };
    if let Err(error) = config.validate() {
        eprintln!("{error}");
        return ExitCode::from(1);
    }
    if args[1] == "validate-config" {
        emit(
            "config",
            "ready",
            None,
            serde_json::json!({ "chainId": config.chain_id }),
        );
        return ExitCode::SUCCESS;
    }
    if args[1] != "replay" || args.len() != 4 {
        return usage();
    }
    let input = match fs::read_to_string(&args[3]) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("INPUT_ERROR:{error}");
            return ExitCode::from(1);
        }
    };
    let mut heads = LiveHeads::default();
    let mut pools = HashMap::<String, Pool>::new();
    for (line_number, line) in input
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
    {
        let event: InboundEvent = match serde_json::from_str(line) {
            Ok(event) => event,
            Err(error) => {
                emit(
                    "rejection",
                    "rejected",
                    Some("INVALID_EVENT".into()),
                    serde_json::json!({ "line": line_number + 1, "message": error.to_string() }),
                );
                continue;
            }
        };
        match event {
            InboundEvent::Head { head } => match heads.apply(head) {
                Ok(epoch) => emit(
                    "head",
                    "accepted",
                    None,
                    serde_json::to_value(epoch).unwrap(),
                ),
                Err(error) => emit(
                    "head",
                    "rejected",
                    Some(error.to_string()),
                    serde_json::json!({ "line": line_number + 1 }),
                ),
            },
            InboundEvent::PoolUpsert { pool } => {
                let pool_id = pool.id.clone();
                pools.insert(pool_id.clone(), pool);
                emit(
                    "pool_discovered",
                    "accepted",
                    None,
                    serde_json::json!({ "poolId": pool_id }),
                );
            }
            InboundEvent::Scan {
                anchor_token,
                amount_in,
                now_ms,
            } => {
                let epoch = match heads.executable_epoch(now_ms, config.risk.max_state_age_ms) {
                    Ok(epoch) => epoch,
                    Err(error) => {
                        emit(
                            "decision",
                            "halted",
                            Some(error.to_string()),
                            serde_json::json!({ "anchorToken": anchor_token }),
                        );
                        continue;
                    }
                };
                let amount = match U256::from_str(&amount_in) {
                    Ok(amount) if amount > U256::ZERO => amount,
                    _ => {
                        emit(
                            "decision",
                            "rejected",
                            Some("INVALID_AMOUNT".into()),
                            serde_json::json!({ "amountIn": amount_in }),
                        );
                        continue;
                    }
                };
                match find_affected_cycles(
                    &pools.values().cloned().collect::<Vec<_>>(),
                    &anchor_token,
                    amount,
                    config.risk.max_hops,
                ) {
                    Ok(routes) => {
                        let min_profit = U256::from_str(&config.execution.min_profit_wei)
                            .expect("validated config");
                        let routes = routes.into_iter().map(|route| {
                            let executor_calldata = if route.executable {
                                DexPairCall::from_two_hop(&route, &pools, min_profit)
                                    .and_then(|call| call.calldata())
                                    .map(|data| format!("0x{}", hex_encode(&data)))
                                    .ok()
                            } else { None };
                            serde_json::json!({ "candidate": route, "executorCalldata": executor_calldata })
                        }).collect::<Vec<_>>();
                        emit(
                            "route_candidate",
                            "accepted",
                            None,
                            serde_json::json!({ "epoch": epoch, "routes": routes }),
                        )
                    }
                    Err(error) => emit(
                        "decision",
                        "rejected",
                        Some(error.to_string()),
                        serde_json::json!({ "anchorToken": anchor_token }),
                    ),
                }
            }
            InboundEvent::SpeculateV2 {
                target_pool_id,
                counter_pool_id,
                flash_token,
                target_amount_in,
                flash_loan_fee_bps,
                fixed_cost,
                now_ms,
            } => {
                let epoch = match heads.executable_epoch(now_ms, config.risk.max_state_age_ms) {
                    Ok(epoch) => epoch,
                    Err(error) => {
                        emit(
                            "speculative_plan",
                            "halted",
                            Some(error.to_string()),
                            serde_json::json!({ "targetPoolId": target_pool_id }),
                        );
                        continue;
                    }
                };
                let target_amount = match U256::from_str(&target_amount_in) {
                    Ok(amount) if amount > U256::ZERO => amount,
                    _ => {
                        emit(
                            "speculative_plan",
                            "rejected",
                            Some("INVALID_TARGET_AMOUNT".into()),
                            serde_json::json!({ "targetAmountIn": target_amount_in }),
                        );
                        continue;
                    }
                };
                let fixed_cost = match U256::from_str(&fixed_cost) {
                    Ok(cost) => cost,
                    Err(_) => {
                        emit(
                            "speculative_plan",
                            "rejected",
                            Some("INVALID_FIXED_COST".into()),
                            serde_json::json!({ "fixedCost": fixed_cost }),
                        );
                        continue;
                    }
                };
                let Some(target_pool) = pools.get(&target_pool_id) else {
                    emit(
                        "speculative_plan",
                        "rejected",
                        Some("UNKNOWN_TARGET_POOL".into()),
                        serde_json::json!({ "targetPoolId": target_pool_id }),
                    );
                    continue;
                };
                let Some(counter_pool) = pools.get(&counter_pool_id) else {
                    emit(
                        "speculative_plan",
                        "rejected",
                        Some("UNKNOWN_COUNTER_POOL".into()),
                        serde_json::json!({ "counterPoolId": counter_pool_id }),
                    );
                    continue;
                };
                if let Err(error) = require_current_pool_snapshot(
                    target_pool,
                    &epoch,
                    now_ms,
                    config.risk.max_state_age_ms,
                )
                .and_then(|_| {
                    require_current_pool_snapshot(
                        counter_pool,
                        &epoch,
                        now_ms,
                        config.risk.max_state_age_ms,
                    )
                }) {
                    emit(
                        "speculative_plan",
                        "rejected",
                        Some(error.to_string()),
                        serde_json::json!({ "targetPoolId": target_pool_id, "counterPoolId": counter_pool_id }),
                    );
                    continue;
                }
                match speculate_v2_two_hop(
                    target_pool,
                    counter_pool,
                    &flash_token,
                    target_amount,
                    flash_loan_fee_bps,
                    fixed_cost,
                ) {
                    Ok(Some(plan)) => emit(
                        "speculative_plan",
                        "accepted",
                        None,
                        serde_json::json!({ "epoch": epoch, "plan": plan, "signed": false }),
                    ),
                    Ok(None) => emit(
                        "speculative_plan",
                        "rejected",
                        Some("NO_PROFITABLE_V2_ROUTE".into()),
                        serde_json::json!({ "targetPoolId": target_pool_id, "counterPoolId": counter_pool_id }),
                    ),
                    Err(error) => emit(
                        "speculative_plan",
                        "rejected",
                        Some(error.to_string()),
                        serde_json::json!({ "targetPoolId": target_pool_id, "counterPoolId": counter_pool_id }),
                    ),
                }
            }
        }
    }
    ExitCode::SUCCESS
}
