extern crate jito_merkle_tree;
extern crate merkle_distributor_fee_task;

use std::path::PathBuf;

use anchor_lang::{prelude::Pubkey, AccountDeserialize, InstructionData, Key, ToAccountMetas};
use anchor_spl::token;
use clap::{Parser, Subcommand};
use jito_merkle_tree::{
    airdrop_merkle_tree::AirdropMerkleTree,
    utils::{get_claim_status_pda, get_merkle_distributor_pda},
};
use merkle_distributor_fee_task::state::{
    fee_config::FeeConfig, merkle_distributor::MerkleDistributor,
};
use solana_program::instruction::Instruction;
use solana_rpc_client::rpc_client::RpcClient;
use solana_sdk::{
    account::Account, commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction, signature::read_keypair_file, signer::Signer,
    transaction::Transaction,
};
use spl_associated_token_account::{
    get_associated_token_address, instruction::create_associated_token_account,
};

fn get_fee_config_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"FeeConfig"], program_id)
}

#[derive(Parser, Debug)]
#[clap(author, version, about = "Merkle Distributor CLI with Fee Management")]
pub struct Args {
    #[clap(subcommand)]
    pub command: Commands,

    /// Airdrop version
    #[clap(long, env, default_value_t = 0)]
    pub airdrop_version: u64,

    /// SPL Mint address
    #[clap(long, env)]
    pub mint: Pubkey,

    /// RPC url
    #[clap(long, env)]
    pub rpc_url: String,

    /// Program id
    #[clap(long, env, default_value_t = merkle_distributor_fee_task::id())]
    pub program_id: Pubkey,

    /// Payer keypair
    #[clap(long, env)]
    pub keypair_path: PathBuf,

    /// Priority fee in microlamports
    #[clap(long, env)]
    pub priority: Option<u64>,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Claim unlocked tokens
    Claim(ClaimArgs),
    /// Create a new instance of a merkle distributor
    NewDistributor(NewDistributorArgs),
    /// Clawback tokens from merkle distributor
    #[clap(hide = true)]
    Clawback(ClawbackArgs),
    /// Create a Merkle tree, given a CSV of recipients
    CreateMerkleTree(CreateMerkleTreeArgs),
    /// Set new admin for a distributor
    SetAdmin(SetAdminArgs),
    /// Initialize the global fee configuration (one-time, run by admin)
    ///
    /// Sets the claim fee amount (in lamports) and the wallet that receives fees.
    /// This can only be called once; use 'set-claim-fee' to update afterwards.
    InitializeFeeConfig(InitializeFeeConfigArgs),
    /// Update the claim fee amount and/or recipient wallet
    ///
    /// Only the admin who initialized the fee config can call this.
    /// Both fee and recipient are updated atomically.
    SetClaimFee(SetClaimFeeArgs),
    /// Transfer fee config admin authority to a new account
    ///
    /// Only the current admin can call this. The new admin will have
    /// full control over fee settings (set_claim_fee, set_fee_admin).
    SetFeeAdmin(SetFeeAdminArgs),
    /// Display the current global fee configuration
    ///
    /// Shows admin, fee amount, recipient, and PDA bump.
    GetFeeConfig,
}

#[derive(Parser, Debug)]
pub struct ClaimArgs {
    #[clap(long, env)]
    pub merkle_tree_path: PathBuf,
}

#[derive(Parser, Debug)]
pub struct NewDistributorArgs {
    #[clap(long, env)]
    pub clawback_receiver_token_account: Pubkey,
    #[clap(long, env)]
    pub start_vesting_ts: i64,
    #[clap(long, env)]
    pub end_vesting_ts: i64,
    #[clap(long, env)]
    pub merkle_tree_path: PathBuf,
    #[clap(long, env)]
    pub clawback_start_ts: i64,
}

#[derive(Parser, Debug)]
pub struct ClawbackArgs {
    #[clap(long, env)]
    pub clawback_keypair_path: PathBuf,
}

#[derive(Parser, Debug)]
pub struct CreateMerkleTreeArgs {
    #[clap(long, env)]
    pub csv_path: PathBuf,
    #[clap(long, env)]
    pub merkle_tree_path: PathBuf,
}

