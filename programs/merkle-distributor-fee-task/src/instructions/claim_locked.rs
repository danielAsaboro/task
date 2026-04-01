use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount};

use crate::{
    error::ErrorCode,
    state::{
        claim_status::ClaimStatus,
        claimed_event::{ClaimedEvent, FeeCollectedEvent},
        fee_config::FeeConfig,
        merkle_distributor::MerkleDistributor,
    },
};

/// [merkle_distributor_fee_task::claim_locked] accounts.
#[derive(Accounts)]
pub struct ClaimLocked<'info> {
    /// The [MerkleDistributor].
    #[account(mut)]
    pub distributor: Account<'info, MerkleDistributor>,

    /// Claim Status PDA
    #[account(
        mut,
        seeds = [
            b"ClaimStatus".as_ref(),
            claimant.key().to_bytes().as_ref(),
            distributor.key().to_bytes().as_ref()
        ],
        bump,
    )]
    pub claim_status: Account<'info, ClaimStatus>,

    /// Distributor ATA containing the tokens to distribute.
    #[account(
        mut,
        associated_token::mint = distributor.mint,
        associated_token::authority = distributor.key(),
        address = distributor.token_vault,
    )]
    pub from: Account<'info, TokenAccount>,

    /// Account to send the claimed tokens to.
    #[account(mut, token::authority = claimant.key())]
    pub to: Account<'info, TokenAccount>,

    /// Who is claiming the tokens.
    #[account(mut, address = to.owner @ ErrorCode::OwnerMismatch)]
    pub claimant: Signer<'info>,

    /// SPL [Token] program.
    pub token_program: Program<'info, Token>,

    /// Global fee configuration.
    #[account(
        seeds = [b"FeeConfig"],
        bump = fee_config.bump,
    )]
    pub fee_config: Account<'info, FeeConfig>,

    /// Fee recipient wallet.
    /// CHECK: Validated against fee_config.fee_recipient in handler when fee > 0.
    #[account(mut)]
    pub fee_recipient: UncheckedAccount<'info>,

    /// The [System] program (needed for SOL fee transfer).
    pub system_program: Program<'info, System>,
}

#[allow(clippy::result_large_err)]
pub fn handle_claim_locked(ctx: Context<ClaimLocked>) -> Result<()> {
    let distributor = &ctx.accounts.distributor;

    let claim_status = &mut ctx.accounts.claim_status;
    let curr_ts = Clock::get()?.unix_timestamp;

    require!(!distributor.clawed_back, ErrorCode::ClaimExpired);

    let amount =
        claim_status.amount_withdrawable(curr_ts, distributor.start_ts, distributor.end_ts)?;

    require!(amount > 0, ErrorCode::InsufficientUnlockedTokens);

    // Collect claim fee on first locked claim if not already paid during new_claim
    let fee_config = &ctx.accounts.fee_config;
    if fee_config.claim_fee > 0 && !claim_status.fee_paid {
        require!(
            ctx.accounts.fee_recipient.key() == fee_config.fee_recipient,
            ErrorCode::InvalidFeeRecipient
        );
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.claimant.to_account_info(),
                    to: ctx.accounts.fee_recipient.to_account_info(),
                },
            ),
            fee_config.claim_fee,
        )?;
        claim_status.fee_paid = true;
        emit!(FeeCollectedEvent {
            claimant: ctx.accounts.claimant.key(),
            fee_amount: fee_config.claim_fee,
            fee_recipient: fee_config.fee_recipient,
            distributor: ctx.accounts.distributor.key(),
        });
    }

    let seeds = [
        b"MerkleDistributor".as_ref(),
        &distributor.mint.to_bytes(),
        &distributor.version.to_le_bytes(),
        &[ctx.accounts.distributor.bump],
    ];

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.distributor.to_account_info(),
            },
        )
        .with_signer(&[&seeds[..]]),
        amount,
    )?;

    claim_status.locked_amount_withdrawn = claim_status
        .locked_amount_withdrawn
        .checked_add(amount)
        .ok_or(ErrorCode::ArithmeticError)?;

    require!(
        claim_status.locked_amount_withdrawn <= claim_status.locked_amount,
        ErrorCode::ExceededMaxClaim
    );

    let distributor = &mut ctx.accounts.distributor;
    distributor.total_amount_claimed = distributor
        .total_amount_claimed
        .checked_add(amount)
        .ok_or(ErrorCode::ArithmeticError)?;

    require!(
        distributor.total_amount_claimed <= distributor.max_total_claim,
        ErrorCode::ExceededMaxClaim
    );

    let remaining_seconds = match curr_ts < distributor.end_ts {
        true => distributor.end_ts - curr_ts,
        false => 0,
    };

    let days = remaining_seconds / (24 * 60 * 60);
    let seconds_after_days = remaining_seconds % (24 * 60 * 60);

    msg!(
        "Withdrew amount {} with {} days and {} seconds left in lockup",
        amount,
        days,
        seconds_after_days,
    );
    emit!(ClaimedEvent {
        claimant: ctx.accounts.claimant.key(),
        amount,
    });
    Ok(())
}
