#[cfg(not(feature = "library"))]
use cosmwasm_std::{
    to_json_binary, to_json_string, BankMsg, Binary, Coin, CosmosMsg, Deps, DepsMut, Env,
    MessageInfo, Response, StdResult, Uint128,
};
use sha3::{Keccak256, Digest};

use crate::error::ContractError;
use crate::msg::*;
use crate::state::*;

/// Initialize the contract
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    let config = Config {
        channel: msg.channel,
        token_name: msg.token_name.clone(),
        token_symbol: msg.token_symbol.clone(),
        decimals: msg.decimals,
        owner: info.sender.to_string(),
        axelar_gateway: msg.axelar_gateway,
        axelar_gmp_account: msg.axelar_gmp_account,
        axelar_fee_recipient: msg.axelar_fee_recipient,
        min_bounty: msg.min_bounty.unwrap_or(Uint128::new(50_000)),
    };

    CONFIG.save(deps.storage, &config)?;
    TOTAL_SUPPLY.save(deps.storage, &Uint128::zero())?;
    
    // Initialize authorized GMP senders list (empty until set by owner)
    AUTHORIZED_SENDERS.save(deps.storage, &Vec::<String>::new())?;
    
    BRIDGE_STATS.save(deps.storage, &BridgeStats {
        total_locks: 0,
        total_claimed: Uint128::zero(),
        total_refunded: Uint128::zero(),
        total_pending: Uint128::zero(),
    })?;
    
    STORED_MESSAGE.save(deps.storage, &StoredMessage {
        sender: "none".to_string(),
        message: "none".to_string(),
    })?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("token_name", msg.token_name)
        .add_attribute("token_symbol", msg.token_symbol))
}

/// Execute contract messages
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        // HTLC Operations
        ExecuteMsg::PrepareMint {
            hashlock,
            indicator_id,
            token_id,
            amount,
            cosmos_recipient,
            timeout,
            source_chain,
            source_address,
        } => execute_prepare_mint(
            deps, env, info, hashlock, indicator_id, token_id,
            amount, cosmos_recipient, timeout, source_chain, source_address
        ),
        
        ExecuteMsg::ClaimMint { hashlock, secret } => {
            execute_claim_mint(deps, env, info, hashlock, secret)
        },
        
        ExecuteMsg::RefundMint { hashlock } => {
            execute_refund_mint(deps, env, info, hashlock)
        },

        // Reverse direction (this chain as HTLC source)
        ExecuteMsg::LockForBurn {
            token_id,
            amount,
            hashlock,
            timelock,
            evm_recipient,
            destination_chain,
            destination_address,
            bounty,
        } => execute_lock_for_burn(
            deps, env, info, token_id, amount, hashlock, timelock,
            evm_recipient, destination_chain, destination_address, bounty,
        ),

        ExecuteMsg::ClaimBurn { hashlock, secret } => {
            execute_claim_burn(deps, env, info, hashlock, secret)
        },

        ExecuteMsg::RefundBurn { hashlock } => {
            execute_refund_burn(deps, env, info, hashlock)
        },


        // Token Class Management
        ExecuteMsg::CreateTokenClass {
            token_id,
            indicator_id,
            indicator_type,
            unit,
            methodology_id,
            profile_hash,
            data_hash,
        } => execute_create_token_class(
            deps, env, info, token_id, indicator_id, indicator_type,
            unit, methodology_id, profile_hash, data_hash
        ),
        
        // Token Operations
        ExecuteMsg::Transfer { recipient, token_id, amount } => {
            execute_transfer(deps, info, recipient, token_id, amount)
        },
        
        // Admin: Add authorized GMP sender
        ExecuteMsg::SetCounterpart { chain, address } => {
            execute_set_counterpart(deps, info, chain, address)
        },

        ExecuteMsg::AddAuthorizedSender { sender } => {
            execute_add_authorized_sender(deps, info, sender)
        },
        
        // Admin: Remove authorized GMP sender
        ExecuteMsg::RemoveAuthorizedSender { sender } => {
            execute_remove_authorized_sender(deps, info, sender)
        },

        // Admin: recover orphaned refunds held by the contract
        ExecuteMsg::WithdrawFunds { denom, amount, to } => {
            let config = CONFIG.load(deps.storage)?;
            if info.sender.to_string() != config.owner {
                return Err(ContractError::Unauthorized {});
            }
            let recipient = to.unwrap_or(config.owner);
            Ok(Response::new()
                .add_message(CosmosMsg::Bank(BankMsg::Send {
                    to_address: recipient.clone(),
                    amount: vec![Coin { denom: denom.clone(), amount }],
                }))
                .add_attribute("action", "withdraw_funds")
                .add_attribute("denom", denom)
                .add_attribute("amount", amount.to_string())
                .add_attribute("to", recipient))
        },
        
        // Testing (owner-only)
        ExecuteMsg::ReceiveTest { message } => {
            let config = CONFIG.load(deps.storage)?;
            if info.sender.to_string() != config.owner {
                return Err(ContractError::Unauthorized {});
            }
            STORED_MESSAGE.save(deps.storage, &StoredMessage {
                sender: info.sender.to_string(),
                message: message.clone(),
            })?;
            Ok(Response::new()
                .add_attribute("action", "receive_test")
                .add_attribute("message", message))
        }
    }
}

/// Add an authorized GMP sender (owner-only)
fn execute_add_authorized_sender(
    deps: DepsMut,
    info: MessageInfo,
    sender: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender.to_string() != config.owner {
        return Err(ContractError::Unauthorized {});
    }
    
    let mut senders = AUTHORIZED_SENDERS.load(deps.storage)?;
    if !senders.contains(&sender) {
        senders.push(sender.clone());
        AUTHORIZED_SENDERS.save(deps.storage, &senders)?;
    }
    
    Ok(Response::new()
        .add_attribute("action", "add_authorized_sender")
        .add_attribute("sender", sender))
}

/// Remove an authorized GMP sender (owner-only)
fn execute_remove_authorized_sender(
    deps: DepsMut,
    info: MessageInfo,
    sender: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender.to_string() != config.owner {
        return Err(ContractError::Unauthorized {});
    }
    
    let mut senders = AUTHORIZED_SENDERS.load(deps.storage)?;
    senders.retain(|s| s != &sender);
    AUTHORIZED_SENDERS.save(deps.storage, &senders)?;
    
    Ok(Response::new()
        .add_attribute("action", "remove_authorized_sender")
        .add_attribute("sender", sender))
}