#[derive(Parser, Debug)]
pub struct SetAdminArgs {
    #[clap(long, env)]
    pub new_admin: Pubkey,
}

#[derive(Parser, Debug)]
pub struct SetFeeAdminArgs {
    /// Public key of the new fee config admin
    #[clap(long, env)]
    pub new_admin: Pubkey,
}

#[derive(Parser, Debug)]
pub struct InitializeFeeConfigArgs {
    /// Claim fee in lamports (e.g. 50000000 = 0.05 SOL). Set to 0 to disable fees.
    #[clap(long, env)]
    pub claim_fee: u64,
    /// Wallet address that receives claim fees. Must be a valid non-zero address if claim_fee > 0.
    #[clap(long, env)]
    pub fee_recipient: Pubkey,
}

#[derive(Parser, Debug)]
pub struct SetClaimFeeArgs {
    /// New claim fee in lamports (e.g. 50000000 = 0.05 SOL). Set to 0 to disable fees.
    #[clap(long, env)]
    pub claim_fee: u64,
    /// New wallet address to receive claim fees. Must be non-zero if claim_fee > 0.
    #[clap(long, env)]
    pub fee_recipient: Pubkey,
}

fn main() {
    let args = Args::parse();

    match &args.command {
        Commands::NewDistributor(new_distributor_args) => {
            process_new_distributor(&args, new_distributor_args);
        }
        Commands::Claim(claim_args) => {
            process_claim(&args, claim_args);
        }
        Commands::Clawback(clawback_args) => process_clawback(&args, clawback_args),
        Commands::CreateMerkleTree(merkle_tree_args) => {
            process_create_merkle_tree(merkle_tree_args);
        }
        Commands::SetAdmin(set_admin_args) => {
            process_set_admin(&args, set_admin_args);
        }
        Commands::InitializeFeeConfig(fee_args) => {
            process_initialize_fee_config(&args, fee_args);
        }
        Commands::SetClaimFee(fee_args) => {
            process_set_claim_fee(&args, fee_args);
        }
        Commands::SetFeeAdmin(fee_admin_args) => {
            process_set_fee_admin(&args, fee_admin_args);
        }
        Commands::GetFeeConfig => {
            process_get_fee_config(&args);
        }
    }
}

fn process_new_claim(args: &Args, claim_args: &ClaimArgs) {
    let keypair = read_keypair_file(&args.keypair_path).expect("Failed reading keypair file");
    let claimant = keypair.pubkey();
    println!("Claiming tokens for user {}...", claimant);

    let merkle_tree = AirdropMerkleTree::new_from_file(&claim_args.merkle_tree_path)
        .expect("failed to load merkle tree from file");

    let (distributor, _bump) =
        get_merkle_distributor_pda(&args.program_id, &args.mint, args.airdrop_version);

    let node = merkle_tree.get_node(&claimant);

    let (claim_status_pda, _bump) =
        get_claim_status_pda(&args.program_id, &claimant, &distributor);

    let client = RpcClient::new_with_commitment(&args.rpc_url, CommitmentConfig::confirmed());

    let claimant_ata = get_associated_token_address(&claimant, &args.mint);

    let mut ixs = vec![];

    match client.get_account(&claimant_ata) {
        Ok(_) => {}
        Err(e) => {
            if e.to_string().contains("AccountNotFound") {
                println!("ATA does not exist. creating.");
                let ix =
                    create_associated_token_account(&claimant, &claimant, &args.mint, &token::ID);
                ixs.push(ix);
            } else {
                panic!("Error fetching ATA: {e}")
            }
        }
    }

    let (fee_config_pda, _) = get_fee_config_pda(&args.program_id);
    // Read fee config to get the fee recipient
    let fee_recipient = match client.get_account(&fee_config_pda) {
        Ok(account) => {
            let config = FeeConfig::try_deserialize(&mut account.data.as_slice())
                .expect("Failed to deserialize FeeConfig");
            config.fee_recipient
        }
        Err(_) => fee_config_pda, // Placeholder if not initialized
    };

    let new_claim_ix = Instruction {
        program_id: args.program_id,
        accounts: merkle_distributor_fee_task::accounts::NewClaim {
            distributor,
            claim_status: claim_status_pda,
            from: get_associated_token_address(&distributor, &args.mint),
            to: claimant_ata,
            claimant,
            token_program: token::ID,
            system_program: solana_program::system_program::ID,
            fee_config: fee_config_pda,
            fee_recipient,
        }
        .to_account_metas(None),
        data: merkle_distributor_fee_task::instruction::NewClaim {
            amount_unlocked: node.amount_unlocked(),
            amount_locked: node.amount_locked(),
            proof: node.proof.expect("proof not found"),
        }
        .data(),
    };

    ixs.push(new_claim_ix);

    let blockhash = client.get_latest_blockhash().unwrap();
    let tx =
        Transaction::new_signed_with_payer(&ixs, Some(&claimant.key()), &[&keypair], blockhash);

    let signature = client
        .send_and_confirm_transaction_with_spinner(&tx)
        .unwrap();
    println!("successfully created new claim with signature {signature:#?}");
}

