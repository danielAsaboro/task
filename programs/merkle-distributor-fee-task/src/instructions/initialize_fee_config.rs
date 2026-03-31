use anchor_lang::prelude::*;

use crate::{error::ErrorCode, state::fee_config::FeeConfig};

/// Accounts for [merkle_distributor_fee_task::initialize_fee_config].
#[derive(Accounts)]
pub struct InitializeFeeConfig<'info> {
    /// Global fee configuration PDA.
    #[account(
        init,
        seeds = [b"FeeConfig"],
        bump,
        space = FeeConfig::LEN,
        payer = admin
    )]
    pub fee_config: Account<'info, FeeConfig>,

    /// Admin wallet, responsible for creating the fee config and paying for the account.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Fee recipient wallet.
    /// CHECK: Can be any valid wallet that will receive claim fees.
    pub fee_recipient: UncheckedAccount<'info>,

    /// The [System] program.
    pub system_program: Program<'info, System>,
}

/// Initializes the global fee configuration.
/// This can only be called once since the PDA is initialized with `init`.
#[allow(clippy::result_large_err)]
pub fn handle_initialize_fee_config(
    ctx: Context<InitializeFeeConfig>,
    claim_fee: u64,
) -> Result<()> {
    if claim_fee > 0 {
        require!(
            ctx.accounts.fee_recipient.key() != Pubkey::default(),
            ErrorCode::InvalidFeeRecipient
        );
    }

    let fee_config = &mut ctx.accounts.fee_config;
    fee_config.admin = ctx.accounts.admin.key();
    fee_config.claim_fee = claim_fee;
    fee_config.fee_recipient = ctx.accounts.fee_recipient.key();
    fee_config.bump = ctx.bumps.fee_config;

    msg!(
        "Fee config initialized: fee={} lamports, recipient={}",
        fee_config.claim_fee,
        fee_config.fee_recipient
    );

    Ok(())
}