/// Prepare mint - creates HTLC lock (Phase 1)
/// Called via GMP when EVM locks tokens with a hashlock
/// SECURITY: Only authorized senders (Axelar IBC relay) can call this
fn execute_prepare_mint(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    hashlock: String,
    indicator_id: String,
    token_id: String,
    amount: String,
    cosmos_recipient: String,
    timeout: String,
    source_chain: String,
    source_address: String,
) -> Result<Response, ContractError> {
    // FIX #1: Verify the message arrives through the Axelar route.
    // v1.1: the owner can no longer submit prepare_mint directly.
    let config = CONFIG.load(deps.storage)?;
    let authorized_senders = AUTHORIZED_SENDERS.load(deps.storage)?;
    let sender = info.sender.to_string();

    let is_authorized = config.axelar_gateway.as_ref().map_or(false, |gw| *gw == sender)
        || authorized_senders.contains(&sender);

    if !is_authorized {
        return Err(ContractError::UnauthorizedSender { sender });
    }

    // v1.1: the route is shared by all GMP traffic on the channel, so the
    // emitting contract must be checked too. source_chain/source_address are
    // the arguments Axelar validates for version-1 (ABI) payloads; they must
    // match the configured BridgeHTLC counterpart.
    let counterpart = COUNTERPART
        .may_load(deps.storage)?
        .ok_or(ContractError::CounterpartNotConfigured {})?;
    if !counterpart.chain.eq_ignore_ascii_case(&source_chain)
        || !counterpart.address.eq_ignore_ascii_case(&source_address)
    {
        return Err(ContractError::UnexpectedSource { chain: source_chain, address: source_address });
    }
    
    // Parse amount
    let amount: Uint128 = amount.parse()
        .map_err(|_| ContractError::InvalidPayload {})?;
    
    if amount.is_zero() {
        return Err(ContractError::InvalidAmount {});
    }
    
    // Parse timeout
    let timeout: u64 = timeout.parse()
        .map_err(|_| ContractError::InvalidPayload {})?;
    
    // Validate hashlock format (should be 0x + 64 hex chars)
    if !hashlock.starts_with("0x") || hashlock.len() != 66 {
        return Err(ContractError::InvalidHashlock {});
    }
    
    // FIX #2 (partial): Validate hashlock contains only hex characters
    if !hashlock[2..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ContractError::InvalidHashlock {});
    }
    
    // Check if HTLC already exists
    if HTLC_LOCKS.may_load(deps.storage, &hashlock)?.is_some() {
        return Err(ContractError::HTLCAlreadyExists { hashlock: hashlock.clone() });
    }
    
    // Check timeout is in future
    if timeout <= env.block.time.seconds() {
        return Err(ContractError::TimeoutExpired { hashlock: hashlock.clone() });
    }
    
    // Semantic validation: the class must be registered AND its
    // content-addressed identity must match the message's indicator_id.
    // Existence alone is insufficient — without the equality check, a
    // message could mint into a class with different semantics (F4).
    let class = TOKEN_CLASSES.may_load(deps.storage, &token_id)?
        .ok_or(ContractError::TokenClassNotFound { token_id: token_id.clone() })?;
    if class.indicator_id.to_lowercase() != indicator_id.to_lowercase() {
        return Err(ContractError::IndicatorMismatch {
            token_id,
            registered: class.indicator_id,
            message: indicator_id,
        });
    }
    
    // Validate cosmos_recipient is non-empty and reasonable
    if cosmos_recipient.is_empty() || cosmos_recipient.len() > 128 {
        return Err(ContractError::InvalidAddress { address: cosmos_recipient });
    }
    
    // Create HTLC lock (tokens NOT minted yet)
    let htlc = HTLCLock {
        hashlock: hashlock.clone(),
        indicator_id: indicator_id.clone(),
        token_id: token_id.clone(),
        amount,
        cosmos_recipient: cosmos_recipient.clone(),
        source_chain: source_chain.clone(),
        source_address: source_address.clone(),
        timeout,
        created_at: env.block.time.seconds(),
        state: HTLCState::Pending,
        secret: None,
    };
    
    HTLC_LOCKS.save(deps.storage, &hashlock, &htlc)?;
    
    // Add to user's locks
    let mut user_locks = USER_HTLC_LOCKS
        .may_load(deps.storage, &cosmos_recipient)?
        .unwrap_or_default();
    user_locks.push(hashlock.clone());
    USER_HTLC_LOCKS.save(deps.storage, &cosmos_recipient, &user_locks)?;
    
    // Update stats
    let mut stats = BRIDGE_STATS.load(deps.storage)?;
    stats.total_locks += 1;
    stats.total_pending += amount;
    BRIDGE_STATS.save(deps.storage, &stats)?;
    
    // Save debug message
    STORED_MESSAGE.save(deps.storage, &StoredMessage {
        sender: info.sender.to_string(),
        message: format!("prepare_mint: hashlock={}, amount={}, recipient={}", 
            hashlock, amount, cosmos_recipient),
    })?;
    
    Ok(Response::new()
        .add_attribute("action", "prepare_mint")
        .add_attribute("hashlock", hashlock)
        .add_attribute("indicator_id", indicator_id)
        .add_attribute("token_id", token_id)
        .add_attribute("amount", amount.to_string())
        .add_attribute("cosmos_recipient", cosmos_recipient)
        .add_attribute("timeout", timeout.to_string())
        .add_attribute("state", "pending")
        .add_attribute("mint_status", "NOT_MINTED_AWAITING_SECRET"))
}