fn process_claim(args: &Args, claim_args: &ClaimArgs) {
    let keypair = read_keypair_file(&args.keypair_path).expect("Failed reading keypair file");
    let claimant = keypair.pubkey();

    let priority_fee = args.priority.unwrap_or(0);

    let (distributor, bump) =
        get_merkle_distributor_pda(&args.program_id, &args.mint, args.airdrop_version);
    println!("distributor pubkey {}", distributor);

    let (claim_status_pda, _bump) =
        get_claim_status_pda(&args.program_id, &claimant, &distributor);
    println!("claim pda: {claim_status_pda}, bump: {bump}");

    let client = RpcClient::new_with_commitment(&args.rpc_url, CommitmentConfig::confirmed());

    match client.get_account(&claim_status_pda) {
        Ok(_) => {}
        Err(e) => {
            if e.to_string().contains("AccountNotFound") {
                println!("PDA does not exist. creating.");
                process_new_claim(args, claim_args);
            } else {
                panic!("error getting PDA: {e}")
            }
        }
    }

    let claimant_ata = get_associated_token_address(&claimant, &args.mint);

    let (fee_config_pda, _) = get_fee_config_pda(&args.program_id);
    let fee_recipient = match client.get_account(&fee_config_pda) {
        Ok(account) => {
            let config = FeeConfig::try_deserialize(&mut account.data.as_slice())
                .expect("Failed to deserialize FeeConfig");
            config.fee_recipient
        }
        Err(_) => fee_config_pda,
    };

    let mut ixs = vec![];

    let claim_ix = Instruction {
        program_id: args.program_id,
        accounts: merkle_distributor_fee_task::accounts::ClaimLocked {
            distributor,
            claim_status: claim_status_pda,
            from: get_associated_token_address(&distributor, &args.mint),
            to: claimant_ata,
            claimant,
            token_program: token::ID,
            fee_config: fee_config_pda,
            fee_recipient,
            system_program: solana_program::system_program::ID,
        }
        .to_account_metas(None),
        data: merkle_distributor_fee_task::instruction::ClaimLocked {}.data(),
    };
    ixs.push(claim_ix);

    if priority_fee > 0 {
        let instruction = ComputeBudgetInstruction::set_compute_unit_price(priority_fee);
        ixs.push(instruction);
        println!(
            "Added priority fee instruction of {} microlamports",
            priority_fee
        );
    }

    let blockhash = client.get_latest_blockhash().unwrap();
    let tx =
        Transaction::new_signed_with_payer(&ixs, Some(&claimant.key()), &[&keypair], blockhash);

    let signature = client
        .send_and_confirm_transaction_with_spinner(&tx)
        .unwrap();
    println!("successfully claimed tokens with signature {signature:#?}");
}

