module terminal_profit_guard::terminal_profit_guard;

use sui::coin::{Self, Coin};
use sui::event;
use sui::object::{Self, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};

const E_UNAUTHORIZED_OPERATOR: u64 = 1;
const E_MIN_PROFIT_NOT_MET: u64 = 2;
const E_ZERO_TREASURY: u64 = 3;

public struct AdminCap has key, store {
    id: UID,
}

public struct OperatorCap has key, store {
    id: UID,
    operator: address,
    treasury: address,
}

public struct ProfitSwept<phantom T> has copy, drop {
    amount: u64,
    treasury: address,
    operator: address,
    route_hash: vector<u8>,
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
