use anchor_lang::prelude::*;

use crate::{error::ErrorCode, state::fee_config::FeeConfig};

/// Accounts for [merkle_distributor_fee_task::set_claim_fee].
#[derive(Accounts)]
pub struct SetClaimFee<'info> {
    /// Global fee configuration PDA.
    #[account(
        mut,
        seeds = [b"FeeConfig"],
        bump = fee_config.bump,
    )]
    pub fee_config: Account<'info, FeeConfig>,

    /// Fee config admin signer.
    #[account(address = fee_config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,

    /// New fee recipient wallet.
    /// CHECK: Can be any valid wallet that will receive claim fees.
    pub new_fee_recipient: UncheckedAccount<'info>,
}

/// Updates the global claim fee amount and recipient.
#[allow(clippy::result_large_err)]
pub fn handle_set_claim_fee(ctx: Context<SetClaimFee>, claim_fee: u64) -> Result<()> {
    if claim_fee > 0 {
        require!(
            ctx.accounts.new_fee_recipient.key() != Pubkey::default(),
            ErrorCode::InvalidFeeRecipient
        );
    }

    let fee_config = &mut ctx.accounts.fee_config;
    fee_config.claim_fee = claim_fee;
    fee_config.fee_recipient = ctx.accounts.new_fee_recipient.key();

    msg!(
        "Claim fee updated to {} lamports, recipient {}",
        fee_config.claim_fee,
        fee_config.fee_recipient
    );

    Ok(())
}