fn check_distributor_onchain_matches(
    account: &Account,
    merkle_tree: &AirdropMerkleTree,
    new_distributor_args: &NewDistributorArgs,
    pubkey: Pubkey,
) -> Result<(), &'static str> {
    if let Ok(distributor) = MerkleDistributor::try_deserialize(&mut account.data.as_slice()) {
        if distributor.root != merkle_tree.merkle_root {
            return Err("root mismatch");
        }
        if distributor.max_total_claim != merkle_tree.max_total_claim {
            return Err("max_total_claim mismatch");
        }
        if distributor.max_num_nodes != merkle_tree.max_num_nodes {
            return Err("max_num_nodes mismatch");
        }
        if distributor.start_ts != new_distributor_args.start_vesting_ts {
            return Err("start_ts mismatch");
        }
        if distributor.end_ts != new_distributor_args.end_vesting_ts {
            return Err("end_ts mismatch");
        }
        if distributor.clawback_start_ts != new_distributor_args.clawback_start_ts {
            return Err("clawback_start_ts mismatch");
        }
        if distributor.clawback_receiver != new_distributor_args.clawback_receiver_token_account {
            return Err("clawback_receiver mismatch");
        }
        if distributor.admin != pubkey {
            return Err("admin mismatch");
        }
    }
    Ok(())
}

fn process_new_distributor(args: &Args, new_distributor_args: &NewDistributorArgs) {
    let client = RpcClient::new_with_commitment(&args.rpc_url, CommitmentConfig::finalized());

    let keypair = read_keypair_file(&args.keypair_path).expect("Failed reading keypair file");
    let merkle_tree = AirdropMerkleTree::new_from_file(&new_distributor_args.merkle_tree_path)
        .expect("failed to read");
    let (distributor_pubkey, _bump) =
        get_merkle_distributor_pda(&args.program_id, &args.mint, args.airdrop_version);
    let token_vault = get_associated_token_address(&distributor_pubkey, &args.mint);

    if let Some(account) = client
        .get_account_with_commitment(&distributor_pubkey, CommitmentConfig::confirmed())
        .unwrap()
        .value
    {
        println!("merkle distributor account exists, checking parameters...");
        check_distributor_onchain_matches(
            &account,
            &merkle_tree,
            new_distributor_args,
            keypair.pubkey(),
        )
        .expect("on-chain params do not match!");
    }

    println!("creating new distributor with args: {new_distributor_args:#?}");

    let new_distributor_ix = Instruction {
        program_id: args.program_id,
        accounts: merkle_distributor_fee_task::accounts::NewDistributor {
            clawback_receiver: new_distributor_args.clawback_receiver_token_account,
            mint: args.mint,
            token_vault,
            distributor: distributor_pubkey,
            system_program: solana_program::system_program::id(),
            associated_token_program: spl_associated_token_account::ID,
            token_program: token::ID,
            admin: keypair.pubkey(),
        }
        .to_account_metas(None),
        data: merkle_distributor_fee_task::instruction::NewDistributor {
            version: args.airdrop_version,
            root: merkle_tree.merkle_root,
            max_total_claim: merkle_tree.max_total_claim,
            max_num_nodes: merkle_tree.max_num_nodes,
            start_vesting_ts: new_distributor_args.start_vesting_ts,
            end_vesting_ts: new_distributor_args.end_vesting_ts,
            clawback_start_ts: new_distributor_args.clawback_start_ts,
        }
        .data(),
    };

    let blockhash = client.get_latest_blockhash().unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[new_distributor_ix],
        Some(&keypair.pubkey()),
        &[&keypair],
        blockhash,
    );

    match client.send_and_confirm_transaction_with_spinner(&tx) {
        Ok(sig) => println!("Successfully created distributor! signature: {sig:#?}"),
        Err(e) => {
            println!("Failed to create MerkleDistributor: {:?}", e);
            if let Some(account) = client
                .get_account_with_commitment(&distributor_pubkey, CommitmentConfig::processed())
                .unwrap()
                .value
            {
                check_distributor_onchain_matches(
                    &account,
                    &merkle_tree,
                    new_distributor_args,
                    keypair.pubkey(),
                )
                .expect("on-chain params do not match!");
            }
        }
    }
}

