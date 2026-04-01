use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount};
use solana_program::hash::hashv;

use jito_merkle_verify::verify;

use crate::{
    error::ErrorCode,
    state::{
        claim_status::ClaimStatus,
        claimed_event::{FeeCollectedEvent, NewClaimEvent},
        fee_config::FeeConfig,
        merkle_distributor::MerkleDistributor,
    },
};

const LEAF_PREFIX: &[u8] = &[0];

/// [merkle_distributor_fee_task::new_claim] accounts.
#[derive(Accounts)]
pub struct NewClaim<'info> {
    /// The [MerkleDistributor].
    #[account(mut)]
    pub distributor: Account<'info, MerkleDistributor>,

    /// Claim status PDA
    #[account(
        init,
        seeds = [
            b"ClaimStatus".as_ref(),
            claimant.key().to_bytes().as_ref(),
            distributor.key().to_bytes().as_ref()
        ],
        bump,
        space = ClaimStatus::LEN,
        payer = claimant
    )]
    pub claim_status: Account<'info, ClaimStatus>,

    /// Distributor ATA containing the tokens to distribute.
    #[account(
        mut,
        associated_token::mint = distributor.mint,
        associated_token::authority = distributor.key(),
        address = distributor.token_vault
    )]
    pub from: Account<'info, TokenAccount>,

    /// Account to send the claimed tokens to.
    #[account(
        mut,
        token::mint=distributor.mint,
        token::authority = claimant.key()
    )]
    pub to: Account<'info, TokenAccount>,

    /// Who is claiming the tokens.
    #[account(mut, address = to.owner @ ErrorCode::OwnerMismatch)]
    pub claimant: Signer<'info>,

    /// SPL [Token] program.
    pub token_program: Program<'info, Token>,

    /// The [System] program.
    pub system_program: Program<'info, System>,

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
}

#[allow(clippy::result_large_err)]
pub fn handle_new_claim(
    ctx: Context<NewClaim>,
    amount_unlocked: u64,
    amount_locked: u64,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    let distributor_key = ctx.accounts.distributor.key();
    let distributor = &mut ctx.accounts.distributor;

    let curr_ts = Clock::get()?.unix_timestamp;
    require!(!distributor.clawed_back, ErrorCode::ClaimExpired);

    // Collect claim fee if tokens are transferring now (amount_unlocked > 0)
    let fee_config = &ctx.accounts.fee_config;
    let fee_charged = if fee_config.claim_fee > 0 && amount_unlocked > 0 {
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
        emit!(FeeCollectedEvent {
            claimant: ctx.accounts.claimant.key(),
            fee_amount: fee_config.claim_fee,
            fee_recipient: fee_config.fee_recipient,
            distributor: distributor_key,
        });
        true
    } else {
        false
    };

    distributor.num_nodes_claimed = distributor
        .num_nodes_claimed
        .checked_add(1)
        .ok_or(ErrorCode::ArithmeticError)?;

    require!(
        distributor.num_nodes_claimed <= distributor.max_num_nodes,
        ErrorCode::MaxNodesExceeded
    );

    let claimant_account = &ctx.accounts.claimant;

    // Verify the merkle proof.
    let claimant_bytes = claimant_account.key().to_bytes();
    let unlocked_bytes = amount_unlocked.to_le_bytes();
    let locked_bytes = amount_locked.to_le_bytes();
    let node = hashv(&[
        claimant_bytes.as_ref(),
        unlocked_bytes.as_ref(),
        locked_bytes.as_ref(),
    ]);

    let distributor = &ctx.accounts.distributor;
    let node_bytes = node.to_bytes();
    let node = hashv(&[LEAF_PREFIX, node_bytes.as_ref()]);

    require!(
        verify(proof, distributor.root, node.to_bytes()),
        ErrorCode::InvalidProof
    );

    let claim_status = &mut ctx.accounts.claim_status;

    claim_status.claimant = claimant_account.key();
    claim_status.locked_amount = amount_locked;
    claim_status.unlocked_amount = amount_unlocked;
    claim_status.locked_amount_withdrawn = 0;
    claim_status.fee_paid = fee_charged;

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
        claim_status.unlocked_amount,
    )?;

    let distributor = &mut ctx.accounts.distributor;
    distributor.total_amount_claimed = distributor
        .total_amount_claimed
        .checked_add(claim_status.unlocked_amount)
        .ok_or(ErrorCode::ArithmeticError)?;

    require!(
        distributor.total_amount_claimed <= distributor.max_total_claim,
        ErrorCode::ExceededMaxClaim
    );

    msg!(
        "Created new claim with locked {} and {} unlocked with lockup start:{} end:{}",
        claim_status.locked_amount,
        claim_status.unlocked_amount,
        distributor.start_ts,
        distributor.end_ts,
    );
    emit!(NewClaimEvent {
        claimant: claimant_account.key(),
        timestamp: curr_ts
    });

    Ok(())
}
