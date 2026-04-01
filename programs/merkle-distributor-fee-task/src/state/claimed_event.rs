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

/// Emitted when the fee configuration is initialized.
#[event]
pub struct FeeConfigInitializedEvent {
    /// Admin that initialized the fee config.
    pub admin: Pubkey,
    /// Initial claim fee in lamports.
    pub claim_fee: u64,
    /// Initial fee recipient wallet.
    pub fee_recipient: Pubkey,
}

/// Emitted when the claim fee or recipient is updated.
#[event]
pub struct FeeConfigUpdatedEvent {
    /// Admin that updated the fee config.
    pub admin: Pubkey,
    /// New claim fee in lamports.
    pub new_claim_fee: u64,
    /// New fee recipient wallet.
    pub new_fee_recipient: Pubkey,
}

/// Emitted when the fee config admin is transferred.
#[event]
pub struct FeeAdminUpdatedEvent {
    /// Previous admin.
    pub previous_admin: Pubkey,
    /// New admin.
    pub new_admin: Pubkey,
}
