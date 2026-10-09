//! Unit tests for the receiver's HTLC state machine and semantic guard, run
//! against the contract code of the evaluated deployment (no behaviour change).
//! They cover the destination side of the forward direction (Polygon -> Neutron):
//! prepare_mint (authorization, class existence, identity equality, uniqueness),
//! claim_mint (secret, timeout, single liquidation) and refund_mint.
use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info, MockApi, MockQuerier, MockStorage};
use cosmwasm_std::{from_json, Env, OwnedDeps, Timestamp, Uint128};
use sha3::{Digest, Keccak256};

use crate::contract::{execute, instantiate, query};
use crate::error::ContractError;
use crate::msg::{BalanceResponse, BridgeStatsResponse, ExecuteMsg, HTLCLockResponse, InstantiateMsg, QueryMsg};

type Deps = OwnedDeps<MockStorage, MockApi, MockQuerier>;

const OWNER: &str = "owner";
const HOOK: &str = "neutron1hook";
const USER: &str = "neutron1user";
const BRIDGE: &str = "0x810B1CD48B50a8Ae6594C2ac46f6A5bFA9Ab5F6b";
const ID_A: &str = "0x3b9a01121e0b51b2a111a19d3d8de8a3454a88a846c92694b06fddc3e0d9a2a6";
const ID_B: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const SECRET: &str = "0x0101010101010101010101010101010101010101010101010101010101010101";
const WRONG: &str = "0x0202020202020202020202020202020202020202020202020202020202020202";

fn hashlock_of(secret: &str) -> String {
    let bytes = hex::decode(secret.trim_start_matches("0x")).unwrap();
    format!("0x{}", hex::encode(Keccak256::digest(&bytes)))
}

fn setup() -> (Deps, Env) {
    let mut deps = mock_dependencies();
    let env = mock_env();
    instantiate(deps.as_mut(), env.clone(), mock_info(OWNER, &[]), InstantiateMsg {
        channel: "channel-2".into(), token_name: "IND".into(), token_symbol: "IND".into(),
        decimals: 18, axelar_gateway: None, axelar_gmp_account: None,
        axelar_fee_recipient: None, min_bounty: None,
    }).unwrap();
    execute(deps.as_mut(), env.clone(), mock_info(OWNER, &[]),
        ExecuteMsg::AddAuthorizedSender { sender: HOOK.into() }).unwrap();
    execute(deps.as_mut(), env.clone(), mock_info(OWNER, &[]), ExecuteMsg::CreateTokenClass {
        token_id: "1".into(), indicator_id: ID_A.into(), indicator_type: "CO2_REMOVAL".into(),
        unit: "kgCO2e".into(), methodology_id: "m".into(), profile_hash: "0x01".into(), data_hash: "0x02".into(),
    }).unwrap();
    (deps, env)
}

fn prepare(hashlock: &str, token_id: &str, indicator_id: &str, timeout: u64) -> ExecuteMsg {
    ExecuteMsg::PrepareMint {
        hashlock: hashlock.into(), indicator_id: indicator_id.into(), token_id: token_id.into(),
        amount: "10".into(), cosmos_recipient: USER.into(), timeout: timeout.to_string(),
        source_chain: "Polygon".into(), source_address: BRIDGE.into(),
    }
}

fn lock_state(deps: &Deps, env: &Env, hashlock: &str) -> Option<String> {
    let r: HTLCLockResponse = from_json(query(deps.as_ref(), env.clone(),
        QueryMsg::HTLCLock { hashlock: hashlock.into() }).unwrap()).unwrap();
    r.lock.map(|l| l.state)
}

fn balance(deps: &Deps, env: &Env) -> Uint128 {
    let r: BalanceResponse = from_json(query(deps.as_ref(), env.clone(),
        QueryMsg::Balance { address: USER.into(), token_id: "1".into() }).unwrap()).unwrap();
    r.balance
}

fn at(env: &Env, secs: u64) -> Env {
    let mut e = env.clone();
    e.block.time = Timestamp::from_seconds(secs);
    e
}