fn process_clawback(args: &Args, clawback_args: &ClawbackArgs) {
    let payer_keypair =
        read_keypair_file(&args.keypair_path).expect("Failed reading keypair file");
    let clawback_keypair = read_keypair_file(&clawback_args.clawback_keypair_path)
        .expect("Failed reading keypair file");

    let clawback_ata = get_associated_token_address(&clawback_keypair.pubkey(), &args.mint);

    let client = RpcClient::new_with_commitment(&args.rpc_url, CommitmentConfig::confirmed());

    let (distributor, _bump) =
        get_merkle_distributor_pda(&args.program_id, &args.mint, args.airdrop_version);

    let from = get_associated_token_address(&distributor, &args.mint);

    let clawback_ix = Instruction {
        program_id: args.program_id,
        accounts: merkle_distributor_fee_task::accounts::Clawback {
            distributor,
            from,
            to: clawback_ata,
            claimant: clawback_keypair.pubkey(),
            system_program: solana_program::system_program::ID,
            token_program: token::ID,
        }
        .to_account_metas(None),
        data: merkle_distributor_fee_task::instruction::Clawback {}.data(),
    };

    let tx = Transaction::new_signed_with_payer(
        &[clawback_ix],
        Some(&payer_keypair.pubkey()),
        &[&payer_keypair, &clawback_keypair],
        client.get_latest_blockhash().unwrap(),
    );

    let signature = client
        .send_and_confirm_transaction_with_spinner(&tx)
        .unwrap();
    println!("Successfully clawed back funds! signature: {signature:#?}");
}

fn process_create_merkle_tree(merkle_tree_args: &CreateMerkleTreeArgs) {
    let merkle_tree = AirdropMerkleTree::new_from_csv(&merkle_tree_args.csv_path).unwrap();
    merkle_tree.write_to_file(&merkle_tree_args.merkle_tree_path);
    println!("Merkle tree written to {:?}", merkle_tree_args.merkle_tree_path);
}

fn process_set_admin(args: &Args, set_admin_args: &SetAdminArgs) {
    let keypair = read_keypair_file(&args.keypair_path).expect("Failed reading keypair file");

    let client = RpcClient::new_with_commitment(&args.rpc_url, CommitmentConfig::confirmed());

    let (distributor, _bump) =
        get_merkle_distributor_pda(&args.program_id, &args.mint, args.airdrop_version);

    let set_admin_ix = Instruction {
        program_id: args.program_id,
        accounts: merkle_distributor_fee_task::accounts::SetAdmin {
            distributor,
            admin: keypair.pubkey(),
            new_admin: set_admin_args.new_admin,
        }
        .to_account_metas(None),
        data: merkle_distributor_fee_task::instruction::SetAdmin {}.data(),
    };

    let tx = Transaction::new_signed_with_payer(
        &[set_admin_ix],
        Some(&keypair.pubkey()),
        &[&keypair],
        client.get_latest_blockhash().unwrap(),
    );

    let signature = client
        .send_and_confirm_transaction_with_spinner(&tx)
        .unwrap();
    println!("Successfully set admin! signature: {signature:#?}");
}

// ── Fee Management Commands ──────────────────────��───────────────────────