/// Claim mint by revealing the secret (Phase 2 - Success)
/// User reveals secret S where keccak256(S) == hashlock
fn execute_claim_mint(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    hashlock: String,
    secret: String,
) -> Result<Response, ContractError> {
    // Load HTLC lock
    let mut htlc = HTLC_LOCKS.load(deps.storage, &hashlock)
        .map_err(|_| ContractError::HTLCNotFound { hashlock: hashlock.clone() })?;
    
    // Check state is pending
    if !matches!(htlc.state, HTLCState::Pending) {
        return Err(ContractError::InvalidHTLCState {
            hashlock: hashlock.clone(),
            expected: "pending".to_string(),
            actual: format!("{:?}", htlc.state),
        });
    }
    
    // Check not timed out
    if env.block.time.seconds() >= htlc.timeout {
        return Err(ContractError::TimeoutExpired { hashlock: hashlock.clone() });
    }
    
    // FIX #2: Verify secret format before hashing (must be valid hex, 32 bytes)
    if !verify_secret_format(&secret) {
        return Err(ContractError::InvalidSecret {});
    }
    
    // Verify secret: keccak256(secret) == hashlock
    if !verify_hashlock(&secret, &hashlock) {
        return Err(ContractError::InvalidSecret {});
    }
    
    // FIX #5: Validate token class exists before minting
    let token_id = htlc.token_id.clone();
    if TOKEN_CLASSES.may_load(deps.storage, &token_id)?.is_none() {
        return Err(ContractError::TokenClassNotFound { token_id });
    }
    
    // Update HTLC state
    htlc.state = HTLCState::Claimed;
    htlc.secret = Some(secret.clone());
    HTLC_LOCKS.save(deps.storage, &hashlock, &htlc)?;
    
    // NOW mint the tokens (only after secret is verified)
    let amount = htlc.amount;
    let recipient = htlc.cosmos_recipient.clone();
    
    // Update balance
    let current_balance = BALANCES
        .may_load(deps.storage, (&recipient, &token_id))?
        .unwrap_or(Uint128::zero());
    BALANCES.save(deps.storage, (&recipient, &token_id), &(current_balance + amount))?;
    
    // Update token supply
    let token_supply = TOKEN_SUPPLY
        .may_load(deps.storage, &token_id)?
        .unwrap_or(Uint128::zero());
    TOKEN_SUPPLY.save(deps.storage, &token_id, &(token_supply + amount))?;
    
    // Update total supply
    let total_supply = TOTAL_SUPPLY.load(deps.storage)?;
    TOTAL_SUPPLY.save(deps.storage, &(total_supply + amount))?;
    
    // Update stats
    let mut stats = BRIDGE_STATS.load(deps.storage)?;
    stats.total_claimed += amount;
    stats.total_pending -= amount;
    BRIDGE_STATS.save(deps.storage, &stats)?;
    
    // ===== AUTOMATIC GMP CALLBACK: Trigger claimBurn on EVM =====
    // This closes the HTLC timeout race condition by ensuring that
    // whenever tokens are minted on Cosmos, a burn is automatically
    // triggered on EVM via Axelar GMP.
    //
    // The callback payload is ABI-encoded (hashlock, secret) and sent
    // via Axelar's IBC channel using a Stargate MsgTransfer with memo.
    let config = CONFIG.load(deps.storage)?;
    
    let mut response = Response::new()
        .add_attribute("action", "claim_mint")
        .add_attribute("hashlock", hashlock.clone())
        .add_attribute("secret", secret.clone())
        .add_attribute("token_id", token_id)
        .add_attribute("amount", amount.to_string())
        .add_attribute("recipient", recipient)
        .add_attribute("claimer", info.sender.to_string())
        .add_attribute("state", "claimed")
        .add_attribute("mint_status", "MINTED");
    
    // Build GMP callback payload: ABI-encoded (bytes32 hashlock, bytes32 secret)
    match build_gmp_callback_payload(&hashlock, &secret) {
        Ok(payload) => {
            let payload_hex = format!("0x{}", hex::encode(&payload));

            // Attach the callback as an ON-CHAIN IBC transfer to the Axelar
            // GMP account, carrying the GMP memo. TWO coins are required:
            //   - untrn covering Neutron's mandatory feerefunder ack+timeout
            //     fees (>= IBC_MIN_FUNDS);
            //   - an Axelar-REGISTERED asset (e.g., AXL as ibc/C0E6...) that
            //     is transferred as the relayer fee. NTRN itself is NOT an
            //     Axelar asset: transfers denominated in untrn are rejected
            //     by axelarnet (error ack + refund; observed on mainnet).
            // Falls back to attribute-only emission when funds/config are
            // missing (off-chain relayer required).
            let untrn_fees = info.funds.iter()
                .find(|c| c.denom == "untrn")
                .map(|c| c.amount.u128())
                .unwrap_or(0);
            let relay_coin = info.funds.iter()
                .find(|c| c.denom != "untrn" && !c.amount.is_zero())
                .cloned();
            let relay_amount = relay_coin.as_ref().map(|c| c.amount.u128()).unwrap_or(0);

            // Memo schema per the Axelar reference implementation
            // (evm-cosmos-gmp-sample): payload as a JSON byte array; fee with
            // the Axelar relayer fee recipient when configured.
            let gmp_memo = to_json_string(&GmpMessage {
                destination_chain: htlc.source_chain.clone(),
                destination_address: htlc.source_address.clone(),
                payload,
                type_: 1,
                fee: match (&config.axelar_fee_recipient, relay_amount) {
                    (Some(recipient), amount) if amount > 0 => Some(GmpFee {
                        amount: amount.to_string(),
                        recipient: recipient.clone(),
                    }),
                    _ => None,
                },
            })?;

            match (config.axelar_gmp_account.as_ref(), relay_coin) {
                (Some(gmp_account), Some(relay)) if untrn_fees >= IBC_MIN_FUNDS => {
                    let ibc_msg = build_ibc_transfer_stargate(
                        &config.channel,
                        env.contract.address.as_str(),
                        gmp_account,
                        &relay.denom,
                        relay.amount.u128(),
                        "untrn",
                        &gmp_memo,
                        env.block.time.seconds() + 3600,
                    );
                    response = response
                        .add_message(ibc_msg)
                        .add_attribute("callback_status", "SENT_ONCHAIN")
                        .add_attribute("callback_relay_denom", relay.denom)
                        .add_attribute("callback_relay_amount", relay.amount.to_string());
                },
                (Some(_), Some(_)) => {
                    response = response
                        .add_attribute("callback_status", "READY")
                        .add_attribute("callback_note", "untrn below ack+timeout fee minimum");
                },
                (Some(_), None) if untrn_fees > 0 => {
                    response = response
                        .add_attribute("callback_status", "READY")
                        .add_attribute("callback_note", "no Axelar-registered relay token attached (attach AXL)");
                },
                _ => {
                    response = response
                        .add_attribute("callback_status", "READY");
                }
            }

            response = response
                .add_attribute("callback_destination_chain", &htlc.source_chain)
                .add_attribute("callback_destination_address", &htlc.source_address)
                .add_attribute("callback_payload", &payload_hex)
                .add_attribute("callback_gmp_memo", &gmp_memo);
        },
        Err(_) => {
            response = response
                .add_attribute("callback_status", "PAYLOAD_ERROR");
        }
    }

    Ok(response)
}

/// Build a Stargate MsgTransfer for IBC with memo field
/// This is compatible with all CosmWasm versions and supports the memo field
/// needed for Axelar GMP routing
/// Default ack/timeout fees for Neutron's feerefunder module (in the fee
/// denom, normally untrn). Both must be non-zero or the chain rejects the
/// transfer ("provided ack fee or timeout fee is zero"). The timeout fee is
/// refunded to the contract on successful acknowledgement.
const IBC_ACK_FEE: u128 = 200_000;      // 0.2 NTRN
const IBC_TIMEOUT_FEE: u128 = 200_000;  // 0.2 NTRN
/// Minimum attached funds usable for an on-chain outbound message:
/// ack + timeout fees must be covered, with a nonzero remainder transferred
/// to the Axelar GMP account as the relay/execution fee.
const IBC_MIN_FUNDS: u128 = IBC_ACK_FEE + IBC_TIMEOUT_FEE;

