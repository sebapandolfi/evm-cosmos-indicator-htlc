use cosmwasm_schema::cw_serde;
use cosmwasm_std::Uint128;
use cw_storage_plus::{Item, Map};

/// Contract configuration
#[cw_serde]
pub struct Config {
    /// IBC channel for Axelar communication
    pub channel: String,
    /// Token name
    pub token_name: String,
    /// Token symbol
    pub token_symbol: String,
    /// Token decimals
    pub decimals: u8,
    /// Contract owner (for administration)
    pub owner: String,
    /// Axelar Gateway IBC address
    pub axelar_gateway: Option<String>,
    /// Axelar GMP account (receiver of IBC transfers carrying GMP memos).
    /// Required for on-chain outbound messages (automatic callback and
    /// reverse-direction prepare). Verify against Axelar docs at deploy time.
    pub axelar_gmp_account: Option<String>,
    /// Axelar relayer fee recipient for Cosmos->EVM execution. WITHOUT this
    /// the memo carries no `fee` field and no relayer executes the message
    /// on the EVM destination (it stalls after routing). Mainnet:
    /// axelar1aythygn6z5thymj6tmzfwekzh05ewg3l7d6y89
    pub axelar_fee_recipient: Option<String>,
    /// Protocol-minimum bounty (untrn) for reverse-direction locks. Prevents
    /// the adversarial-sender attack in which bounty = 0 plus a deliberately
    /// failed callback yields refund-plus-mint at gas cost; sized above the
    /// monitor's claim_burn execution cost.
    pub min_bounty: Uint128,
}

pub const CONFIG: Item<Config> = Item::new("config");

/// Authorized senders for prepare_mint (Axelar IBC relay addresses)
/// FIX #1: Only these addresses can create HTLC locks
pub const AUTHORIZED_SENDERS: Item<Vec<String>> = Item::new("authorized_senders");

/// v1.1: expected source of prepare_mint messages (Axelar chain name and the
/// address of the BridgeHTLC contract on that chain). prepare_mint fails closed
/// while it is unset.
#[cw_serde]
pub struct Counterpart {
    pub chain: String,
    pub address: String,
}

pub const COUNTERPART: Item<Counterpart> = Item::new("counterpart");

// ============ Token Balances (CW1155-style) ============

/// Balance of tokens per user per token class
/// Key: (user_address, token_id), Value: balance
pub const BALANCES: Map<(&str, &str), Uint128> = Map::new("balances");

/// Total supply per token class
pub const TOKEN_SUPPLY: Map<&str, Uint128> = Map::new("token_supply");

/// Global total supply across all token classes
pub const TOTAL_SUPPLY: Item<Uint128> = Item::new("total_supply");

// ============ Token Class Registry (Semantic Binding) ============

/// Token class metadata (bound to indicatorId)
#[cw_serde]
pub struct TokenClass {
    pub token_id: String,
    pub indicator_id: String,      // Hash of profile
    pub indicator_type: String,    // e.g., "CO2_REMOVAL"
    pub unit: String,              // e.g., "kgCO2e"
    pub methodology_id: String,
    pub profile_hash: String,
    pub data_hash: String,
    pub created_at: u64,
}

/// Token classes by token_id
pub const TOKEN_CLASSES: Map<&str, TokenClass> = Map::new("token_classes");

/// Indicator to token mapping (reverse lookup)
pub const INDICATOR_TO_TOKEN: Map<&str, String> = Map::new("indicator_to_token");

// ============ HTLC State ============

/// HTLC lock states
#[cw_serde]
pub enum HTLCState {
    Pending,    // Waiting for secret reveal
    Claimed,    // Secret revealed, tokens minted
    Refunded,   // Timeout expired, cancelled
}

/// HTLC lock record
#[cw_serde]
pub struct HTLCLock {
    pub hashlock: String,           // H = keccak256(secret) in hex
    pub indicator_id: String,       // Semantic binding
    pub token_id: String,           // Token class
    pub amount: Uint128,
    pub cosmos_recipient: String,   // Who receives minted tokens
    pub source_chain: String,       // e.g., "Polygon"
    pub source_address: String,     // EVM bridge contract
    pub timeout: u64,               // Unix timestamp
    pub created_at: u64,
    pub state: HTLCState,
    pub secret: Option<String>,     // Revealed secret (after claim)
}

/// HTLC locks by hashlock
pub const HTLC_LOCKS: Map<&str, HTLCLock> = Map::new("htlc_locks");

/// User's HTLC locks (for queries)
pub const USER_HTLC_LOCKS: Map<&str, Vec<String>> = Map::new("user_htlc_locks");

// ============ Reverse Direction (this chain as HTLC source) ============

/// Outbound lock states (mirror of the EVM BridgeHTLC LockState)
#[cw_serde]
pub enum OutboundState {
    Locked,     // Tokens escrowed, prepare message emitted
    Claimed,    // Destination claim confirmed, escrow burned
    Refunded,   // Timeout expired, escrow returned to sender
}

/// Outbound HTLC lock (Neutron -> EVM transfer)
#[cw_serde]
pub struct OutboundLock {
    pub hashlock: String,             // H = keccak256(secret) in hex
    pub sender: String,               // Locker (this-chain address)
    pub token_id: String,             // Token class
    pub indicator_id: String,         // Semantic binding (read from registry)
    pub amount: Uint128,
    pub evm_recipient: String,        // 0x-prefixed EVM address
    pub destination_chain: String,    // Axelar chain name (e.g., "Polygon")
    pub destination_address: String,  // EVM BridgeHTLC address
    pub timelock: u64,                // T_e on this chain (unix seconds)
    pub bounty: Vec<cosmwasm_std::Coin>, // Escrowed bounty for the fallback burn
    pub created_at: u64,
    pub state: OutboundState,
    pub secret: Option<String>,       // Revealed secret after claim
}

/// Outbound locks by hashlock
pub const OUTBOUND_LOCKS: Map<&str, OutboundLock> = Map::new("outbound_locks");

// ============ Bridge Statistics ============

#[cw_serde]
pub struct BridgeStats {
    pub total_locks: u64,
    pub total_claimed: Uint128,
    pub total_refunded: Uint128,
    pub total_pending: Uint128,
}

pub const BRIDGE_STATS: Item<BridgeStats> = Item::new("bridge_stats");

// ============ Debug/Testing ============

#[cw_serde]
pub struct StoredMessage {
    pub sender: String,
    pub message: String,
}

pub const STORED_MESSAGE: Item<StoredMessage> = Item::new("stored_message");
