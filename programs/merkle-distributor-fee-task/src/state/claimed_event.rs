use anchor_lang::prelude::*;

/// Emitted when a new claim is created.
#[event]
pub struct NewClaimEvent {
    /// User that claimed.
    pub claimant: Pubkey,
    /// Timestamp.
    pub timestamp: i64,
}

/// Emitted when tokens are claimed.
#[event]
pub struct ClaimedEvent {
    /// User that claimed.
    pub claimant: Pubkey,
    /// Amount of tokens to distribute.
    pub amount: u64,
}

/// Emitted when a claim fee is collected.
#[event]
pub struct FeeCollectedEvent {
    /// User that paid the fee.
    pub claimant: Pubkey,
    /// Fee amount in lamports.
    pub fee_amount: u64,
    /// Wallet that received the fee.
    pub fee_recipient: Pubkey,
    /// Distributor the claim is against.
    pub distributor: Pubkey,
}