fn build_ibc_transfer_stargate(
    channel_id: &str,
    sender: &str,
    receiver: &str,
    denom: &str,       // relay token (must be an Axelar-registered asset, e.g. AXL)
    amount: u128,
    fee_denom: &str,   // feerefunder fee denom (untrn on Neutron)
    memo: &str,
    timeout_timestamp: u64,
) -> CosmosMsg {
    // Neutron wraps ibc-go's MsgTransfer: contracts MUST use
    // /neutron.transfer.MsgTransfer, which adds a mandatory feerefunder Fee.
    // Fields (proto/neutron/transfer/v1/tx.proto):
    //   source_port(1), source_channel(2), token(3), sender(4), receiver(5),
    //   timeout_height(6), timeout_timestamp(7), memo(8), fee(9)
    // Fee (proto/neutron/feerefunder/fee.proto):
    //   recv_fee(1, must be empty), ack_fee(2), timeout_fee(3)
    let mut buf = Vec::new();

    // Field 1: source_port = "transfer"
    proto_encode_string(&mut buf, 1, "transfer");
    // Field 2: source_channel
    proto_encode_string(&mut buf, 2, channel_id);
    // Field 3: token (nested Coin message)
    let mut coin_buf = Vec::new();
    proto_encode_string(&mut coin_buf, 1, denom);
    proto_encode_string(&mut coin_buf, 2, &amount.to_string());
    proto_encode_bytes(&mut buf, 3, &coin_buf);
    // Field 4: sender
    proto_encode_string(&mut buf, 4, sender);
    // Field 5: receiver (Axelar GMP account; routing happens via memo)
    proto_encode_string(&mut buf, 5, receiver);
    // Field 7: timeout_timestamp (nanoseconds)
    proto_encode_uint64(&mut buf, 7, timeout_timestamp * 1_000_000_000);
    // Field 8: memo (Axelar GMP routing info)
    proto_encode_string(&mut buf, 8, memo);
    // Field 9: fee (neutron.feerefunder.Fee)
    let encode_coin = |denom: &str, amount: u128| -> Vec<u8> {
        let mut c = Vec::new();
        proto_encode_string(&mut c, 1, denom);
        proto_encode_string(&mut c, 2, &amount.to_string());
        c
    };
    let mut fee_buf = Vec::new();
    // recv_fee (field 1) intentionally omitted: must be zero on Neutron
    proto_encode_bytes(&mut fee_buf, 2, &encode_coin(fee_denom, IBC_ACK_FEE));
    proto_encode_bytes(&mut fee_buf, 3, &encode_coin(fee_denom, IBC_TIMEOUT_FEE));
    proto_encode_bytes(&mut buf, 9, &fee_buf);

    CosmosMsg::Stargate {
        type_url: "/neutron.transfer.MsgTransfer".to_string(),
        value: cosmwasm_std::Binary::from(buf),
    }
}

// Simple protobuf encoding helpers
fn proto_encode_string(buf: &mut Vec<u8>, field: u32, value: &str) {
    proto_encode_bytes(buf, field, value.as_bytes());
}

fn proto_encode_bytes(buf: &mut Vec<u8>, field: u32, value: &[u8]) {
    // Tag: (field << 3) | 2 (length-delimited)
    proto_encode_varint(buf, ((field << 3) | 2) as u64);
    proto_encode_varint(buf, value.len() as u64);
    buf.extend_from_slice(value);
}

fn proto_encode_uint64(buf: &mut Vec<u8>, field: u32, value: u64) {
    // Tag: (field << 3) | 0 (varint)
    proto_encode_varint(buf, (field << 3) as u64);
    proto_encode_varint(buf, value);
}

fn proto_encode_varint(buf: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7F) as u8;
        value >>= 7;
        if value == 0 {
            buf.push(byte);
            break;
        } else {
            buf.push(byte | 0x80);
        }
    }
}

/// Build the ABI-encoded GMP callback payload for EVM claimBurn
/// Returns raw payload bytes: bytes32(hashlock) || bytes32(secret)
fn build_gmp_callback_payload(hashlock: &str, secret: &str) -> Result<Vec<u8>, ContractError> {
    // Decode hashlock (remove 0x prefix)
    let hashlock_hex = if hashlock.starts_with("0x") { &hashlock[2..] } else { hashlock };
    let hashlock_bytes = hex::decode(hashlock_hex)
        .map_err(|_| ContractError::InvalidHashlock {})?;
    
    if hashlock_bytes.len() != 32 {
        return Err(ContractError::InvalidHashlock {});
    }
    
    // Decode secret (remove 0x prefix)
    let secret_hex = if secret.starts_with("0x") { &secret[2..] } else { secret };
    let secret_bytes = hex::decode(secret_hex)
        .map_err(|_| ContractError::InvalidSecret {})?;
    
    if secret_bytes.len() != 32 {
        return Err(ContractError::InvalidSecret {});
    }
    
    // ABI-encode: bytes32(hashlock) || bytes32(secret) = 64 bytes
    let mut payload = Vec::with_capacity(64);
    payload.extend_from_slice(&hashlock_bytes);
    payload.extend_from_slice(&secret_bytes);

    Ok(payload)
}

// ============================================================================
// Reverse direction: this chain as HTLC source (Neutron -> EVM)
// ============================================================================

/// Minimum and maximum timelock durations (mirror of the EVM constants)
const MIN_TIMELOCK_SECS: u64 = 3600;        // 1 hour
const MAX_TIMELOCK_SECS: u64 = 7 * 86400;   // 7 days
/// Buffer between the EVM claim deadline (T_c) and this chain's refund
/// deadline (T_e); mirrors COSMOS_TIMEOUT_BUFFER on the EVM side
const EVM_TIMEOUT_BUFFER_SECS: u64 = 1800;  // 30 minutes

