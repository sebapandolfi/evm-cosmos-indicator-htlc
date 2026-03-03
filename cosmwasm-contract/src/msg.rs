use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Uint128;

#[cw_serde]
pub struct InstantiateMsg {
    /// IBC channel for Axelar
    pub channel: String,
    /// Token name
    pub token_name: String,
    /// Token symbol
    pub token_symbol: String,
    /// Decimals
    pub decimals: u8,
    /// Axelar Gateway IBC address (optional)
    pub axelar_gateway: Option<String>,
}

#[cw_serde]
pub enum ExecuteMsg {
    // ============ HTLC Operations ============
    
    /// Prepare mint via GMP from EVM (creates HTLC lock)
    /// Called when EVM locks tokens with a hashlock
    #[serde(rename = "prepare_mint")]
    PrepareMint {
        hashlock: String,           // Hex string of keccak256(secret)
        indicator_id: String,       // Semantic binding
        token_id: String,           // Token class
        amount: String,             // Amount as string
        cosmos_recipient: String,   // Who receives minted tokens
        timeout: String,            // Unix timestamp as string
        source_chain: String,       // e.g., "Polygon"
        source_address: String,     // EVM bridge contract
    },
    
    /// Claim minted tokens by revealing the secret
    /// User reveals secret S where keccak256(S) == hashlock
    #[serde(rename = "claim_mint")]
    ClaimMint {
        hashlock: String,           // The hashlock to claim
        secret: String,             // The preimage (hex string)
    },
    
    /// Refund/cancel pending mint after timeout
    /// Called when timeout expires and no claim was made
    #[serde(rename = "refund_mint")]
    RefundMint {
        hashlock: String,
    },
    
    // ============ Token Class Management ============
    
    /// Create a new token class (semantic binding)
    #[serde(rename = "create_token_class")]
    CreateTokenClass {
        token_id: String,
        indicator_id: String,
        indicator_type: String,
        unit: String,
        methodology_id: String,
        profile_hash: String,
        data_hash: String,
    },
    
    // ============ Token Operations ============
    
    /// Transfer tokens between accounts
    #[serde(rename = "transfer")]
    Transfer {
        recipient: String,
        token_id: String,
        amount: Uint128,
    },
    
    // ============ Admin ============
    
    /// Add an authorized GMP sender address (owner-only)
    #[serde(rename = "add_authorized_sender")]
    AddAuthorizedSender {
        sender: String,
    },
    
    /// Remove an authorized GMP sender address (owner-only)
    #[serde(rename = "remove_authorized_sender")]
    RemoveAuthorizedSender {
        sender: String,
    },
    
    // ============ Testing ============
    
    /// Test message for GMP connectivity (owner-only)
    #[serde(rename = "receive_test")]
    ReceiveTest {
        message: String,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    /// Query balance of a specific token class
    #[returns(BalanceResponse)]
    Balance { 
        address: String,
        token_id: String,
    },
    
    /// Query all balances of a user
    #[returns(AllBalancesResponse)]
    AllBalances { 
        address: String,
    },
    
    /// Query token class info
    #[returns(TokenClassResponse)]
    TokenClass {
        token_id: String,
    },
    
    /// Query HTLC lock by hashlock
    #[returns(HTLCLockResponse)]
    HTLCLock {
        hashlock: String,
    },
    
    /// Query user's HTLC locks
    #[returns(UserHTLCLocksResponse)]
    UserHTLCLocks {
        address: String,
    },
    
    /// Query bridge statistics
    #[returns(BridgeStatsResponse)]
    BridgeStats {},
    
    /// Query total supply
    #[returns(TotalSupplyResponse)]
    TotalSupply {},
    
    /// Query stored message (testing)
    #[returns(StoredMessageResponse)]
    GetStoredMessage {},
    
    /// Query token info
    #[returns(TokenInfoResponse)]
    TokenInfo {},
}

// ============ Response Types ============

#[cw_serde]
pub struct BalanceResponse {
    pub address: String,
    pub token_id: String,
    pub balance: Uint128,
}

#[cw_serde]
pub struct TokenBalance {
    pub token_id: String,
    pub balance: Uint128,
}

#[cw_serde]
pub struct AllBalancesResponse {
    pub address: String,
    pub balances: Vec<TokenBalance>,
}

#[cw_serde]
pub struct TokenClassResponse {
    pub token_class: Option<TokenClassInfo>,
}

#[cw_serde]
pub struct TokenClassInfo {
    pub token_id: String,
    pub indicator_id: String,
    pub indicator_type: String,
    pub unit: String,
    pub methodology_id: String,
    pub profile_hash: String,
    pub data_hash: String,
    pub total_supply: Uint128,
    pub created_at: u64,
}

#[cw_serde]
pub struct HTLCLockResponse {
    pub lock: Option<HTLCLockInfo>,
}

#[cw_serde]
pub struct HTLCLockInfo {
    pub hashlock: String,
    pub indicator_id: String,
    pub token_id: String,
    pub amount: Uint128,
    pub cosmos_recipient: String,
    pub source_chain: String,
    pub source_address: String,
    pub timeout: u64,
    pub created_at: u64,
    pub state: String,          // "pending", "claimed", "refunded"
    pub secret: Option<String>, // Revealed secret if claimed
}

#[cw_serde]
pub struct UserHTLCLocksResponse {
    pub locks: Vec<HTLCLockInfo>,
}

#[cw_serde]
pub struct BridgeStatsResponse {
    pub total_locks: u64,
    pub total_claimed: Uint128,
    pub total_refunded: Uint128,
    pub total_pending: Uint128,
}

#[cw_serde]
pub struct TotalSupplyResponse {
    pub total_supply: Uint128,
}

#[cw_serde]
pub struct StoredMessageResponse {
    pub sender: String,
    pub message: String,
}

#[cw_serde]
pub struct TokenInfoResponse {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub total_supply: Uint128,
}
