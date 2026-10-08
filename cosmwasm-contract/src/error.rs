use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Invalid payload format")]
    InvalidPayload {},

    #[error("Invalid amount: must be greater than zero")]
    InvalidAmount {},

    #[error("Invalid address format: {address}")]
    InvalidAddress { address: String },

    #[error("Insufficient balance: required {required}, available {available}")]
    InsufficientBalance { required: String, available: String },

    // ============ HTLC Errors ============

    #[error("HTLC lock not found: {hashlock}")]
    HTLCNotFound { hashlock: String },

    #[error("HTLC lock already exists: {hashlock}")]
    HTLCAlreadyExists { hashlock: String },

    #[error("Invalid HTLC state for {hashlock}: expected {expected}, got {actual}")]
    InvalidHTLCState { hashlock: String, expected: String, actual: String },

    #[error("Invalid secret: hash does not match hashlock")]
    InvalidSecret {},

    #[error("HTLC timeout not expired: {hashlock}")]
    TimeoutNotExpired { hashlock: String },

    #[error("HTLC timeout expired: {hashlock}")]
    TimeoutExpired { hashlock: String },

    #[error("Invalid hashlock format")]
    InvalidHashlock {},

    #[error("Unauthorized sender for GMP: {sender}")]
    UnauthorizedSender { sender: String },

    // ============ Token Class Errors ============

    #[error("Token class not found: {token_id}")]
    TokenClassNotFound { token_id: String },

    #[error("Token class already exists: {token_id}")]
    TokenClassAlreadyExists { token_id: String },

    #[error("Indicator already bound to token: {indicator_id}")]
    IndicatorAlreadyBound { indicator_id: String },

    // ============ Reverse Direction Errors ============

    #[error("Outbound lock not found: {hashlock}")]
    OutboundLockNotFound { hashlock: String },

    #[error("Outbound lock already exists: {hashlock}")]
    OutboundLockAlreadyExists { hashlock: String },

    #[error("Invalid outbound lock state for {hashlock}: expected {expected}, got {actual}")]
    InvalidOutboundState { hashlock: String, expected: String, actual: String },

    #[error("Invalid EVM recipient address: {address}")]
    InvalidEvmAddress { address: String },

    #[error("Bounty exceeds attached funds or denom not attached")]
    InvalidBounty {},

    #[error("Axelar GMP account not configured; cannot emit outbound message")]
    GmpAccountNotConfigured {},

    #[error("Token id is not numeric (required for EVM payload): {token_id}")]
    NonNumericTokenId { token_id: String },

    #[error("Indicator identity mismatch for token {token_id}: registered {registered}, message {message}")]
    IndicatorMismatch { token_id: String, registered: String, message: String },

    #[error("Insufficient relay funds: need more than {minimum}, got {provided} (must cover IBC ack+timeout fees plus relay fee)")]
    InsufficientRelayFunds { minimum: String, provided: String },

    #[error("No Axelar-registered relay token attached (attach e.g. AXL as a second coin; NTRN is not an Axelar asset)")]
    MissingRelayToken {},

    #[error("Bounty below protocol minimum: need at least {minimum}, got {provided}")]
    BountyBelowMinimum { minimum: String, provided: String },
}
