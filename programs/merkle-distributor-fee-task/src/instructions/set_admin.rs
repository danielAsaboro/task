use anchor_lang::prelude::*;

use crate::{error::ErrorCode, state::merkle_distributor::MerkleDistributor};

/// [merkle_distributor_fee_task::set_admin] accounts.
#[derive(Accounts)]
pub struct SetAdmin<'info> {
    /// The [MerkleDistributor].
    #[account(mut)]
    pub distributor: Account<'info, MerkleDistributor>,

    /// Admin signer
    #[account(mut, address = distributor.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,

    /// New admin account
    /// CHECK: this can be any new account
    pub new_admin: UncheckedAccount<'info>,
}

#[allow(clippy::result_large_err)]
pub fn handle_set_admin(ctx: Context<SetAdmin>) -> Result<()> {
    let distributor = &mut ctx.accounts.distributor;

    require!(
        ctx.accounts.admin.key != &ctx.accounts.new_admin.key(),
        ErrorCode::SameAdmin
    );

    distributor.admin = ctx.accounts.new_admin.key();

    msg!("set new admin to {}", ctx.accounts.new_admin.key());

    Ok(())
}
