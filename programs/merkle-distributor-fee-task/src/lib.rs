//! A program for distributing tokens efficiently via uploading a [Merkle root](https://en.wikipedia.org/wiki/Merkle_tree).
//!
//! Based on [Jito's Merkle Distributor](https://github.com/jito-foundation/distributor),
//! extended with admin-controlled claim fee management.

#![allow(clippy::too_many_arguments)]
use anchor_lang::prelude::*;
use instructions::*;

pub mod error;
pub mod instructions;
pub mod state;

declare_id!("Ah7iuugan983ymZAKJAFAdvPN3My7ESkGUARrFTn3iqM");

#[program]
pub mod merkle_distributor_fee_task {
    use super::*;

    /// Creates a new [MerkleDistributor].
    /// WARNING: Susceptible to frontrunning — see new_distributor.rs for details.
    #[allow(clippy::result_large_err)]
    pub fn new_distributor(
        ctx: Context<NewDistributor>,
        version: u64,
        root: [u8; 32],
        max_total_claim: u64,
        max_num_nodes: u64,
        start_vesting_ts: i64,
        end_vesting_ts: i64,
        clawback_start_ts: i64,
    ) -> Result<()> {
        handle_new_distributor(
            ctx,
            version,
            root,
            max_total_claim,
            max_num_nodes,
            start_vesting_ts,
            end_vesting_ts,
            clawback_start_ts,
        )
    }

    #[allow(clippy::result_large_err)]
    pub fn new_claim(
        ctx: Context<NewClaim>,
        amount_unlocked: u64,
        amount_locked: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        handle_new_claim(ctx, amount_unlocked, amount_locked, proof)
    }

    #[allow(clippy::result_large_err)]
    pub fn claim_locked(ctx: Context<ClaimLocked>) -> Result<()> {
        handle_claim_locked(ctx)
    }

    #[allow(clippy::result_large_err)]
    pub fn clawback(ctx: Context<Clawback>) -> Result<()> {
        handle_clawback(ctx)
    }

    #[allow(clippy::result_large_err)]
    pub fn set_clawback_receiver(ctx: Context<SetClawbackReceiver>) -> Result<()> {
        handle_set_clawback_receiver(ctx)
    }

    #[allow(clippy::result_large_err)]
    pub fn set_admin(ctx: Context<SetAdmin>) -> Result<()> {
        handle_set_admin(ctx)
    }

    #[allow(clippy::result_large_err)]
    pub fn initialize_fee_config(
        ctx: Context<InitializeFeeConfig>,
        claim_fee: u64,
    ) -> Result<()> {
        handle_initialize_fee_config(ctx, claim_fee)
    }

    #[allow(clippy::result_large_err)]
    pub fn set_claim_fee(ctx: Context<SetClaimFee>, claim_fee: u64) -> Result<()> {
        handle_set_claim_fee(ctx, claim_fee)
    }

    #[allow(clippy::result_large_err)]
    pub fn set_fee_admin(ctx: Context<SetFeeAdmin>) -> Result<()> {
        handle_set_fee_admin(ctx)
    }
}
