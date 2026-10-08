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
    /// Axelar GMP account (receiver of IBC transfers carrying GMP memos);
    /// required for on-chain outbound GMP (automatic callback, reverse direction)
    pub axelar_gmp_account: Option<String>,
    /// Axelar relayer fee recipient (mainnet:
    /// axelar1aythygn6z5thymj6tmzfwekzh05ewg3l7d6y89); required for automatic
    /// execution of Cosmos->EVM messages on the destination chain
    pub axelar_fee_recipient: Option<String>,
    /// Protocol-minimum bounty in untrn (default 50000 = 0.05 NTRN)
    pub min_bounty: Option<Uint128>,
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
    
    // ============ Reverse Direction (this chain as HTLC source) ============

    /// Lock tokens on this chain for transfer to an EVM chain.
    /// Escrows `amount` of `token_id` plus an optional native-coin bounty;
    /// emits the ABI-encoded prepare message to the EVM bridge via Axelar GMP.
    /// Attached funds = IBC/relay fee + bounty (bounty listed explicitly).
    #[serde(rename = "lock_for_burn")]
    LockForBurn {
        token_id: String,
        amount: Uint128,
        hashlock: String,            // 0x + 64 hex chars, keccak256(secret)
        timelock: u64,               // T_e unix seconds on this chain
        evm_recipient: String,       // 0x-prefixed EVM address
        destination_chain: String,   // Axelar chain name (e.g., "Polygon")
        destination_address: String, // EVM BridgeHTLC address
        /// Portion of the attached native funds escrowed as bounty for the
        /// fallback claim_burn path (denom must match an attached coin)
        bounty: Option<cosmwasm_std::Coin>,
    },

    /// Burn escrowed tokens after a confirmed destination claim.
    /// Invoked automatically by the relayed EVM callback, or manually by any
    /// party knowing the secret (fallback). Pays the escrowed bounty to the
    /// caller on the manual path; returns it to the sender on the relayed path.
    #[serde(rename = "claim_burn")]
    ClaimBurn {
        hashlock: String,
        secret: String,
    },

    /// Refund escrowed tokens (and bounty) to the sender after timeout.
    #[serde(rename = "refund_burn")]
    RefundBurn {
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

    /// Withdraw native coins held by the contract (owner-only). Recovers
    /// refunds from failed/timed-out IBC transfers (feerefunder timeout
    /// refunds, error-ack transfer refunds), which are otherwise orphaned.
    #[serde(rename = "withdraw_funds")]
    WithdrawFunds {
        denom: String,
        amount: Uint128,
        to: Option<String>,
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

    /// Query an outbound (reverse-direction) lock by hashlock
    #[returns(OutboundLockResponse)]
    OutboundLock {
        hashlock: String,
    },
}

// ============ Axelar GMP Memo Types ============
// Mirrors the schema in axelarnetwork/evm-cosmos-gmp-sample (send-receive):
// the memo of the IBC transfer to the Axelar GMP account. `payload` must
// serialize as a JSON byte array (Vec<u8>), NOT a hex string. `fee` is
// optional (None in the reference implementation; the attached IBC coin
// pays for the relay).

#[cw_serde]
pub struct GmpFee {
    pub amount: String,
    pub recipient: String,
}

#[cw_serde]
pub struct GmpMessage {
    pub destination_chain: String,
    pub destination_address: String,
    pub payload: Vec<u8>,
    #[serde(rename = "type")]
    pub type_: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee: Option<GmpFee>,
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
pub struct OutboundLockResponse {
    pub lock: Option<OutboundLockInfo>,
}

#[cw_serde]
pub struct OutboundLockInfo {
    pub hashlock: String,
    pub sender: String,
    pub token_id: String,
    pub indicator_id: String,
    pub amount: Uint128,
    pub evm_recipient: String,
    pub destination_chain: String,
    pub destination_address: String,
    pub timelock: u64,
    pub created_at: u64,
    pub state: String,          // "locked", "claimed", "refunded"
    pub secret: Option<String>,
}

#[cw_serde]
pub struct TokenInfoResponse {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub total_supply: Uint128,
}