/// Lock tokens for a Neutron -> EVM transfer (reverse direction).
/// Escrows tokens and bounty, emits the ABI-encoded prepare message to the
/// EVM bridge via an IBC transfer to the Axelar GMP account.
#[allow(clippy::too_many_arguments)]
fn execute_lock_for_burn(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    token_id: String,
    amount: Uint128,
    hashlock: String,
    timelock: u64,
    evm_recipient: String,
    destination_chain: String,
    destination_address: String,
    bounty: Option<Coin>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let sender = info.sender.to_string();
    let now = env.block.time.seconds();

    // --- Checks ---
    if amount.is_zero() {
        return Err(ContractError::InvalidAmount {});
    }
    if !hashlock.starts_with("0x") || hashlock.len() != 66
        || !hashlock[2..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ContractError::InvalidHashlock {});
    }
    if timelock < now + MIN_TIMELOCK_SECS || timelock > now + MAX_TIMELOCK_SECS {
        return Err(ContractError::TimeoutExpired { hashlock: hashlock.clone() });
    }
    // Hashlock freshness across BOTH directions
    if OUTBOUND_LOCKS.may_load(deps.storage, &hashlock)?.is_some()
        || HTLC_LOCKS.may_load(deps.storage, &hashlock)?.is_some() {
        return Err(ContractError::OutboundLockAlreadyExists { hashlock });
    }
    // EVM recipient: 0x + 40 hex chars
    if !evm_recipient.starts_with("0x") || evm_recipient.len() != 42
        || !evm_recipient[2..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ContractError::InvalidEvmAddress { address: evm_recipient });
    }
    if destination_chain.is_empty() || destination_address.is_empty() {
        return Err(ContractError::InvalidPayload {});
    }
    // Semantic binding: read indicator_id from the registry, never from input
    let class = TOKEN_CLASSES.may_load(deps.storage, &token_id)?
        .ok_or(ContractError::TokenClassNotFound { token_id: token_id.clone() })?;

    // Bounty accounting: a bounty of at least the protocol minimum is
    // REQUIRED (see Config::min_bounty), denominated in untrn, and must be
    // covered by the attached funds.
    let bounty_coin = bounty.ok_or(ContractError::BountyBelowMinimum {
        minimum: config.min_bounty.to_string(),
        provided: "none".to_string(),
    })?;
    if bounty_coin.denom != "untrn" || bounty_coin.amount < config.min_bounty {
        return Err(ContractError::BountyBelowMinimum {
            minimum: format!("{}untrn", config.min_bounty),
            provided: format!("{}{}", bounty_coin.amount, bounty_coin.denom),
        });
    }
    let attached = info.funds.iter().find(|c| c.denom == bounty_coin.denom);
    let bounty_coins: Vec<Coin> = match attached {
        Some(c) if c.amount >= bounty_coin.amount => vec![bounty_coin.clone()],
        _ => return Err(ContractError::InvalidBounty {}),
    };

    // Funds after bounty reservation. TWO coins are required for the
    // on-chain prepare message: untrn covering Neutron's mandatory
    // feerefunder ack+timeout fees, and an Axelar-REGISTERED asset (e.g.,
    // AXL) transferred as the relayer fee (NTRN is not an Axelar asset;
    // untrn-denominated transfers are rejected by axelarnet).
    let available: Vec<Coin> = info.funds.iter()
        .map(|c| {
            let reserved = bounty_coins.iter()
                .find(|b| b.denom == c.denom)
                .map(|b| b.amount)
                .unwrap_or(Uint128::zero());
            Coin { denom: c.denom.clone(), amount: c.amount - reserved }
        })
        .collect();

    let gmp_account = config.axelar_gmp_account.clone()
        .ok_or(ContractError::GmpAccountNotConfigured {})?;
    let untrn_fees = available.iter()
        .find(|c| c.denom == "untrn")
        .map(|c| c.amount.u128())
        .unwrap_or(0);
    if untrn_fees < IBC_MIN_FUNDS {
        return Err(ContractError::InsufficientRelayFunds {
            minimum: IBC_MIN_FUNDS.to_string(),
            provided: untrn_fees.to_string(),
        });
    }
    let relay = available.iter()
        .find(|c| c.denom != "untrn" && !c.amount.is_zero())
        .cloned()
        .ok_or(ContractError::MissingRelayToken {})?;

    // --- Effects ---
    // Escrow: deduct the sender's balance; supply is reduced only at burn
    let sender_balance = BALANCES
        .may_load(deps.storage, (&sender, &token_id))?
        .unwrap_or(Uint128::zero());
    if sender_balance < amount {
        return Err(ContractError::InsufficientBalance {
            required: amount.to_string(),
            available: sender_balance.to_string(),
        });
    }
    BALANCES.save(deps.storage, (&sender, &token_id), &(sender_balance - amount))?;

    let lock = OutboundLock {
        hashlock: hashlock.clone(),
        sender: sender.clone(),
        token_id: token_id.clone(),
        indicator_id: class.indicator_id.clone(),
        amount,
        evm_recipient: evm_recipient.clone(),
        destination_chain: destination_chain.clone(),
        destination_address: destination_address.clone(),
        timelock,
        bounty: bounty_coins,
        created_at: now,
        state: OutboundState::Locked,
        secret: None,
    };
    OUTBOUND_LOCKS.save(deps.storage, &hashlock, &lock)?;

    let mut stats = BRIDGE_STATS.load(deps.storage)?;
    stats.total_locks += 1;
    BRIDGE_STATS.save(deps.storage, &stats)?;

    // --- Interactions: emit the ABI-encoded prepare message to the EVM bridge ---
    // The entire relay coin is transferred as the Axelar relayer fee
    let relay_amount = relay.amount.u128();
    // EVM claim deadline T_c = T_e - buffer (only T_c crosses the wire)
    let evm_timeout = timelock - EVM_TIMEOUT_BUFFER_SECS;
    let payload = abi_encode_prepare_mint(
        &hashlock, &class.indicator_id, &token_id, amount, &evm_recipient, evm_timeout,
    )?;

    // Memo schema per the Axelar reference implementation
    // (evm-cosmos-gmp-sample): payload as a JSON byte array; the fee field
    // (relayer fee + recipient) is REQUIRED for automatic execution on the
    // EVM destination.
    let gmp_memo = to_json_string(&GmpMessage {
        destination_chain: destination_chain.clone(),
        destination_address: destination_address.clone(),
        payload,
        type_: 1,
        fee: config.axelar_fee_recipient.as_ref().map(|recipient| GmpFee {
            amount: relay_amount.to_string(),
            recipient: recipient.clone(),
        }),
    })?;

    let ibc_msg = build_ibc_transfer_stargate(
        &config.channel,
        env.contract.address.as_str(),
        &gmp_account,
        &relay.denom,
        relay_amount,
        "untrn",
        &gmp_memo,
        now + 3600,
    );

    Ok(Response::new()
        .add_message(ibc_msg)
        .add_attribute("action", "lock_for_burn")
        .add_attribute("hashlock", hashlock)
        .add_attribute("token_id", token_id)
        .add_attribute("indicator_id", class.indicator_id)
        .add_attribute("amount", amount.to_string())
        .add_attribute("evm_recipient", evm_recipient)
        .add_attribute("timelock", timelock.to_string())
        .add_attribute("evm_timeout", evm_timeout.to_string())
        .add_attribute("state", "locked"))
}

