module terminal_profit_guard::terminal_profit_guard;

use sui::coin::{Self, Coin};
use sui::event;
use sui::object::{Self, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};

const E_UNAUTHORIZED_OPERATOR: u64 = 1;
const E_MIN_PROFIT_NOT_MET: u64 = 2;
const E_ZERO_TREASURY: u64 = 3;
const E_EXECUTION_PAUSED: u64 = 4;

public struct AdminCap has key, store {
    id: UID,
}

public struct OperatorCap has key, store {
    id: UID,
    operator: address,
    treasury: address,
}

/// Separate state keeps the original OperatorCap layout upgrade-compatible.
public struct PauseCap has key, store {
    id: UID,
    paused: bool,
}

public struct ProfitSwept<phantom T> has copy, drop {
    amount: u64,
    treasury: address,
    operator: address,
    route_hash: vector<u8>,
}

public struct ExecutionPauseChanged has copy, drop {
    paused: bool,
}

fun init(ctx: &mut TxContext) {
    let sender = tx_context::sender(ctx);
    let admin = AdminCap { id: object::new(ctx) };
    let operator = OperatorCap {
        id: object::new(ctx),
        operator: sender,
        treasury: sender,
    };
    transfer::transfer(admin, sender);
    transfer::transfer(operator, sender);
}

/// Rotating policy needs the admin capability; callers cannot supply a per-trade recipient.
public entry fun rotate_operator(
    _admin: &AdminCap,
    cap: &mut OperatorCap,
    operator: address,
    treasury: address,
) {
    assert!(treasury != @0x0, E_ZERO_TREASURY);
    cap.operator = operator;
    cap.treasury = treasury;
}

/// Creates a separately-owned execution switch after an upgrade without changing existing cap storage.
public entry fun create_pause_cap(_admin: &AdminCap, ctx: &mut TxContext) {
    transfer::transfer(PauseCap { id: object::new(ctx), paused: false }, tx_context::sender(ctx));
}

/// An incident switch that preserves custody while preventing guarded profit sweeps.
public entry fun set_execution_paused(_admin: &AdminCap, cap: &mut PauseCap, paused: bool) {
    cap.paused = paused;
    event::emit(ExecutionPauseChanged { paused });
}

/// The route compiler must pass every post-repayment base-asset remainder as `profit`.
public entry fun assert_min_profit_and_transfer<T>(
    cap: &OperatorCap,
    profit: Coin<T>,
    min_profit: u64,
    route_hash: vector<u8>,
    ctx: &mut TxContext,
) {
    let sender = tx_context::sender(ctx);
    assert!(sender == cap.operator, E_UNAUTHORIZED_OPERATOR);
    let amount = coin::value(&profit);
    assert!(amount >= min_profit, E_MIN_PROFIT_NOT_MET);
    event::emit(ProfitSwept<T> {
        amount,
        treasury: cap.treasury,
        operator: sender,
        route_hash,
    });
    transfer::public_transfer(profit, cap.treasury);
}

/// Use this entry point for all new route compilers after creating a PauseCap.
public entry fun assert_min_profit_and_transfer_with_pause<T>(
    cap: &OperatorCap,
    pause_cap: &PauseCap,
    profit: Coin<T>,
    min_profit: u64,
    route_hash: vector<u8>,
    ctx: &mut TxContext,
) {
    let sender = tx_context::sender(ctx);
    assert!(sender == cap.operator, E_UNAUTHORIZED_OPERATOR);
    assert!(!pause_cap.paused, E_EXECUTION_PAUSED);
    let amount = coin::value(&profit);
    assert!(amount >= min_profit, E_MIN_PROFIT_NOT_MET);
    event::emit(ProfitSwept<T> {
        amount,
        treasury: cap.treasury,
        operator: sender,
        route_hash,
    });
    transfer::public_transfer(profit, cap.treasury);
}
