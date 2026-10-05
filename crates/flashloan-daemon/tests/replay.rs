use std::{env, fs, process::Command};

#[test]
fn replay_requires_dual_live_heads_and_emits_an_executable_two_hop_candidate() {
    let root = env::temp_dir().join(format!("flashloan-daemon-replay-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let config = root.join("config.json");
    let events = root.join("events.jsonl");
    fs::write(&config, r#"{
      "schemaVersion":"2.0","chainId":42161,
      "factories":[{"venue":"uniswap-v2","address":"0x0000000000000000000000000000000000000001","startBlock":1}],
      "risk":{"maxHops":6,"maxStateAgeMs":1000,"minPoolLiquidityUsdE8":"2500000","minRouteLiquidityUsdE8":"10000000","canaryNotionalUsdE8":"1000000000"},
      "execution":{"executor":{"address":"0x0000000000000000000000000000000000000001","runtimeCodeHash":"0x01","selector":"0xd0c4f3d2"},"relay":{"protocol":"rpc-send-raw-transaction","urlEnv":"PRIVATE_RELAY_URL"},"minProfitWei":"1"}
    }"#).unwrap();
    let selector = flashloan_core::selector_hex();
    let config_raw = fs::read_to_string(&config)
        .unwrap()
        .replace("0xd0c4f3d2", &selector);
    fs::write(&config, config_raw).unwrap();
    fs::write(&events, r#"{"eventType":"head","head":{"source":"canonical","sequence":1,"blockNumber":100,"blockHash":"0xa","parentHash":"0x9","observedAtMs":100}}
{"eventType":"head","head":{"source":"sequencer","sequence":1,"blockNumber":101,"blockHash":"0xb","parentHash":"0xa","observedAtMs":101}}
{"eventType":"poolUpsert","pool":{"id":"buy","venue":"uniswap-v2","venueId":1,"token0":"0x0000000000000000000000000000000000000001","token1":"0x0000000000000000000000000000000000000002","state":{"kind":"v2","reserve0":"100000","reserve1":"200000","feeBps":30}}}
{"eventType":"poolUpsert","pool":{"id":"sell","venue":"uniswap-v2","venueId":2,"token0":"0x0000000000000000000000000000000000000002","token1":"0x0000000000000000000000000000000000000001","state":{"kind":"v2","reserve0":"100000","reserve1":"200000","feeBps":30}}}
{"eventType":"scan","anchorToken":"0x0000000000000000000000000000000000000001","amountIn":"1000","nowMs":110}"#).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_flashloan-daemon"))
        .args(["replay", config.to_str().unwrap(), events.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        stdout.contains("\"eventType\":\"route_candidate\""),
        "stdout: {stdout}"
    );
    assert!(stdout.contains("\"executable\":true"), "stdout: {stdout}");
    assert!(
        stdout.contains("\"executorCalldata\":\"0x"),
        "stdout: {stdout}"
    );
    fs::remove_dir_all(root).unwrap();
}