/// Burn escrowed tokens after a confirmed destination claim (reverse direction).
/// Invoked by the relayed EVM callback (automatic path) or manually by any
/// party with the secret (fallback path, receives the bounty).
fn execute_claim_burn(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    hashlock: String,
    secret: String,
) -> Result<Response, ContractError> {
    let mut lock = OUTBOUND_LOCKS.load(deps.storage, &hashlock)
        .map_err(|_| ContractError::OutboundLockNotFound { hashlock: hashlock.clone() })?;

    if !matches!(lock.state, OutboundState::Locked) {
        return Err(ContractError::InvalidOutboundState {
            hashlock: hashlock.clone(),
            expected: "locked".to_string(),
            actual: format!("{:?}", lock.state),
        });
    }

    if !verify_secret_format(&secret) || !verify_hashlock(&secret, &hashlock) {
        return Err(ContractError::InvalidSecret {});
    }

    // --- Effects: burn the escrow (reduce supply; balance was deducted at lock) ---
    lock.state = OutboundState::Claimed;
    lock.secret = Some(secret.clone());
    let bounty = std::mem::take(&mut lock.bounty);
    OUTBOUND_LOCKS.save(deps.storage, &hashlock, &lock)?;

    let token_supply = TOKEN_SUPPLY
        .may_load(deps.storage, &lock.token_id)?
        .unwrap_or(Uint128::zero());
    TOKEN_SUPPLY.save(deps.storage, &lock.token_id, &(token_supply.checked_sub(lock.amount).unwrap_or_default()))?;
    let total_supply = TOTAL_SUPPLY.load(deps.storage)?;
    TOTAL_SUPPLY.save(deps.storage, &(total_supply.checked_sub(lock.amount).unwrap_or_default()))?;

    let mut stats = BRIDGE_STATS.load(deps.storage)?;
    stats.total_claimed += lock.amount;
    BRIDGE_STATS.save(deps.storage, &stats)?;

    // Bounty routing (mirror of the EVM logic): the automatic relayed path
    // returns the bounty to the original sender; a manual fallback caller
    // keeps it. Relayed messages arrive from the configured gateway or an
    // authorized sender.
    let config = CONFIG.load(deps.storage)?;
    let authorized = AUTHORIZED_SENDERS.load(deps.storage)?;
    let caller = info.sender.to_string();
    let is_relayed = caller == config.owner
        || config.axelar_gateway.as_ref().map_or(false, |gw| *gw == caller)
        || authorized.contains(&caller);
    let bounty_recipient = if is_relayed { lock.sender.clone() } else { caller.clone() };

    let mut response = Response::new()
        .add_attribute("action", "claim_burn")
        .add_attribute("hashlock", hashlock)
        .add_attribute("secret", secret)
        .add_attribute("token_id", lock.token_id)
        .add_attribute("amount", lock.amount.to_string())
        .add_attribute("caller", caller)
        .add_attribute("bounty_recipient", bounty_recipient.clone())
        .add_attribute("state", "claimed");

    if !bounty.is_empty() {
        response = response.add_message(CosmosMsg::Bank(BankMsg::Send {
            to_address: bounty_recipient,
            amount: bounty,
        }));
    }

    Ok(response)
}

/// Refund escrowed tokens (and bounty) after timeout (reverse direction).
fn execute_refund_burn(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    hashlock: String,
) -> Result<Response, ContractError> {
    let mut lock = OUTBOUND_LOCKS.load(deps.storage, &hashlock)
        .map_err(|_| ContractError::OutboundLockNotFound { hashlock: hashlock.clone() })?;

    if !matches!(lock.state, OutboundState::Locked) {
        return Err(ContractError::InvalidOutboundState {
            hashlock: hashlock.clone(),
            expected: "locked".to_string(),
            actual: format!("{:?}", lock.state),
        });
    }
    if env.block.time.seconds() < lock.timelock {
        return Err(ContractError::TimeoutNotExpired { hashlock: hashlock.clone() });
    }
    if info.sender.to_string() != lock.sender {
        return Err(ContractError::Unauthorized {});
    }

    // --- Effects: restore the sender's balance and return the bounty ---
    lock.state = OutboundState::Refunded;
    let bounty = std::mem::take(&mut lock.bounty);
    OUTBOUND_LOCKS.save(deps.storage, &hashlock, &lock)?;

    let balance = BALANCES
        .may_load(deps.storage, (&lock.sender, &lock.token_id))?
        .unwrap_or(Uint128::zero());
    BALANCES.save(deps.storage, (&lock.sender, &lock.token_id), &(balance + lock.amount))?;

    let mut stats = BRIDGE_STATS.load(deps.storage)?;
    stats.total_refunded += lock.amount;
    BRIDGE_STATS.save(deps.storage, &stats)?;

    let mut response = Response::new()
        .add_attribute("action", "refund_burn")
        .add_attribute("hashlock", hashlock)
        .add_attribute("token_id", lock.token_id.clone())
        .add_attribute("amount", lock.amount.to_string())
        .add_attribute("sender", lock.sender.clone())
        .add_attribute("state", "refunded");

    if !bounty.is_empty() {
        response = response.add_message(CosmosMsg::Bank(BankMsg::Send {
            to_address: lock.sender.clone(),
            amount: bounty,
        }));
    }

    Ok(response)
}

/// ABI-encode the prepare-mint payload consumed by the EVM bridge:
/// abi.encode(uint256 MSG_PREPARE_MINT=2, bytes32 hashlock,
///            bytes32 indicatorId, uint256 tokenId, uint256 amount,
///            address recipient, uint256 timeout)  = 7 * 32 bytes
fn abi_encode_prepare_mint(
    hashlock: &str,
    indicator_id: &str,
    token_id: &str,
    amount: Uint128,
    evm_recipient: &str,
    timeout: u64,
) -> Result<Vec<u8>, ContractError> {
    fn word_from_hex32(s: &str) -> Result<[u8; 32], ContractError> {
        let h = s.strip_prefix("0x").unwrap_or(s);
        let bytes = hex::decode(h).map_err(|_| ContractError::InvalidHashlock {})?;
        if bytes.len() != 32 { return Err(ContractError::InvalidHashlock {}); }
        let mut w = [0u8; 32];
        w.copy_from_slice(&bytes);
        Ok(w)
    }
    fn word_from_u128(v: u128) -> [u8; 32] {
        let mut w = [0u8; 32];
        w[16..].copy_from_slice(&v.to_be_bytes());
        w
    }

    let token_id_num: u128 = token_id.parse()
        .map_err(|_| ContractError::NonNumericTokenId { token_id: token_id.to_string() })?;

    let addr_hex = evm_recipient.strip_prefix("0x").unwrap_or(evm_recipient);
    let addr_bytes = hex::decode(addr_hex)
        .map_err(|_| ContractError::InvalidEvmAddress { address: evm_recipient.to_string() })?;
    if addr_bytes.len() != 20 {
        return Err(ContractError::InvalidEvmAddress { address: evm_recipient.to_string() });
    }
    let mut addr_word = [0u8; 32];
    addr_word[12..].copy_from_slice(&addr_bytes);

    let mut payload = Vec::with_capacity(224);
    payload.extend_from_slice(&word_from_u128(2));                 // MSG_PREPARE_MINT
    payload.extend_from_slice(&word_from_hex32(hashlock)?);        // hashlock
    payload.extend_from_slice(&word_from_hex32(indicator_id)?);    // indicatorId
    payload.extend_from_slice(&word_from_u128(token_id_num));      // tokenId
    payload.extend_from_slice(&word_from_u128(amount.u128()));     // amount
    payload.extend_from_slice(&addr_word);                         // recipient
    payload.extend_from_slice(&word_from_u128(timeout as u128));   // timeout

    Ok(payload)
}

