//! v1.1 tests: authentication of prepare_mint (route + counterpart) and the
//! semantic guard of the receiver.
use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{DepsMut, Env};

use crate::contract::{execute, instantiate};
use crate::error::ContractError;
use crate::msg::{ExecuteMsg, InstantiateMsg};

const OWNER: &str = "owner";
const HOOK: &str = "neutron1hook";
const BRIDGE: &str = "0x810B1CD48B50a8Ae6594C2ac46f6A5bFA9Ab5F6b";
const ID_A: &str = "0x3b9a01121e0b51b2a111a19d3d8de8a3454a88a846c92694b06fddc3e0d9a2a6";
const ID_B: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const H1: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn setup(deps: DepsMut, env: &Env, _counterpart: bool) {
    instantiate(deps, env.clone(), mock_info(OWNER, &[]), InstantiateMsg {
        channel: "channel-2".into(), token_name: "IND".into(), token_symbol: "IND".into(),
        decimals: 18, axelar_gateway: None, axelar_gmp_account: None,
        axelar_fee_recipient: None, min_bounty: None,
    }).unwrap();
}


fn prepare(token_id: &str, indicator_id: &str, chain: &str, addr: &str, timeout: u64) -> ExecuteMsg {
    ExecuteMsg::PrepareMint {
        hashlock: H1.into(), indicator_id: indicator_id.into(), token_id: token_id.into(),
        amount: "1".into(), cosmos_recipient: "neutron1user".into(), timeout: timeout.to_string(),
        source_chain: chain.into(), source_address: addr.into(),
    }
}

fn base() -> (cosmwasm_std::OwnedDeps<cosmwasm_std::MemoryStorage, cosmwasm_std::testing::MockApi, cosmwasm_std::testing::MockQuerier>, Env) {
    let mut deps = mock_dependencies();
    let env = mock_env();
    setup(deps.as_mut(), &env, true);
    execute(deps.as_mut(), env.clone(), mock_info(OWNER, &[]), ExecuteMsg::AddAuthorizedSender { sender: HOOK.into() }).unwrap();
    execute(deps.as_mut(), env.clone(), mock_info(OWNER, &[]), ExecuteMsg::CreateTokenClass {
        token_id: "1".into(), indicator_id: ID_A.into(), indicator_type: "CO2_REMOVAL".into(),
        unit: "kgCO2e".into(), methodology_id: "m".into(), profile_hash: "0x01".into(), data_hash: "0x02".into(),
    }).unwrap();
    (deps, env)
}

#[test]
fn prepare_fails_closed_without_counterpart() {
    let (mut deps, env) = base();
    let t = env.block.time.seconds() + 3600;
    let err = execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare("1", ID_A, "Polygon", BRIDGE, t)).unwrap_err();
    assert!(matches!(err, ContractError::CounterpartNotConfigured {}));
}

#[test]
fn set_counterpart_is_owner_only() {
    let (mut deps, env) = base();
    let err = execute(deps.as_mut(), env.clone(), mock_info("mallory", &[]), ExecuteMsg::SetCounterpart { chain: "Polygon".into(), address: BRIDGE.into() }).unwrap_err();
    assert!(matches!(err, ContractError::Unauthorized {}));
}

fn with_counterpart() -> (cosmwasm_std::OwnedDeps<cosmwasm_std::MemoryStorage, cosmwasm_std::testing::MockApi, cosmwasm_std::testing::MockQuerier>, Env) {
    let (mut deps, env) = base();
    execute(deps.as_mut(), env.clone(), mock_info(OWNER, &[]), ExecuteMsg::SetCounterpart { chain: "Polygon".into(), address: BRIDGE.into() }).unwrap();
    (deps, env)
}

#[test]
fn owner_cannot_prepare_directly() {
    let (mut deps, env) = with_counterpart();
    let t = env.block.time.seconds() + 3600;
    let err = execute(deps.as_mut(), env.clone(), mock_info(OWNER, &[]), prepare("1", ID_A, "Polygon", BRIDGE, t)).unwrap_err();
    assert!(matches!(err, ContractError::UnauthorizedSender { .. }));
}

#[test]
fn unexpected_source_is_rejected() {
    let (mut deps, env) = with_counterpart();
    let t = env.block.time.seconds() + 3600;
    let err = execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare("1", ID_A, "Polygon", "0x000000000000000000000000000000000000dEaD", t)).unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedSource { .. }));
    let err = execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare("1", ID_A, "Avalanche", BRIDGE, t)).unwrap_err();
    assert!(matches!(err, ContractError::UnexpectedSource { .. }));
}

#[test]
fn expected_source_is_accepted_case_insensitively() {
    let (mut deps, env) = with_counterpart();
    let t = env.block.time.seconds() + 3600;
    execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare("1", ID_A, "polygon", &BRIDGE.to_lowercase(), t)).unwrap();
}

#[test]
fn semantic_guard_rejects_mismatch_and_unregistered_class() {
    let (mut deps, env) = with_counterpart();
    let t = env.block.time.seconds() + 3600;
    let err = execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare("1", ID_B, "Polygon", BRIDGE, t)).unwrap_err();
    assert!(matches!(err, ContractError::IndicatorMismatch { .. }));
    let err = execute(deps.as_mut(), env.clone(), mock_info(HOOK, &[]), prepare("99", ID_A, "Polygon", BRIDGE, t)).unwrap_err();
    assert!(matches!(err, ContractError::TokenClassNotFound { .. }));
}