fn process_initialize_fee_config(args: &Args, fee_args: &InitializeFeeConfigArgs) {
    let keypair = match read_keypair_file(&args.keypair_path) {
        Ok(kp) => kp,
        Err(e) => {
            eprintln!("Error: Could not read keypair file at {:?}: {}", args.keypair_path, e);
            eprintln!("Hint: Use --keypair-path to specify your Solana keypair file (usually ~/.config/solana/id.json)");
            std::process::exit(1);
        }
    };

    // Validate: positive fee requires non-zero recipient
    if fee_args.claim_fee > 0 && fee_args.fee_recipient == Pubkey::default() {
        eprintln!("Error: Cannot set a positive claim fee with a zero-address fee recipient.");
        eprintln!("Hint: Provide a valid --fee-recipient wallet address, or set --claim-fee 0 to disable fees.");
        std::process::exit(1);
    }

    let client = RpcClient::new_with_commitment(&args.rpc_url, CommitmentConfig::confirmed());

    let (fee_config_pda, _) = get_fee_config_pda(&args.program_id);

    // Check if already initialized
    if let Ok(_acct) = client.get_account(&fee_config_pda) {
        eprintln!("Error: Fee config is already initialized at {}", fee_config_pda);
        eprintln!("Hint: Use 'set-claim-fee' to update the existing fee configuration.");
        std::process::exit(1);
    }

    let ix = Instruction {
        program_id: args.program_id,
        accounts: merkle_distributor_fee_task::accounts::InitializeFeeConfig {
            fee_config: fee_config_pda,
            admin: keypair.pubkey(),
            fee_recipient: fee_args.fee_recipient,
            system_program: solana_program::system_program::ID,
        }
        .to_account_metas(None),
        data: merkle_distributor_fee_task::instruction::InitializeFeeConfig {
            claim_fee: fee_args.claim_fee,
        }
        .data(),
    };

    let blockhash = match client.get_latest_blockhash() {
        Ok(bh) => bh,
        Err(e) => {
            eprintln!("Error: Could not connect to RPC at {}: {}", args.rpc_url, e);
            eprintln!("Hint: Check that your validator is running and --rpc-url is correct.");
            std::process::exit(1);
        }
    };

    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&keypair.pubkey()),
        &[&keypair],
        blockhash,
    );

    match client.send_and_confirm_transaction_with_spinner(&tx) {
        Ok(signature) => {
            println!(
                "Fee config initialized! fee={} lamports, recipient={}\nsignature: {signature:#?}",
                fee_args.claim_fee, fee_args.fee_recipient
            );
        }
        Err(e) => {
            eprintln!("Error: Transaction failed: {e}");
            if format!("{e}").contains("already in use") {
                eprintln!("Hint: Fee config already exists. Use 'set-claim-fee' to update it.");
            }
            std::process::exit(1);
        }
    }
}

fn process_set_claim_fee(args: &Args, fee_args: &SetClaimFeeArgs) {
    let keypair = match read_keypair_file(&args.keypair_path) {
        Ok(kp) => kp,
        Err(e) => {
            eprintln!("Error: Could not read keypair file at {:?}: {}", args.keypair_path, e);
            eprintln!("Hint: Use --keypair-path to specify your Solana keypair file (usually ~/.config/solana/id.json)");
            std::process::exit(1);
        }
    };

    // Validate: positive fee requires non-zero recipient
    if fee_args.claim_fee > 0 && fee_args.fee_recipient == Pubkey::default() {
        eprintln!("Error: Cannot set a positive claim fee with a zero-address fee recipient.");
        eprintln!("Hint: Provide a valid --fee-recipient wallet address, or set --claim-fee 0 to disable fees.");
        std::process::exit(1);
    }

    let client = RpcClient::new_with_commitment(&args.rpc_url, CommitmentConfig::confirmed());

    let (fee_config_pda, _) = get_fee_config_pda(&args.program_id);

    // Verify fee config exists before trying to update
    if client.get_account(&fee_config_pda).is_err() {
        eprintln!("Error: Fee config has not been initialized yet.");
        eprintln!("Hint: Run 'initialize-fee-config' first to create the fee configuration.");
        std::process::exit(1);
    }

    let ix = Instruction {
        program_id: args.program_id,
        accounts: merkle_distributor_fee_task::accounts::SetClaimFee {
            fee_config: fee_config_pda,
            admin: keypair.pubkey(),
            new_fee_recipient: fee_args.fee_recipient,
        }
        .to_account_metas(None),
        data: merkle_distributor_fee_task::instruction::SetClaimFee {
            claim_fee: fee_args.claim_fee,
        }
        .data(),
    };

    let blockhash = match client.get_latest_blockhash() {
        Ok(bh) => bh,
        Err(e) => {
            eprintln!("Error: Could not connect to RPC at {}: {}", args.rpc_url, e);
            std::process::exit(1);
        }
    };

    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&keypair.pubkey()),
        &[&keypair],
        blockhash,
    );

    match client.send_and_confirm_transaction_with_spinner(&tx) {
        Ok(signature) => {
            println!(
                "Claim fee updated! fee={} lamports, recipient={}\nsignature: {signature:#?}",
                fee_args.claim_fee, fee_args.fee_recipient
            );
        }
        Err(e) => {
            let err_str = format!("{e}");
            eprintln!("Error: Transaction failed: {e}");
            if err_str.contains("ConstraintAddress") || err_str.contains("Unauthorized") {
                eprintln!("Hint: Only the fee config admin can update the fee. Check that your --keypair-path matches the admin key.");
            }
            std::process::exit(1);
        }
    }
}