#[test]
fn semantic_guard_rejects_mismatched_identity_without_state() {
    let (mut deps, env) = setup();
    let h = hashlock_of(SECRET);
    let t = env.block.time.seconds() + 3600;
    let err = execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare(&h, "1", ID_B, t)).unwrap_err();
    assert!(matches!(err, ContractError::IndicatorMismatch { .. }));
    assert_eq!(lock_state(&deps, &env, &h), None);
}

#[test]
fn semantic_guard_rejects_unregistered_class_without_state() {
    let (mut deps, env) = setup();
    let h = hashlock_of(SECRET);
    let t = env.block.time.seconds() + 3600;
    let err = execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare(&h, "99", ID_A, t)).unwrap_err();
    assert!(matches!(err, ContractError::TokenClassNotFound { .. }));
    assert_eq!(lock_state(&deps, &env, &h), None);
}

#[test]
fn identity_comparison_ignores_hex_case() {
    let (mut deps, env) = setup();
    let h = hashlock_of(SECRET);
    let t = env.block.time.seconds() + 3600;
    execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare(&h, "1", &ID_A.to_uppercase().replace("0X", "0x"), t)).unwrap();
    assert_eq!(lock_state(&deps, &env, &h).as_deref(), Some("pending"));
}

#[test]
fn unauthorized_sender_cannot_prepare() {
    let (mut deps, env) = setup();
    let h = hashlock_of(SECRET);
    let t = env.block.time.seconds() + 3600;
    let err = execute(deps.as_mut(), env.clone(), mock_info("mallory", &[]), prepare(&h, "1", ID_A, t)).unwrap_err();
    assert!(matches!(err, ContractError::UnauthorizedSender { .. }));
}

#[test]
fn hashlock_cannot_be_reused() {
    let (mut deps, env) = setup();
    let h = hashlock_of(SECRET);
    let t = env.block.time.seconds() + 3600;
    execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare(&h, "1", ID_A, t)).unwrap();
    let err = execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare(&h, "1", ID_A, t)).unwrap_err();
    assert!(matches!(err, ContractError::HTLCAlreadyExists { .. }));
}

#[test]
fn claim_requires_the_preimage_and_mints_once() {
    let (mut deps, env) = setup();
    let h = hashlock_of(SECRET);
    let t = env.block.time.seconds() + 3600;
    execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare(&h, "1", ID_A, t)).unwrap();
    // wrong preimage and malformed secret are rejected without state change
    let err = execute(deps.as_mut(), env.clone(), mock_info(USER, &[]),
        ExecuteMsg::ClaimMint { hashlock: h.clone(), secret: WRONG.into() }).unwrap_err();
    assert!(matches!(err, ContractError::InvalidSecret {}));
    let err = execute(deps.as_mut(), env.clone(), mock_info(USER, &[]),
        ExecuteMsg::ClaimMint { hashlock: h.clone(), secret: "0x01".into() }).unwrap_err();
    assert!(matches!(err, ContractError::InvalidSecret {}));
    assert_eq!(balance(&deps, &env), Uint128::zero());
    // the correct preimage mints exactly once
    execute(deps.as_mut(), env.clone(), mock_info(USER, &[]),
        ExecuteMsg::ClaimMint { hashlock: h.clone(), secret: SECRET.into() }).unwrap();
    assert_eq!(balance(&deps, &env), Uint128::new(10));
    assert_eq!(lock_state(&deps, &env, &h).as_deref(), Some("claimed"));
    let err = execute(deps.as_mut(), env.clone(), mock_info(USER, &[]),
        ExecuteMsg::ClaimMint { hashlock: h.clone(), secret: SECRET.into() }).unwrap_err();
    assert!(matches!(err, ContractError::InvalidHTLCState { .. }));
    assert_eq!(balance(&deps, &env), Uint128::new(10));
    // a claimed transfer cannot be refunded afterwards
    let err = execute(deps.as_mut(), at(&env, t + 1), mock_info(USER, &[]),
        ExecuteMsg::RefundMint { hashlock: h.clone() }).unwrap_err();
    assert!(matches!(err, ContractError::InvalidHTLCState { .. }));
}