/// Refund/cancel pending mint after timeout (Phase 2 - Failure)
fn execute_refund_mint(
    deps: DepsMut,
    env: Env,
    _info: MessageInfo,
    hashlock: String,
) -> Result<Response, ContractError> {
    // Load HTLC lock
    let mut htlc = HTLC_LOCKS.load(deps.storage, &hashlock)
        .map_err(|_| ContractError::HTLCNotFound { hashlock: hashlock.clone() })?;
    
    // Check state is pending
    if !matches!(htlc.state, HTLCState::Pending) {
        return Err(ContractError::InvalidHTLCState {
            hashlock: hashlock.clone(),
            expected: "pending".to_string(),
            actual: format!("{:?}", htlc.state),
        });
    }
    
    // Check timeout has expired
    if env.block.time.seconds() < htlc.timeout {
        return Err(ContractError::TimeoutNotExpired { hashlock: hashlock.clone() });
    }
    
    // Update HTLC state (no tokens were minted, so nothing to revert)
    htlc.state = HTLCState::Refunded;
    HTLC_LOCKS.save(deps.storage, &hashlock, &htlc)?;
    
    // Update stats
    let mut stats = BRIDGE_STATS.load(deps.storage)?;
    stats.total_refunded += htlc.amount;
    stats.total_pending -= htlc.amount;
    BRIDGE_STATS.save(deps.storage, &stats)?;
    
    Ok(Response::new()
        .add_attribute("action", "refund_mint")
        .add_attribute("hashlock", hashlock)
        .add_attribute("amount", htlc.amount.to_string())
        .add_attribute("cosmos_recipient", htlc.cosmos_recipient)
        .add_attribute("state", "refunded")
        .add_attribute("mint_status", "NOT_MINTED_CANCELLED"))
}

/// Create a new token class (semantic binding)
fn execute_create_token_class(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    token_id: String,
    indicator_id: String,
    indicator_type: String,
    unit: String,
    methodology_id: String,
    profile_hash: String,
    data_hash: String,
) -> Result<Response, ContractError> {
    // Only owner can create token classes
    let config = CONFIG.load(deps.storage)?;
    if info.sender.to_string() != config.owner {
        return Err(ContractError::Unauthorized {});
    }
    
    // Check if token class already exists
    if TOKEN_CLASSES.may_load(deps.storage, &token_id)?.is_some() {
        return Err(ContractError::TokenClassAlreadyExists { token_id });
    }
    
    // Check if indicator is already bound
    if INDICATOR_TO_TOKEN.may_load(deps.storage, &indicator_id)?.is_some() {
        return Err(ContractError::IndicatorAlreadyBound { indicator_id });
    }
    
    // Create token class
    let token_class = TokenClass {
        token_id: token_id.clone(),
        indicator_id: indicator_id.clone(),
        indicator_type: indicator_type.clone(),
        unit: unit.clone(),
        methodology_id,
        profile_hash,
        data_hash,
        created_at: env.block.time.seconds(),
    };
    
    TOKEN_CLASSES.save(deps.storage, &token_id, &token_class)?;
    INDICATOR_TO_TOKEN.save(deps.storage, &indicator_id, &token_id)?;
    TOKEN_SUPPLY.save(deps.storage, &token_id, &Uint128::zero())?;
    
    Ok(Response::new()
        .add_attribute("action", "create_token_class")
        .add_attribute("token_id", token_id)
        .add_attribute("indicator_id", indicator_id)
        .add_attribute("indicator_type", indicator_type)
        .add_attribute("unit", unit))
}

/// Transfer tokens between accounts
fn execute_transfer(
    deps: DepsMut,
    info: MessageInfo,
    recipient: String,
    token_id: String,
    amount: Uint128,
) -> Result<Response, ContractError> {
    if amount.is_zero() {
        return Err(ContractError::InvalidAmount {});
    }
    
    let sender = info.sender.to_string();
    
    // Check sender balance
    let sender_balance = BALANCES
        .may_load(deps.storage, (&sender, &token_id))?
        .unwrap_or(Uint128::zero());
    
    if sender_balance < amount {
        return Err(ContractError::InsufficientBalance {
            required: amount.to_string(),
            available: sender_balance.to_string(),
        });
    }
    
    // Update balances
    BALANCES.save(deps.storage, (&sender, &token_id), &(sender_balance - amount))?;
    
    let recipient_balance = BALANCES
        .may_load(deps.storage, (&recipient, &token_id))?
        .unwrap_or(Uint128::zero());
    BALANCES.save(deps.storage, (&recipient, &token_id), &(recipient_balance + amount))?;
    
    Ok(Response::new()
        .add_attribute("action", "transfer")
        .add_attribute("from", sender)
        .add_attribute("to", recipient)
        .add_attribute("token_id", token_id)
        .add_attribute("amount", amount.to_string()))
}

/// FIX #2: Validate secret format (must be valid hex, exactly 32 bytes)
fn verify_secret_format(secret: &str) -> bool {
    let hex_str = if secret.starts_with("0x") {
        &secret[2..]
    } else {
        secret
    };
    
    // Must be exactly 64 hex characters (32 bytes)
    if hex_str.len() != 64 {
        return false;
    }
    
    // Must be valid hex
    hex_str.chars().all(|c| c.is_ascii_hexdigit())
}

/// Verify that keccak256(secret) == hashlock
/// FIX #2: Returns false on invalid hex instead of silently accepting
fn verify_hashlock(secret: &str, hashlock: &str) -> bool {
    // Remove 0x prefix if present
    let hex_str = if secret.starts_with("0x") {
        &secret[2..]
    } else {
        secret
    };
    
    // Strict hex decode -- reject malformed input
    let secret_bytes = match hex::decode(hex_str) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    
    // Must be exactly 32 bytes
    if secret_bytes.len() != 32 {
        return false;
    }
    
    // Compute keccak256(secret)
    let mut hasher = Keccak256::new();
    hasher.update(&secret_bytes);
    let hash = hasher.finalize();
    
    // Convert to hex string with 0x prefix
    let computed_hashlock = format!("0x{}", hex::encode(hash));
    
    computed_hashlock.to_lowercase() == hashlock.to_lowercase()
}

/// Query contract state
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Balance { address, token_id } => {
            to_json_binary(&query_balance(deps, address, token_id)?)
        },
        QueryMsg::AllBalances { address } => {
            to_json_binary(&query_all_balances(deps, address)?)
        },
        QueryMsg::TokenClass { token_id } => {
            to_json_binary(&query_token_class(deps, token_id)?)
        },
        QueryMsg::HTLCLock { hashlock } => {
            to_json_binary(&query_htlc_lock(deps, hashlock)?)
        },
        QueryMsg::UserHTLCLocks { address } => {
            to_json_binary(&query_user_htlc_locks(deps, address)?)
        },
        QueryMsg::BridgeStats {} => {
            to_json_binary(&query_bridge_stats(deps)?)
        },
        QueryMsg::TotalSupply {} => {
            to_json_binary(&query_total_supply(deps)?)
        },
        QueryMsg::GetStoredMessage {} => {
            to_json_binary(&query_stored_message(deps)?)
        },
        QueryMsg::TokenInfo {} => {
            to_json_binary(&query_token_info(deps)?)
        },
        QueryMsg::OutboundLock { hashlock } => {
            to_json_binary(&query_outbound_lock(deps, hashlock)?)
        },
    }
}

