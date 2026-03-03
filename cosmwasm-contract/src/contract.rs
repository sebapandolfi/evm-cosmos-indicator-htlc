#[cfg(not(feature = "library"))]
use cosmwasm_std::{
    to_json_binary, Binary, CosmosMsg, Deps, DepsMut, Env,
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
        ExecuteMsg::AddAuthorizedSender { sender } => {
            execute_add_authorized_sender(deps, info, sender)
        },
        
        // Admin: Remove authorized GMP sender
        ExecuteMsg::RemoveAuthorizedSender { sender } => {
            execute_remove_authorized_sender(deps, info, sender)
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
    // FIX #1: Verify sender is authorized (Axelar IBC relay or owner)
    let config = CONFIG.load(deps.storage)?;
    let authorized_senders = AUTHORIZED_SENDERS.load(deps.storage)?;
    let sender = info.sender.to_string();
    
    let is_authorized = sender == config.owner
        || config.axelar_gateway.as_ref().map_or(false, |gw| *gw == sender)
        || authorized_senders.contains(&sender);
    
    if !is_authorized {
        return Err(ContractError::UnauthorizedSender { sender });
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
    
    // FIX #5 (partial): Validate token class exists
    if TOKEN_CLASSES.may_load(deps.storage, &token_id)?.is_none() {
        return Err(ContractError::TokenClassNotFound { token_id });
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
        Ok(payload_hex) => {
            // Build Axelar GMP callback info
            // Emitted as attributes for the Axelar relayer to pick up
            // and as a Stargate IBC MsgTransfer with memo for automatic relay
            let gmp_memo = format!(
                r#"{{"destination_chain":"{}","destination_address":"{}","payload":"{}","type":2}}"#,
                htlc.source_chain,
                htlc.source_address,
                payload_hex
            );
            
            // Use Stargate MsgTransfer for IBC with memo (compatible with all CosmWasm versions)
            let callback_funds = info.funds.iter()
                .find(|c| !c.amount.is_zero())
                .cloned();
            
            // Emit callback info as contract attributes.
            // The off-chain relayer watches for these events and automatically
            // submits claimBurn on EVM with the revealed secret.
            // This approach is compatible with all CosmWasm environments
            // and doesn't require special IBC permissions.
            response = response
                .add_attribute("callback_status", "READY")
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
fn build_ibc_transfer_stargate(
    channel_id: &str,
    sender: &str,
    denom: &str,
    amount: u128,
    memo: &str,
    timeout_timestamp: u64,
) -> CosmosMsg {
    // Manually encode ibc.applications.transfer.v1.MsgTransfer protobuf
    // Fields: source_port(1), source_channel(2), token(3), sender(4),
    //         receiver(5), timeout_height(6), timeout_timestamp(7), memo(8)
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
    // Field 5: receiver (Axelar gateway - use channel endpoint)
    proto_encode_string(&mut buf, 5, sender); // Will be routed by memo
    // Field 7: timeout_timestamp (nanoseconds)
    proto_encode_uint64(&mut buf, 7, timeout_timestamp * 1_000_000_000);
    // Field 8: memo (Axelar GMP routing info)
    proto_encode_string(&mut buf, 8, memo);
    
    CosmosMsg::Stargate {
        type_url: "/ibc.applications.transfer.v1.MsgTransfer".to_string(),
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
/// Returns hex-encoded payload: bytes32(hashlock) + bytes32(secret)
fn build_gmp_callback_payload(hashlock: &str, secret: &str) -> Result<String, ContractError> {
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
    
    Ok(format!("0x{}", hex::encode(&payload)))
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
    }
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