#[test]
fn claim_after_timeout_is_rejected() {
    let (mut deps, env) = setup();
    let h = hashlock_of(SECRET);
    let t = env.block.time.seconds() + 3600;
    execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare(&h, "1", ID_A, t)).unwrap();
    let err = execute(deps.as_mut(), at(&env, t), mock_info(USER, &[]),
        ExecuteMsg::ClaimMint { hashlock: h.clone(), secret: SECRET.into() }).unwrap_err();
    assert!(matches!(err, ContractError::TimeoutExpired { .. }));
    assert_eq!(balance(&deps, &env), Uint128::zero());
}

#[test]
fn refund_only_after_timeout_and_then_no_claim() {
    let (mut deps, env) = setup();
    let h = hashlock_of(SECRET);
    let t = env.block.time.seconds() + 3600;
    execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare(&h, "1", ID_A, t)).unwrap();
    let err = execute(deps.as_mut(), env.clone(), mock_info(USER, &[]),
        ExecuteMsg::RefundMint { hashlock: h.clone() }).unwrap_err();
    assert!(matches!(err, ContractError::TimeoutNotExpired { .. }));
    execute(deps.as_mut(), at(&env, t), mock_info(USER, &[]),
        ExecuteMsg::RefundMint { hashlock: h.clone() }).unwrap();
    assert_eq!(lock_state(&deps, &env, &h).as_deref(), Some("refunded"));
    let err = execute(deps.as_mut(), env.clone(), mock_info(USER, &[]),
        ExecuteMsg::ClaimMint { hashlock: h.clone(), secret: SECRET.into() }).unwrap_err();
    assert!(matches!(err, ContractError::InvalidHTLCState { .. }));
    let stats: BridgeStatsResponse = from_json(query(deps.as_ref(), env.clone(), QueryMsg::BridgeStats {}).unwrap()).unwrap();
    assert_eq!(stats.total_pending, Uint128::zero());
    assert_eq!(stats.total_claimed, Uint128::zero());
    assert_eq!(balance(&deps, &env), Uint128::zero());
}

#[test]
fn two_classes_in_flight_stay_separate() {
    let (mut deps, env) = setup();
    // second class with a different content-addressed identity
    execute(deps.as_mut(), env.clone(), mock_info(OWNER, &[]), ExecuteMsg::CreateTokenClass {
        token_id: "2".into(), indicator_id: ID_B.into(), indicator_type: "RENEWABLE_ENERGY".into(),
        unit: "kWh".into(), methodology_id: "m2".into(), profile_hash: "0x03".into(), data_hash: "0x04".into(),
    }).unwrap();
    let s2 = WRONG; // a valid 32-byte preimage, used here as the second transfer's secret
    let (h1, h2) = (hashlock_of(SECRET), hashlock_of(s2));
    let t = env.block.time.seconds() + 3600;
    // each class only accepts its own identity
    let err = execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare(&h2, "2", ID_A, t)).unwrap_err();
    assert!(matches!(err, ContractError::IndicatorMismatch { .. }));
    // both transfers pending at the same time
    execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare(&h1, "1", ID_A, t)).unwrap();
    execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare(&h2, "2", ID_B, t)).unwrap();
    // a secret only opens its own transfer
    let err = execute(deps.as_mut(), env.clone(), mock_info(USER, &[]),
        ExecuteMsg::ClaimMint { hashlock: h2.clone(), secret: SECRET.into() }).unwrap_err();
    assert!(matches!(err, ContractError::InvalidSecret {}));
    execute(deps.as_mut(), env.clone(), mock_info(USER, &[]),
        ExecuteMsg::ClaimMint { hashlock: h2.clone(), secret: s2.into() }).unwrap();
    execute(deps.as_mut(), env.clone(), mock_info(USER, &[]),
        ExecuteMsg::ClaimMint { hashlock: h1.clone(), secret: SECRET.into() }).unwrap();
    // balances are kept per class: no mixing
    let b = |tid: &str| -> Uint128 {
        let r: BalanceResponse = from_json(query(deps.as_ref(), env.clone(),
            QueryMsg::Balance { address: USER.into(), token_id: tid.into() }).unwrap()).unwrap();
        r.balance
    };
    assert_eq!(b("1"), Uint128::new(10));
    assert_eq!(b("2"), Uint128::new(10));
}