fn process_set_fee_admin(args: &Args, fee_admin_args: &SetFeeAdminArgs) {
    let keypair = match read_keypair_file(&args.keypair_path) {
        Ok(kp) => kp,
        Err(e) => {
            eprintln!("Error: Could not read keypair file at {:?}: {}", args.keypair_path, e);
            eprintln!("Hint: Use --keypair-path to specify your Solana keypair file (usually ~/.config/solana/id.json)");
            std::process::exit(1);
        }
    };

    if keypair.pubkey() == fee_admin_args.new_admin {
        eprintln!("Error: New admin is the same as the current admin.");
        eprintln!("Hint: Provide a different --new-admin public key.");
        std::process::exit(1);
    }

    let client = RpcClient::new_with_commitment(&args.rpc_url, CommitmentConfig::confirmed());

    let (fee_config_pda, _) = get_fee_config_pda(&args.program_id);

    // Verify fee config exists
    if client.get_account(&fee_config_pda).is_err() {
        eprintln!("Error: Fee config has not been initialized yet.");
        eprintln!("Hint: Run 'initialize-fee-config' first to create the fee configuration.");
        std::process::exit(1);
    }

    let ix = Instruction {
        program_id: args.program_id,
        accounts: merkle_distributor_fee_task::accounts::SetFeeAdmin {
            fee_config: fee_config_pda,
            admin: keypair.pubkey(),
            new_admin: fee_admin_args.new_admin,
        }
        .to_account_metas(None),
        data: merkle_distributor_fee_task::instruction::SetFeeAdmin {}.data(),
    };

    let blockhash = match client.get_latest_blockhash() {
        Ok(bh) => bh,
        Err(e) => {
            eprintln!("Error: Could not connect to RPC at {}: {}", args.rpc_url, e);
            std::process::exit(1);
        }
    };

    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&keypair.pubkey()),
        &[&keypair],
        blockhash,
    );

    match client.send_and_confirm_transaction_with_spinner(&tx) {
        Ok(signature) => {
            println!(
                "Fee admin transferred to {}\nsignature: {signature:#?}",
                fee_admin_args.new_admin
            );
        }
        Err(e) => {
            let err_str = format!("{e}");
            eprintln!("Error: Transaction failed: {e}");
            if err_str.contains("ConstraintAddress") || err_str.contains("Unauthorized") {
                eprintln!("Hint: Only the current fee config admin can transfer authority. Check that your --keypair-path matches the admin key.");
            }
            std::process::exit(1);
        }
    }
}

fn process_get_fee_config(args: &Args) {
    let client = RpcClient::new_with_commitment(&args.rpc_url, CommitmentConfig::confirmed());

    let (fee_config_pda, _) = get_fee_config_pda(&args.program_id);

    match client.get_account(&fee_config_pda) {
        Ok(account) => {
            match FeeConfig::try_deserialize(&mut account.data.as_slice()) {
                Ok(config) => {
                    println!("Fee Configuration:");
                    println!("  Admin:         {}", config.admin);
                    println!("  Claim Fee:     {} lamports", config.claim_fee);
                    println!("  Fee Recipient: {}", config.fee_recipient);
                    println!("  Bump:          {}", config.bump);
                }
                Err(e) => {
                    eprintln!("Error: Could not deserialize FeeConfig account: {e}");
                    eprintln!("Hint: The account at {} exists but does not contain valid FeeConfig data. Check --program-id.", fee_config_pda);
                    std::process::exit(1);
                }
            }
        }
        Err(_) => {
            eprintln!("Fee config has not been initialized.");
            eprintln!("Hint: Run 'initialize-fee-config --claim-fee <LAMPORTS> --fee-recipient <PUBKEY>' to set up fee collection.");
            std::process::exit(1);
        }
    }
}