fn query_outbound_lock(deps: Deps, hashlock: String) -> StdResult<OutboundLockResponse> {
    let lock = OUTBOUND_LOCKS.may_load(deps.storage, &hashlock)?;

    Ok(OutboundLockResponse {
        lock: lock.map(|l| {
            let state_str = match l.state {
                OutboundState::Locked => "locked",
                OutboundState::Claimed => "claimed",
                OutboundState::Refunded => "refunded",
            };
            OutboundLockInfo {
                hashlock: l.hashlock,
                sender: l.sender,
                token_id: l.token_id,
                indicator_id: l.indicator_id,
                amount: l.amount,
                evm_recipient: l.evm_recipient,
                destination_chain: l.destination_chain,
                destination_address: l.destination_address,
                timelock: l.timelock,
                created_at: l.created_at,
                state: state_str.to_string(),
                secret: l.secret,
            }
        }),
    })
}

fn query_balance(deps: Deps, address: String, token_id: String) -> StdResult<BalanceResponse> {
    let balance = BALANCES
        .may_load(deps.storage, (&address, &token_id))?
        .unwrap_or(Uint128::zero());
    
    Ok(BalanceResponse { address, token_id, balance })
}

fn query_all_balances(_deps: Deps, address: String) -> StdResult<AllBalancesResponse> {
    // Note: In production, use pagination
    // For PoC, we'll return empty (would need to iterate over all token_ids)
    Ok(AllBalancesResponse {
        address,
        balances: vec![],
    })
}

fn query_token_class(deps: Deps, token_id: String) -> StdResult<TokenClassResponse> {
    let token_class = TOKEN_CLASSES.may_load(deps.storage, &token_id)?;
    
    Ok(TokenClassResponse {
        token_class: token_class.map(|tc| {
            let supply = TOKEN_SUPPLY
                .may_load(deps.storage, &token_id)
                .unwrap_or(None)
                .unwrap_or(Uint128::zero());
            
            TokenClassInfo {
                token_id: tc.token_id,
                indicator_id: tc.indicator_id,
                indicator_type: tc.indicator_type,
                unit: tc.unit,
                methodology_id: tc.methodology_id,
                profile_hash: tc.profile_hash,
                data_hash: tc.data_hash,
                total_supply: supply,
                created_at: tc.created_at,
            }
        }),
    })
}

fn query_htlc_lock(deps: Deps, hashlock: String) -> StdResult<HTLCLockResponse> {
    let lock = HTLC_LOCKS.may_load(deps.storage, &hashlock)?;
    
    Ok(HTLCLockResponse {
        lock: lock.map(|l| {
            let state_str = match l.state {
                HTLCState::Pending => "pending",
                HTLCState::Claimed => "claimed",
                HTLCState::Refunded => "refunded",
            };
            
            HTLCLockInfo {
                hashlock: l.hashlock,
                indicator_id: l.indicator_id,
                token_id: l.token_id,
                amount: l.amount,
                cosmos_recipient: l.cosmos_recipient,
                source_chain: l.source_chain,
                source_address: l.source_address,
                timeout: l.timeout,
                created_at: l.created_at,
                state: state_str.to_string(),
                secret: l.secret,
            }
        }),
    })
}

fn query_user_htlc_locks(deps: Deps, address: String) -> StdResult<UserHTLCLocksResponse> {
    let lock_ids = USER_HTLC_LOCKS
        .may_load(deps.storage, &address)?
        .unwrap_or_default();
    
    let mut locks = Vec::new();
    for hashlock in lock_ids {
        if let Some(l) = HTLC_LOCKS.may_load(deps.storage, &hashlock)? {
            let state_str = match l.state {
                HTLCState::Pending => "pending",
                HTLCState::Claimed => "claimed",
                HTLCState::Refunded => "refunded",
            };
            
            locks.push(HTLCLockInfo {
                hashlock: l.hashlock,
                indicator_id: l.indicator_id,
                token_id: l.token_id,
                amount: l.amount,
                cosmos_recipient: l.cosmos_recipient,
                source_chain: l.source_chain,
                source_address: l.source_address,
                timeout: l.timeout,
                created_at: l.created_at,
                state: state_str.to_string(),
                secret: l.secret,
            });
        }
    }
    
    Ok(UserHTLCLocksResponse { locks })
}

fn query_bridge_stats(deps: Deps) -> StdResult<BridgeStatsResponse> {
    let stats = BRIDGE_STATS.load(deps.storage)?;
    
    Ok(BridgeStatsResponse {
        total_locks: stats.total_locks,
        total_claimed: stats.total_claimed,
        total_refunded: stats.total_refunded,
        total_pending: stats.total_pending,
    })
}

fn query_total_supply(deps: Deps) -> StdResult<TotalSupplyResponse> {
    let total_supply = TOTAL_SUPPLY.load(deps.storage)?;
    Ok(TotalSupplyResponse { total_supply })
}

fn query_stored_message(deps: Deps) -> StdResult<StoredMessageResponse> {
    let stored = STORED_MESSAGE.may_load(deps.storage)?
        .unwrap_or(StoredMessage {
            sender: "none".to_string(),
            message: "none".to_string(),
        });
    
    Ok(StoredMessageResponse {
        sender: stored.sender,
        message: stored.message,
    })
}

fn query_token_info(deps: Deps) -> StdResult<TokenInfoResponse> {
    let config = CONFIG.load(deps.storage)?;
    let total_supply = TOTAL_SUPPLY.load(deps.storage)?;
    
    Ok(TokenInfoResponse {
        name: config.token_name,
        symbol: config.token_symbol,
        decimals: config.decimals,
        total_supply,
    })
}


/// v1.1: set the expected source of prepare_mint messages (owner-only).
pub fn execute_set_counterpart(
    deps: DepsMut,
    info: MessageInfo,
    chain: String,
    address: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender.to_string() != config.owner {
        return Err(ContractError::Unauthorized {});
    }
    if chain.is_empty() || address.is_empty() {
        return Err(ContractError::InvalidPayload {});
    }
    COUNTERPART.save(deps.storage, &Counterpart { chain: chain.clone(), address: address.clone() })?;
    Ok(Response::new()
        .add_attribute("action", "set_counterpart")
        .add_attribute("chain", chain)
        .add_attribute("address", address))
}
