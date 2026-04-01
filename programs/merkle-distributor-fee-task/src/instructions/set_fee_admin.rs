use anchor_lang::prelude::*;

use crate::{error::ErrorCode, state::fee_config::FeeConfig};

/// Accounts for [merkle_distributor_fee_task::set_fee_admin].
#[derive(Accounts)]
pub struct SetFeeAdmin<'info> {
    /// Global fee configuration PDA.
    #[account(
        mut,
        seeds = [b"FeeConfig"],
        bump = fee_config.bump,
    )]
    pub fee_config: Account<'info, FeeConfig>,

    /// Current fee config admin signer.
    #[account(address = fee_config.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,

    /// New admin account.
    /// CHECK: Can be any valid pubkey that will become the new fee config admin.
    pub new_admin: UncheckedAccount<'info>,
}

/// Transfers the fee config admin authority to a new account.
#[allow(clippy::result_large_err)]
pub fn handle_set_fee_admin(ctx: Context<SetFeeAdmin>) -> Result<()> {
    require!(
        ctx.accounts.admin.key() != ctx.accounts.new_admin.key(),
        ErrorCode::SameFeeAdmin
    );

    let fee_config = &mut ctx.accounts.fee_config;
    fee_config.admin = ctx.accounts.new_admin.key();

    emit!(crate::state::claimed_event::FeeAdminUpdatedEvent {
        previous_admin: ctx.accounts.admin.key(),
        new_admin: ctx.accounts.new_admin.key(),
    });

    msg!(
        "Fee config admin transferred from {} to {}",
        ctx.accounts.admin.key(),
        ctx.accounts.new_admin.key()
    );

    Ok(())
}
