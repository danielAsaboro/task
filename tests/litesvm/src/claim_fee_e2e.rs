/// End-to-end LiteSVM integration tests for the Merkle Distributor claim fee lifecycle.
///
/// Covers: immediate unlock with fee, cliff vesting (deferred fee), linear vesting,
/// zero-fee path, wrong fee_recipient, insufficient SOL, double-claim prevention,
/// fee-not-double-charged, claim_locked before vesting, admin fee changes between claims,
/// and fee_config bypass attempts.
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey as Address;
use solana_signer::Signer;
use solana_transaction::Transaction;

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
const FEE_AMOUNT: u64 = 5_000_000; // 0.005 SOL

fn program_id() -> Address {
    "Ah7iuugan983ymZAKJAFAdvPN3My7ESkGUARrFTn3iqM"
        .parse()
        .unwrap()
}
fn system_program_id() -> Address {
    "11111111111111111111111111111111".parse().unwrap()
}
fn token_program_id() -> Address {
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        .parse()
        .unwrap()
}
fn ata_program_id() -> Address {
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        .parse()
        .unwrap()
}

// ────────────────────────────────────────────────────────────────────────────
// Anchor helpers
// ────────────────────────────────────────────────────────────────────────────

fn anchor_disc(name: &str) -> [u8; 8] {
    let hash = Sha256::digest(format!("global:{}", name).as_bytes());
    let mut d = [0u8; 8];
    d.copy_from_slice(&hash[..8]);
    d
}

// ────────────────────────────────────────────────────────────────────────────
// PDA derivations
// ────────────────────────────────────────────────────────────────────────────

fn fee_config_pda() -> (Address, u8) {
    Address::find_program_address(&[b"FeeConfig"], &program_id())
}

fn distributor_pda(mint: &Address, version: u64) -> (Address, u8) {
    Address::find_program_address(
        &[
            b"MerkleDistributor",
            mint.as_ref(),
            &version.to_le_bytes(),
        ],
        &program_id(),
    )
}

fn claim_status_pda(claimant: &Address, distributor: &Address) -> (Address, u8) {
    Address::find_program_address(
        &[b"ClaimStatus", claimant.as_ref(), distributor.as_ref()],
        &program_id(),
    )
}

fn ata_address(owner: &Address, mint: &Address) -> (Address, u8) {
    Address::find_program_address(
        &[owner.as_ref(), token_program_id().as_ref(), mint.as_ref()],
        &ata_program_id(),
    )
}

// ────────────────────────────────────────────────────────────────────────────
// Merkle root for single-leaf tree
// ────────────────────────────────────────────────────────────────────────────

fn compute_root(claimant: &Address, amount_unlocked: u64, amount_locked: u64) -> [u8; 32] {
    let inner = Sha256::new()
        .chain_update(claimant.as_ref())
        .chain_update(amount_unlocked.to_le_bytes())
        .chain_update(amount_locked.to_le_bytes())
        .finalize();
    let leaf = Sha256::new()
        .chain_update([0u8])
        .chain_update(inner)
        .finalize();
    let mut root = [0u8; 32];
    root.copy_from_slice(&leaf);
    root
}

// ────────────────────────────────────────────────────────────────────────────
// Raw SPL token account creation via set_account
// ────────────────────────────────────────────────────────────────────────────

/// Build 82-byte Mint account data (SPL Token layout).
fn mint_data(decimals: u8, mint_authority: Option<&Address>, supply: u64) -> Vec<u8> {
    let mut buf = vec![0u8; 82];
    // COption<Pubkey> for mint_authority (4 + 32)
    match mint_authority {
        Some(auth) => {
            buf[0..4].copy_from_slice(&1u32.to_le_bytes()); // Some
            buf[4..36].copy_from_slice(auth.as_ref());
        }
        None => {
            buf[0..4].copy_from_slice(&0u32.to_le_bytes()); // None
            // 4..36 stays zero
        }
    }
    // supply: u64 at offset 36
    buf[36..44].copy_from_slice(&supply.to_le_bytes());
    // decimals: u8 at offset 44
    buf[44] = decimals;
    // is_initialized: bool at offset 45
    buf[45] = 1;
    // COption<Pubkey> freeze_authority (4 + 32) at offset 46..82 — leave None (zeros)
    buf
}

/// Build 165-byte TokenAccount data (SPL Token layout).
fn token_account_data(mint: &Address, owner: &Address, amount: u64) -> Vec<u8> {
    let mut buf = vec![0u8; 165];
    buf[0..32].copy_from_slice(mint.as_ref()); // mint
    buf[32..64].copy_from_slice(owner.as_ref()); // owner
    buf[64..72].copy_from_slice(&amount.to_le_bytes()); // amount
    // delegate COption: None (4 bytes zero) at 72..76
    // delegate Pubkey: 32 bytes zero at 76..108
    buf[108] = 1; // state = Initialized (AccountState::Initialized = 1)
    // is_native COption: None at 109..113
    // is_native u64: at 113..121
    // delegated_amount: at 121..129
    // close_authority COption: None at 129..133
    // close_authority Pubkey: at 133..165
    buf
}

/// Place a Mint account into the SVM.
fn create_mint(
    svm: &mut LiteSVM,
    mint_address: Address,
    mint_authority: Option<&Address>,
    supply: u64,
) {
    let data = mint_data(6, mint_authority, supply);
    let rent = svm.minimum_balance_for_rent_exemption(data.len());
    let acct = Account {
        lamports: rent,
        data,
        owner: token_program_id(),
        executable: false,
        rent_epoch: 0,
    };
    svm.set_account(mint_address, acct).unwrap();
}

/// Place a TokenAccount into the SVM.
fn create_token_account(
    svm: &mut LiteSVM,
    address: Address,
    mint: &Address,
    owner: &Address,
    amount: u64,
) {
    let data = token_account_data(mint, owner, amount);
    let rent = svm.minimum_balance_for_rent_exemption(data.len());
    let acct = Account {
        lamports: rent,
        data,
        owner: token_program_id(),
        executable: false,
        rent_epoch: 0,
    };
    svm.set_account(address, acct).unwrap();
}

// ────────────────────────────────────────────────────────────────────────────
// SVM bootstrap
// ────────────────────────────────────────────────────────────────────────────

fn load_program() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/merkle_distributor_fee_task.so"
    ))
    .expect("Failed to read .so - run `anchor build` first")
}

fn setup_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(program_id(), &load_program())
        .expect("failed to load program");
    svm
}

/// Set the SVM clock to a specific unix timestamp.
fn warp_clock(svm: &mut LiteSVM, unix_ts: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = unix_ts;
    svm.set_sysvar::<Clock>(&clock);
}

// ────────────────────────────────────────────────────────────────────────────
// Transaction helpers
// ────────────────────────────────────────────────────────────────────────────

fn send_ix(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair) -> Result<(), String> {
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &bh);
    let mut tx = Transaction::new_unsigned(msg);
    tx.sign(&[payer], bh);
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?}", e))
}

// ────────────────────────────────────────────────────────────────────────────
// Instruction builders
// ────────────────────────────────────────────────────────────────────────────

fn ix_init_fee(admin: &Address, recipient: &Address, fee: u64) -> Instruction {
    let (pda, _) = fee_config_pda();
    let mut data = anchor_disc("initialize_fee_config").to_vec();
    data.extend_from_slice(&fee.to_le_bytes());
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(pda, false),
            AccountMeta::new(*admin, true),
            AccountMeta::new_readonly(*recipient, false),
            AccountMeta::new_readonly(system_program_id(), false),
        ],
        data,
    }
}

fn ix_set_fee(admin: &Address, recipient: &Address, fee: u64) -> Instruction {
    let (pda, _) = fee_config_pda();
    let mut data = anchor_disc("set_claim_fee").to_vec();
    data.extend_from_slice(&fee.to_le_bytes());
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(pda, false),
            AccountMeta::new_readonly(*admin, true),
            AccountMeta::new_readonly(*recipient, false),
        ],
        data,
    }
}

fn ix_new_distributor(
    admin: &Address,
    mint: &Address,
    clawback_receiver: &Address,
    version: u64,
    root: [u8; 32],
    max_total_claim: u64,
    max_num_nodes: u64,
    start_vesting_ts: i64,
    end_vesting_ts: i64,
    clawback_start_ts: i64,
) -> Instruction {
    let (distributor, _) = distributor_pda(mint, version);
    let (token_vault, _) = ata_address(&distributor, mint);

    let mut data = anchor_disc("new_distributor").to_vec();
    data.extend_from_slice(&version.to_le_bytes());
    data.extend_from_slice(&root);
    data.extend_from_slice(&max_total_claim.to_le_bytes());
    data.extend_from_slice(&max_num_nodes.to_le_bytes());
    data.extend_from_slice(&start_vesting_ts.to_le_bytes());
    data.extend_from_slice(&end_vesting_ts.to_le_bytes());
    data.extend_from_slice(&clawback_start_ts.to_le_bytes());

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(distributor, false),
            AccountMeta::new(*clawback_receiver, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(token_vault, false),
            AccountMeta::new(*admin, true),
            AccountMeta::new_readonly(system_program_id(), false),
            AccountMeta::new_readonly(ata_program_id(), false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data,
    }
}

fn ix_new_claim(
    distributor: &Address,
    claimant: &Address,
    claimant_token_account: &Address,
    mint: &Address,
    fee_recipient: &Address,
    amount_unlocked: u64,
    amount_locked: u64,
    proof: Vec<[u8; 32]>,
) -> Instruction {
    let (claim_status, _) = claim_status_pda(claimant, distributor);
    let (token_vault, _) = ata_address(distributor, mint);
    let (fee_config, _) = fee_config_pda();

    let mut data = anchor_disc("new_claim").to_vec();
    data.extend_from_slice(&amount_unlocked.to_le_bytes());
    data.extend_from_slice(&amount_locked.to_le_bytes());
    // Borsh Vec: 4-byte length prefix then elements
    data.extend_from_slice(&(proof.len() as u32).to_le_bytes());
    for p in &proof {
        data.extend_from_slice(p);
    }

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*distributor, false),
            AccountMeta::new(claim_status, false),
            AccountMeta::new(token_vault, false),
            AccountMeta::new(*claimant_token_account, false),
            AccountMeta::new(*claimant, true),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(system_program_id(), false),
            AccountMeta::new_readonly(fee_config, false),
            AccountMeta::new(*fee_recipient, false),
        ],
        data,
    }
}

fn ix_claim_locked(
    distributor: &Address,
    claimant: &Address,
    claimant_token_account: &Address,
    mint: &Address,
    fee_recipient: &Address,
) -> Instruction {
    let (claim_status, _) = claim_status_pda(claimant, distributor);
    let (token_vault, _) = ata_address(distributor, mint);
    let (fee_config, _) = fee_config_pda();

    let data = anchor_disc("claim_locked").to_vec();

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*distributor, false),
            AccountMeta::new(claim_status, false),
            AccountMeta::new(token_vault, false),
            AccountMeta::new(*claimant_token_account, false),
            AccountMeta::new(*claimant, true),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(fee_config, false),
            AccountMeta::new(*fee_recipient, false),
            AccountMeta::new_readonly(system_program_id(), false),
        ],
        data,
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Account data readers
// ────────────────────────────────────────────────────────────────────────────

/// Parse ClaimStatus on-chain data. Layout (after 8-byte discriminator):
///   claimant: Pubkey(32) | locked_amount: u64(8) | locked_amount_withdrawn: u64(8) |
///   unlocked_amount: u64(8) | fee_paid: bool(1)
#[allow(dead_code)]
struct ClaimStatusData {
    claimant: Address,
    locked_amount: u64,
    locked_amount_withdrawn: u64,
    unlocked_amount: u64,
    fee_paid: bool,
}

fn parse_claim_status(data: &[u8]) -> ClaimStatusData {
    let claimant = Address::from(<[u8; 32]>::try_from(&data[8..40]).unwrap());
    let locked_amount = u64::from_le_bytes(data[40..48].try_into().unwrap());
    let locked_amount_withdrawn = u64::from_le_bytes(data[48..56].try_into().unwrap());
    let unlocked_amount = u64::from_le_bytes(data[56..64].try_into().unwrap());
    let fee_paid = data[64] != 0;
    ClaimStatusData {
        claimant,
        locked_amount,
        locked_amount_withdrawn,
        unlocked_amount,
        fee_paid,
    }
}

/// Read the amount field from an SPL TokenAccount (offset 64..72).
fn read_token_balance(svm: &LiteSVM, address: &Address) -> u64 {
    let acct = svm.get_account(address).expect("token account not found");
    u64::from_le_bytes(acct.data[64..72].try_into().unwrap())
}

// ────────────────────────────────────────────────────────────────────────────
// Composite helper: full environment setup for a claim test
// ────────────────────────────────────────────────────────────────────────────

#[allow(dead_code)]
struct TestEnv {
    svm: LiteSVM,
    admin: Keypair,
    fee_recipient: Keypair,
    mint: Keypair,
    version: u64,
    distributor: Address,
}

/// Bootstraps: SVM + program, fee_config, mint, distributor, funded token vault.
/// `now` is the clock timestamp to set before creating the distributor.
/// Returns the environment for further claim operations.
fn bootstrap_env(
    fee: u64,
    amount_unlocked: u64,
    amount_locked: u64,
    claimant: &Address,
    now: i64,
    start_vesting_ts: i64,
    end_vesting_ts: i64,
) -> TestEnv {
    let mut svm = setup_svm();
    warp_clock(&mut svm, now);

    let admin = Keypair::new();
    let fee_recipient = Keypair::new();
    let mint = Keypair::new();
    let version: u64 = 0;

    svm.airdrop(&admin.pubkey(), 10 * LAMPORTS_PER_SOL)
        .unwrap();

    // 1. Initialize fee config
    send_ix(
        &mut svm,
        ix_init_fee(&admin.pubkey(), &fee_recipient.pubkey(), fee),
        &admin,
    )
    .unwrap();

    // 2. Create mint
    let total_tokens = amount_unlocked + amount_locked;
    create_mint(&mut svm, mint.pubkey(), Some(&admin.pubkey()), total_tokens);

    // 3. Create clawback_receiver token account (owned by admin)
    let clawback_receiver_ata = Keypair::new();
    create_token_account(
        &mut svm,
        clawback_receiver_ata.pubkey(),
        &mint.pubkey(),
        &admin.pubkey(),
        0,
    );

    // 4. Compute root for this single claimant
    let root = compute_root(claimant, amount_unlocked, amount_locked);

    // clawback must be > end_vesting + 1 day
    let clawback_start_ts = end_vesting_ts + 86_400 + 1;

    // 5. Create distributor
    send_ix(
        &mut svm,
        ix_new_distributor(
            &admin.pubkey(),
            &mint.pubkey(),
            &clawback_receiver_ata.pubkey(),
            version,
            root,
            total_tokens,
            10, // max_num_nodes
            start_vesting_ts,
            end_vesting_ts,
            clawback_start_ts,
        ),
        &admin,
    )
    .unwrap();

    let (distributor, _) = distributor_pda(&mint.pubkey(), version);

    // 6. Fund the token vault (the ATA of the distributor)
    let (token_vault, _) = ata_address(&distributor, &mint.pubkey());
    // We need to overwrite the token vault amount with actual tokens.
    // The ATA was created by new_distributor via init ATA, but with 0 balance.
    // We set it directly to total_tokens.
    {
        let mut vault_acct = svm.get_account(&token_vault).expect("vault must exist");
        // Overwrite amount at offset 64..72
        vault_acct.data[64..72].copy_from_slice(&total_tokens.to_le_bytes());
        svm.set_account(token_vault, vault_acct).unwrap();
    }

    TestEnv {
        svm,
        admin,
        fee_recipient,
        mint,
        version,
        distributor,
    }
}

/// Create and fund a claimant with a token account, returning their token ATA address.
fn setup_claimant(
    svm: &mut LiteSVM,
    claimant: &Keypair,
    mint: &Address,
    sol_amount: u64,
) -> Address {
    svm.airdrop(&claimant.pubkey(), sol_amount).unwrap();
    let claimant_ata = Keypair::new();
    create_token_account(svm, claimant_ata.pubkey(), mint, &claimant.pubkey(), 0);
    claimant_ata.pubkey()
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

// ── 1. Happy Path: Immediate Unlock with Fee ────────────────────────────────

#[test]
fn test_immediate_claim_collects_fee() {
    let claimant = Keypair::new();
    let amount_unlocked = 1_000u64;
    let amount_locked = 0u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut env = bootstrap_env(
        FEE_AMOUNT,
        amount_unlocked,
        amount_locked,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    let fee_recipient_balance_before = env
        .svm
        .get_balance(&env.fee_recipient.pubkey())
        .unwrap_or(0);

    // Execute new_claim
    send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
            amount_unlocked,
            amount_locked,
            vec![],
        ),
        &claimant,
    )
    .expect("new_claim should succeed");

    // Verify fee_paid = true
    let (cs_addr, _) = claim_status_pda(&claimant.pubkey(), &env.distributor);
    let cs_acct = env.svm.get_account(&cs_addr).unwrap();
    let cs = parse_claim_status(&cs_acct.data);
    assert!(cs.fee_paid, "fee_paid should be true after immediate claim");

    // Verify fee_recipient received fee
    let fee_recipient_balance_after = env
        .svm
        .get_balance(&env.fee_recipient.pubkey())
        .unwrap_or(0);
    assert_eq!(
        fee_recipient_balance_after - fee_recipient_balance_before,
        FEE_AMOUNT,
        "fee_recipient should receive exactly the fee amount"
    );

    // Verify claimant received tokens
    let token_balance = read_token_balance(&env.svm, &claimant_ata);
    assert_eq!(
        token_balance, amount_unlocked,
        "claimant should receive unlocked tokens"
    );
}

// ── 2. Happy Path: Cliff Vesting (fee deferred to claim_locked) ─────────────

#[test]
fn test_cliff_vesting_fee_deferred() {
    let claimant = Keypair::new();
    let amount_unlocked = 0u64;
    let amount_locked = 1_000u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut env = bootstrap_env(
        FEE_AMOUNT,
        amount_unlocked,
        amount_locked,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    let fee_recipient_balance_before = env
        .svm
        .get_balance(&env.fee_recipient.pubkey())
        .unwrap_or(0);

    // new_claim with 0 unlocked => no fee charged
    send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
            amount_unlocked,
            amount_locked,
            vec![],
        ),
        &claimant,
    )
    .expect("new_claim should succeed");

    // Verify fee_paid = false
    let (cs_addr, _) = claim_status_pda(&claimant.pubkey(), &env.distributor);
    let cs_acct = env.svm.get_account(&cs_addr).unwrap();
    let cs = parse_claim_status(&cs_acct.data);
    assert!(
        !cs.fee_paid,
        "fee_paid should be false when unlocked is 0"
    );

    // Verify no SOL moved to fee_recipient
    let fee_recipient_balance_after_claim = env
        .svm
        .get_balance(&env.fee_recipient.pubkey())
        .unwrap_or(0);
    assert_eq!(
        fee_recipient_balance_after_claim, fee_recipient_balance_before,
        "no fee should be collected for zero unlock"
    );

    // Warp clock past end_ts so all locked tokens are vested
    warp_clock(&mut env.svm, end + 1);

    // claim_locked => fee should be collected now
    send_ix(
        &mut env.svm,
        ix_claim_locked(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
        ),
        &claimant,
    )
    .expect("claim_locked should succeed");

    // Verify fee_paid = true now
    let cs_acct2 = env.svm.get_account(&cs_addr).unwrap();
    let cs2 = parse_claim_status(&cs_acct2.data);
    assert!(
        cs2.fee_paid,
        "fee_paid should be true after claim_locked"
    );

    // Verify fee was collected
    let fee_recipient_balance_final = env
        .svm
        .get_balance(&env.fee_recipient.pubkey())
        .unwrap_or(0);
    assert_eq!(
        fee_recipient_balance_final - fee_recipient_balance_before,
        FEE_AMOUNT,
        "fee should be collected on claim_locked"
    );

    // Verify tokens received
    let token_balance = read_token_balance(&env.svm, &claimant_ata);
    assert_eq!(
        token_balance, amount_locked,
        "claimant should receive all locked tokens after full vesting"
    );
}

// ── 3. Happy Path: Linear Vesting - fee on unlock, not double-charged ───────

#[test]
fn test_linear_vesting_partial_claim() {
    let claimant = Keypair::new();
    let amount_unlocked = 500u64;
    let amount_locked = 500u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut env = bootstrap_env(
        FEE_AMOUNT,
        amount_unlocked,
        amount_locked,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    let fee_recipient_balance_before = env
        .svm
        .get_balance(&env.fee_recipient.pubkey())
        .unwrap_or(0);

    // new_claim with unlocked=500 => fee charged
    send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
            amount_unlocked,
            amount_locked,
            vec![],
        ),
        &claimant,
    )
    .expect("new_claim should succeed");

    // Verify fee_paid = true (because unlocked > 0)
    let (cs_addr, _) = claim_status_pda(&claimant.pubkey(), &env.distributor);
    let cs = parse_claim_status(&env.svm.get_account(&cs_addr).unwrap().data);
    assert!(cs.fee_paid, "fee_paid should be true on new_claim with unlocked > 0");

    let fee_recipient_after_claim = env
        .svm
        .get_balance(&env.fee_recipient.pubkey())
        .unwrap_or(0);
    assert_eq!(
        fee_recipient_after_claim - fee_recipient_balance_before,
        FEE_AMOUNT,
    );

    // Warp past end to vest everything
    warp_clock(&mut env.svm, end + 1);

    // claim_locked => should NOT charge fee again
    send_ix(
        &mut env.svm,
        ix_claim_locked(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
        ),
        &claimant,
    )
    .expect("claim_locked should succeed");

    let fee_recipient_final = env
        .svm
        .get_balance(&env.fee_recipient.pubkey())
        .unwrap_or(0);
    assert_eq!(
        fee_recipient_final, fee_recipient_after_claim,
        "no additional fee should be charged on claim_locked when fee already paid"
    );

    // Verify all tokens received
    let token_balance = read_token_balance(&env.svm, &claimant_ata);
    assert_eq!(
        token_balance,
        amount_unlocked + amount_locked,
        "claimant should receive all tokens"
    );
}

// ── 4. Happy Path: Zero Fee - no SOL deducted ──────────────────────────────

#[test]
fn test_zero_fee_no_sol_deducted() {
    let claimant = Keypair::new();
    let amount_unlocked = 1_000u64;
    let amount_locked = 0u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut env = bootstrap_env(
        0, // zero fee
        amount_unlocked,
        amount_locked,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    let claimant_sol_before = env.svm.get_balance(&claimant.pubkey()).unwrap_or(0);
    let fee_recipient_before = env
        .svm
        .get_balance(&env.fee_recipient.pubkey())
        .unwrap_or(0);

    send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
            amount_unlocked,
            amount_locked,
            vec![],
        ),
        &claimant,
    )
    .expect("new_claim should succeed with zero fee");

    // fee_paid should be false with zero fee
    let (cs_addr, _) = claim_status_pda(&claimant.pubkey(), &env.distributor);
    let cs = parse_claim_status(&env.svm.get_account(&cs_addr).unwrap().data);
    assert!(
        !cs.fee_paid,
        "fee_paid should be false when fee is zero"
    );

    // fee_recipient balance unchanged
    let fee_recipient_after = env
        .svm
        .get_balance(&env.fee_recipient.pubkey())
        .unwrap_or(0);
    assert_eq!(fee_recipient_after, fee_recipient_before);

    // Claimant only paid tx fee + rent, not claim fee.
    // We just check that no *extra* FEE_AMOUNT was deducted beyond tx costs.
    let claimant_sol_after = env.svm.get_balance(&claimant.pubkey()).unwrap_or(0);
    let sol_spent = claimant_sol_before - claimant_sol_after;
    // With zero fee, the SOL spent should be only tx fee + ClaimStatus rent.
    // It should definitely be less than 1 SOL (our fee is 0.005 SOL).
    assert!(
        sol_spent < LAMPORTS_PER_SOL,
        "claimant should only pay tx fee and rent, not a claim fee"
    );

    // Tokens received
    assert_eq!(read_token_balance(&env.svm, &claimant_ata), amount_unlocked);
}

// ── 5. Sad Path: Wrong fee_recipient on new_claim ───────────────────────────

#[test]
fn test_wrong_fee_recipient_rejected_on_claim() {
    let claimant = Keypair::new();
    let amount_unlocked = 1_000u64;
    let amount_locked = 0u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut env = bootstrap_env(
        FEE_AMOUNT,
        amount_unlocked,
        amount_locked,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    let wrong_recipient = Keypair::new();

    let result = send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &wrong_recipient.pubkey(), // WRONG
            amount_unlocked,
            amount_locked,
            vec![],
        ),
        &claimant,
    );

    assert!(
        result.is_err(),
        "new_claim with wrong fee_recipient should fail"
    );
    let err = result.unwrap_err();
    assert!(
        err.contains("InvalidFeeRecipient") || err.contains("custom program error"),
        "error should indicate invalid fee recipient, got: {}",
        err
    );
}

// ── 6. Sad Path: Wrong fee_recipient on claim_locked ────────────────────────

#[test]
fn test_wrong_fee_recipient_rejected_on_claim_locked() {
    let claimant = Keypair::new();
    let amount_unlocked = 0u64;
    let amount_locked = 1_000u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut env = bootstrap_env(
        FEE_AMOUNT,
        amount_unlocked,
        amount_locked,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    // new_claim with 0 unlocked succeeds (no fee check on recipient when fee not charged)
    send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
            amount_unlocked,
            amount_locked,
            vec![],
        ),
        &claimant,
    )
    .expect("new_claim should succeed");

    // Warp past end
    warp_clock(&mut env.svm, end + 1);

    let wrong_recipient = Keypair::new();

    let result = send_ix(
        &mut env.svm,
        ix_claim_locked(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &wrong_recipient.pubkey(), // WRONG
        ),
        &claimant,
    );

    assert!(
        result.is_err(),
        "claim_locked with wrong fee_recipient should fail"
    );
}

// ── 7. Sad Path: Claimant can't afford fee ──────────────────────────────────

#[test]
fn test_insufficient_sol_for_fee_rejects_claim() {
    let claimant = Keypair::new();
    let amount_unlocked = 1_000u64;
    let amount_locked = 0u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut env = bootstrap_env(
        FEE_AMOUNT,
        amount_unlocked,
        amount_locked,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    // Give claimant only enough for tx fee + rent, but NOT enough for the claim fee.
    // ClaimStatus rent ~ 1.5M lamports, tx fee ~ 5000 lamports.
    // We give them just enough for rent + tx fee but less than fee.
    // FEE_AMOUNT = 5_000_000, rent ~ 1.2M, tx fee ~ 5000
    // Total needed: ~6.2M. We give them ~2M (enough for rent+tx but not fee).
    let minimal_sol = 2_000_000u64; // Not enough for 5M fee
    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        minimal_sol,
    );

    let result = send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
            amount_unlocked,
            amount_locked,
            vec![],
        ),
        &claimant,
    );

    assert!(
        result.is_err(),
        "new_claim should fail when claimant cannot afford fee"
    );

    // Verify NO tokens transferred (atomicity)
    let token_balance = read_token_balance(&env.svm, &claimant_ata);
    assert_eq!(
        token_balance, 0,
        "no tokens should be transferred on failed claim"
    );
}

// ── 8. Sad Path: Fee bypass attempt - bogus fee_config ──────────────────────

#[test]
fn test_bogus_fee_config_rejected() {
    let claimant = Keypair::new();
    let amount_unlocked = 1_000u64;
    let amount_locked = 0u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut env = bootstrap_env(
        FEE_AMOUNT,
        amount_unlocked,
        amount_locked,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    // Build a new_claim instruction but replace fee_config with a random address
    let (claim_status, _) = claim_status_pda(&claimant.pubkey(), &env.distributor);
    let (token_vault, _) = ata_address(&env.distributor, &env.mint.pubkey());
    let fake_fee_config = Keypair::new().pubkey();

    let mut data = anchor_disc("new_claim").to_vec();
    data.extend_from_slice(&amount_unlocked.to_le_bytes());
    data.extend_from_slice(&amount_locked.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes()); // empty proof vec

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(env.distributor, false),
            AccountMeta::new(claim_status, false),
            AccountMeta::new(token_vault, false),
            AccountMeta::new(claimant_ata, false),
            AccountMeta::new(claimant.pubkey(), true),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(system_program_id(), false),
            AccountMeta::new_readonly(fake_fee_config, false), // BOGUS
            AccountMeta::new(env.fee_recipient.pubkey(), false),
        ],
        data,
    };

    let result = send_ix(&mut env.svm, ix, &claimant);
    assert!(
        result.is_err(),
        "new_claim with bogus fee_config should be rejected by PDA seeds constraint"
    );
}

// ── 9. Sad Path: Double claim attempt ───────────────────────────────────────

#[test]
fn test_cannot_claim_twice() {
    let claimant = Keypair::new();
    let amount_unlocked = 1_000u64;
    let amount_locked = 0u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut env = bootstrap_env(
        FEE_AMOUNT,
        amount_unlocked,
        amount_locked,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    // First claim succeeds
    send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
            amount_unlocked,
            amount_locked,
            vec![],
        ),
        &claimant,
    )
    .expect("first new_claim should succeed");

    // Second claim must fail (ClaimStatus PDA already initialized)
    let result = send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
            amount_unlocked,
            amount_locked,
            vec![],
        ),
        &claimant,
    );

    assert!(
        result.is_err(),
        "second new_claim should fail because ClaimStatus PDA already exists"
    );
}

// ── 10. Sad Path: Fee not double-charged on multiple claim_locked calls ─────

#[test]
fn test_fee_not_double_charged_on_second_claim_locked() {
    let claimant = Keypair::new();
    let amount_unlocked = 0u64;
    let amount_locked = 1_000u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 1_000; // long vesting window for partial claims

    let mut env = bootstrap_env(
        FEE_AMOUNT,
        amount_unlocked,
        amount_locked,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    // new_claim (0 unlocked => fee_paid = false)
    send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
            amount_unlocked,
            amount_locked,
            vec![],
        ),
        &claimant,
    )
    .expect("new_claim should succeed");

    let fee_recipient_before = env
        .svm
        .get_balance(&env.fee_recipient.pubkey())
        .unwrap_or(0);

    // Warp to halfway through vesting (partial unlock)
    let halfway = start + (end - start) / 2;
    warp_clock(&mut env.svm, halfway);

    // First claim_locked => fee charged
    send_ix(
        &mut env.svm,
        ix_claim_locked(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
        ),
        &claimant,
    )
    .expect("first claim_locked should succeed");

    let fee_recipient_after_first = env
        .svm
        .get_balance(&env.fee_recipient.pubkey())
        .unwrap_or(0);
    assert_eq!(
        fee_recipient_after_first - fee_recipient_before,
        FEE_AMOUNT,
        "fee should be charged on first claim_locked"
    );

    // Verify fee_paid = true
    let (cs_addr, _) = claim_status_pda(&claimant.pubkey(), &env.distributor);
    let cs = parse_claim_status(&env.svm.get_account(&cs_addr).unwrap().data);
    assert!(cs.fee_paid);

    // Warp to after end (full vesting) and expire blockhash to avoid AlreadyProcessed
    warp_clock(&mut env.svm, end + 1);
    env.svm.expire_blockhash();

    // Second claim_locked => NO fee
    send_ix(
        &mut env.svm,
        ix_claim_locked(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
        ),
        &claimant,
    )
    .expect("second claim_locked should succeed");

    let fee_recipient_after_second = env
        .svm
        .get_balance(&env.fee_recipient.pubkey())
        .unwrap_or(0);
    assert_eq!(
        fee_recipient_after_second, fee_recipient_after_first,
        "no additional fee should be charged on second claim_locked"
    );

    // All tokens received
    let token_balance = read_token_balance(&env.svm, &claimant_ata);
    assert_eq!(
        token_balance, amount_locked,
        "all locked tokens should be received"
    );
}

// ── 11. Sad Path: claim_locked before vesting starts ────────────────────────

#[test]
fn test_claim_locked_before_vesting_rejects() {
    let claimant = Keypair::new();
    let amount_unlocked = 0u64;
    let amount_locked = 1_000u64;
    let now = 1_000_000i64;
    let start = now + 1_000;
    let end = now + 2_000;

    let mut env = bootstrap_env(
        FEE_AMOUNT,
        amount_unlocked,
        amount_locked,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    // new_claim succeeds
    send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
            amount_unlocked,
            amount_locked,
            vec![],
        ),
        &claimant,
    )
    .expect("new_claim should succeed");

    // Try claim_locked BEFORE start_ts (clock is still at `now`, which is before start)
    let result = send_ix(
        &mut env.svm,
        ix_claim_locked(
            &env.distributor,
            &claimant.pubkey(),
            &claimant_ata,
            &env.mint.pubkey(),
            &env.fee_recipient.pubkey(),
        ),
        &claimant,
    );

    assert!(
        result.is_err(),
        "claim_locked before vesting start should fail"
    );
    let err = result.unwrap_err();
    assert!(
        err.contains("InsufficientUnlockedTokens") || err.contains("custom program error"),
        "error should indicate insufficient unlocked tokens, got: {}",
        err
    );
}

// ── 12. Sad Path: Admin changes fee between claims ──────────────────────────

#[test]
fn test_fee_change_between_claims() {
    // We need two claimants with separate distributor claims.
    // Since each distributor has a single root, we create two distributors.
    let claimant_a = Keypair::new();
    let claimant_b = Keypair::new();
    let amount_unlocked = 1_000u64;
    let amount_locked = 0u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;
    let initial_fee = 100u64;
    let updated_fee = 200u64;

    let mut svm = setup_svm();
    warp_clock(&mut svm, now);

    let admin = Keypair::new();
    let fee_recipient = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10 * LAMPORTS_PER_SOL)
        .unwrap();

    // Fund fee_recipient so it stays rent-exempt even with small fee amounts
    svm.airdrop(&fee_recipient.pubkey(), LAMPORTS_PER_SOL)
        .unwrap();

    // Init fee config with initial_fee
    send_ix(
        &mut svm,
        ix_init_fee(&admin.pubkey(), &fee_recipient.pubkey(), initial_fee),
        &admin,
    )
    .unwrap();

    // -- Distributor A for claimant_a --
    let mint_a = Keypair::new();
    let root_a = compute_root(&claimant_a.pubkey(), amount_unlocked, amount_locked);
    create_mint(&mut svm, mint_a.pubkey(), Some(&admin.pubkey()), amount_unlocked);

    let clawback_a = Keypair::new();
    create_token_account(&mut svm, clawback_a.pubkey(), &mint_a.pubkey(), &admin.pubkey(), 0);

    let clawback_start = end + 86_400 + 1;
    send_ix(
        &mut svm,
        ix_new_distributor(
            &admin.pubkey(),
            &mint_a.pubkey(),
            &clawback_a.pubkey(),
            0,
            root_a,
            amount_unlocked,
            10,
            start,
            end,
            clawback_start,
        ),
        &admin,
    )
    .unwrap();

    let (dist_a, _) = distributor_pda(&mint_a.pubkey(), 0);
    let (vault_a, _) = ata_address(&dist_a, &mint_a.pubkey());
    {
        let mut va = svm.get_account(&vault_a).unwrap();
        va.data[64..72].copy_from_slice(&amount_unlocked.to_le_bytes());
        svm.set_account(vault_a, va).unwrap();
    }

    // Fund + create token account for claimant A
    svm.airdrop(&claimant_a.pubkey(), 5 * LAMPORTS_PER_SOL)
        .unwrap();
    let ata_a = Keypair::new();
    create_token_account(&mut svm, ata_a.pubkey(), &mint_a.pubkey(), &claimant_a.pubkey(), 0);

    let fee_recipient_before_a = svm.get_balance(&fee_recipient.pubkey()).unwrap_or(0);

    // Claimant A claims with initial_fee=100
    send_ix(
        &mut svm,
        ix_new_claim(
            &dist_a,
            &claimant_a.pubkey(),
            &ata_a.pubkey(),
            &mint_a.pubkey(),
            &fee_recipient.pubkey(),
            amount_unlocked,
            amount_locked,
            vec![],
        ),
        &claimant_a,
    )
    .expect("claimant A new_claim should succeed");

    let fee_recipient_after_a = svm.get_balance(&fee_recipient.pubkey()).unwrap_or(0);
    assert_eq!(
        fee_recipient_after_a - fee_recipient_before_a,
        initial_fee,
        "claimant A should pay initial fee of {}",
        initial_fee
    );

    // Admin updates fee to 200
    send_ix(
        &mut svm,
        ix_set_fee(&admin.pubkey(), &fee_recipient.pubkey(), updated_fee),
        &admin,
    )
    .unwrap();

    // -- Distributor B for claimant_b --
    let mint_b = Keypair::new();
    let root_b = compute_root(&claimant_b.pubkey(), amount_unlocked, amount_locked);
    create_mint(&mut svm, mint_b.pubkey(), Some(&admin.pubkey()), amount_unlocked);

    let clawback_b = Keypair::new();
    create_token_account(&mut svm, clawback_b.pubkey(), &mint_b.pubkey(), &admin.pubkey(), 0);

    send_ix(
        &mut svm,
        ix_new_distributor(
            &admin.pubkey(),
            &mint_b.pubkey(),
            &clawback_b.pubkey(),
            0,
            root_b,
            amount_unlocked,
            10,
            start,
            end,
            clawback_start,
        ),
        &admin,
    )
    .unwrap();

    let (dist_b, _) = distributor_pda(&mint_b.pubkey(), 0);
    let (vault_b, _) = ata_address(&dist_b, &mint_b.pubkey());
    {
        let mut vb = svm.get_account(&vault_b).unwrap();
        vb.data[64..72].copy_from_slice(&amount_unlocked.to_le_bytes());
        svm.set_account(vault_b, vb).unwrap();
    }

    svm.airdrop(&claimant_b.pubkey(), 5 * LAMPORTS_PER_SOL)
        .unwrap();
    let ata_b = Keypair::new();
    create_token_account(&mut svm, ata_b.pubkey(), &mint_b.pubkey(), &claimant_b.pubkey(), 0);

    let fee_recipient_before_b = svm.get_balance(&fee_recipient.pubkey()).unwrap_or(0);

    // Claimant B claims with updated_fee=200
    send_ix(
        &mut svm,
        ix_new_claim(
            &dist_b,
            &claimant_b.pubkey(),
            &ata_b.pubkey(),
            &mint_b.pubkey(),
            &fee_recipient.pubkey(),
            amount_unlocked,
            amount_locked,
            vec![],
        ),
        &claimant_b,
    )
    .expect("claimant B new_claim should succeed");

    let fee_recipient_after_b = svm.get_balance(&fee_recipient.pubkey()).unwrap_or(0);
    assert_eq!(
        fee_recipient_after_b - fee_recipient_before_b,
        updated_fee,
        "claimant B should pay updated fee of {}",
        updated_fee
    );

    // Verify different fees were collected
    assert_ne!(initial_fee, updated_fee);
}

// ════════════════════════════════════════════════════════════════════════════
// GAP TESTS — Covering PRD sections not previously tested
// ════════════════════════════════════════════════════════════════════════════

// ── Clawback instruction builder ───────────────────────────────────────────

fn ix_clawback(
    distributor: &Address,
    mint: &Address,
    clawback_receiver: &Address,
    claimant: &Address,
) -> Instruction {
    let (token_vault, _) = ata_address(distributor, mint);
    let data = anchor_disc("clawback").to_vec();
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*distributor, false),
            AccountMeta::new(token_vault, false),
            AccountMeta::new(*clawback_receiver, false),
            AccountMeta::new_readonly(*claimant, true),
            AccountMeta::new_readonly(system_program_id(), false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data,
    }
}

/// Parse distributor on-chain data to read clawed_back flag.
/// Layout (after 8-byte disc): bump(1) version(8) root(32) mint(32) token_vault(32)
///   max_total_claim(8) max_num_nodes(8) total_amount_claimed(8) num_nodes_claimed(8)
///   start_ts(8) end_ts(8) clawback_start_ts(8) clawback_receiver(32) admin(32) clawed_back(1)
fn read_clawed_back(svm: &LiteSVM, distributor: &Address) -> bool {
    let acct = svm.get_account(distributor).unwrap();
    // Borsh-packed offsets after 8-byte discriminator:
    //   bump(1) version(8) root(32) mint(32) token_vault(32) max_total_claim(8)
    //   max_num_nodes(8) total_amount_claimed(8) num_nodes_claimed(8)
    //   start_ts(8) end_ts(8) clawback_start_ts(8) clawback_receiver(32) admin(32) = 225 bytes
    //   clawed_back at offset 8 + 225 = 233
    acct.data[233] != 0
}

/// Read clawback_receiver from distributor (Borsh offset 8+1+8+32+32+32+8+8+8+8+8+8+8 = 169, 32 bytes)
#[allow(dead_code)]
fn read_clawback_receiver(svm: &LiteSVM, distributor: &Address) -> Address {
    let acct = svm.get_account(distributor).unwrap();
    Address::from(<[u8; 32]>::try_from(&acct.data[169..201]).unwrap())
}

// ── Helper: bootstrap with custom version ──────────────────────────────────

fn bootstrap_env_with_version(
    fee: u64,
    amount_unlocked: u64,
    amount_locked: u64,
    claimant: &Address,
    now: i64,
    start_vesting_ts: i64,
    end_vesting_ts: i64,
    version: u64,
) -> TestEnv {
    let mut svm = setup_svm();
    warp_clock(&mut svm, now);

    let admin = Keypair::new();
    let fee_recipient = Keypair::new();
    let mint = Keypair::new();

    svm.airdrop(&admin.pubkey(), 10 * LAMPORTS_PER_SOL)
        .unwrap();

    // Initialize fee config
    send_ix(
        &mut svm,
        ix_init_fee(&admin.pubkey(), &fee_recipient.pubkey(), fee),
        &admin,
    )
    .unwrap();

    let total_tokens = amount_unlocked + amount_locked;
    create_mint(&mut svm, mint.pubkey(), Some(&admin.pubkey()), total_tokens);

    let clawback_receiver_ata = Keypair::new();
    create_token_account(
        &mut svm,
        clawback_receiver_ata.pubkey(),
        &mint.pubkey(),
        &admin.pubkey(),
        0,
    );

    let root = compute_root(claimant, amount_unlocked, amount_locked);
    let clawback_start_ts = end_vesting_ts + 86_400 + 1;

    send_ix(
        &mut svm,
        ix_new_distributor(
            &admin.pubkey(),
            &mint.pubkey(),
            &clawback_receiver_ata.pubkey(),
            version,
            root,
            total_tokens,
            10,
            start_vesting_ts,
            end_vesting_ts,
            clawback_start_ts,
        ),
        &admin,
    )
    .unwrap();

    let (distributor, _) = distributor_pda(&mint.pubkey(), version);
    let (token_vault, _) = ata_address(&distributor, &mint.pubkey());
    {
        let mut vault_acct = svm.get_account(&token_vault).expect("vault must exist");
        vault_acct.data[64..72].copy_from_slice(&total_tokens.to_le_bytes());
        svm.set_account(token_vault, vault_acct).unwrap();
    }

    TestEnv {
        svm,
        admin,
        fee_recipient,
        mint,
        version,
        distributor,
    }
}

// ── 13. [EDGE-G6] Two distributors same mint, different versions — fee charged independently

#[test]
fn test_two_distributors_same_mint_independent_fees() {
    let claimant = Keypair::new();
    let amount = 1_000u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    // We need a shared SVM with fee config, one mint, and two distributors
    let mut svm = setup_svm();
    warp_clock(&mut svm, now);

    let admin = Keypair::new();
    let fee_recipient = Keypair::new();
    let mint = Keypair::new();

    svm.airdrop(&admin.pubkey(), 10 * LAMPORTS_PER_SOL)
        .unwrap();
    svm.airdrop(&claimant.pubkey(), 10 * LAMPORTS_PER_SOL)
        .unwrap();

    send_ix(
        &mut svm,
        ix_init_fee(&admin.pubkey(), &fee_recipient.pubkey(), FEE_AMOUNT),
        &admin,
    )
    .unwrap();

    let root = compute_root(&claimant.pubkey(), amount, 0);
    create_mint(&mut svm, mint.pubkey(), Some(&admin.pubkey()), amount * 2);

    // Distributor v1
    let clawback1 = Keypair::new();
    create_token_account(&mut svm, clawback1.pubkey(), &mint.pubkey(), &admin.pubkey(), 0);
    let clawback_start = end + 86_400 + 1;
    send_ix(
        &mut svm,
        ix_new_distributor(
            &admin.pubkey(), &mint.pubkey(), &clawback1.pubkey(),
            1, root, amount, 10, start, end, clawback_start,
        ),
        &admin,
    ).unwrap();
    let (dist1, _) = distributor_pda(&mint.pubkey(), 1);
    let (vault1, _) = ata_address(&dist1, &mint.pubkey());
    {
        let mut v = svm.get_account(&vault1).unwrap();
        v.data[64..72].copy_from_slice(&amount.to_le_bytes());
        svm.set_account(vault1, v).unwrap();
    }

    // Distributor v2
    let clawback2 = Keypair::new();
    create_token_account(&mut svm, clawback2.pubkey(), &mint.pubkey(), &admin.pubkey(), 0);
    send_ix(
        &mut svm,
        ix_new_distributor(
            &admin.pubkey(), &mint.pubkey(), &clawback2.pubkey(),
            2, root, amount, 10, start, end, clawback_start,
        ),
        &admin,
    ).unwrap();
    let (dist2, _) = distributor_pda(&mint.pubkey(), 2);
    let (vault2, _) = ata_address(&dist2, &mint.pubkey());
    {
        let mut v = svm.get_account(&vault2).unwrap();
        v.data[64..72].copy_from_slice(&amount.to_le_bytes());
        svm.set_account(vault2, v).unwrap();
    }

    // Claimant token accounts
    let ata1 = Keypair::new();
    create_token_account(&mut svm, ata1.pubkey(), &mint.pubkey(), &claimant.pubkey(), 0);
    let ata2 = Keypair::new();
    create_token_account(&mut svm, ata2.pubkey(), &mint.pubkey(), &claimant.pubkey(), 0);

    let recipient_before = svm.get_balance(&fee_recipient.pubkey()).unwrap_or(0);

    // Claim from v1
    send_ix(
        &mut svm,
        ix_new_claim(&dist1, &claimant.pubkey(), &ata1.pubkey(), &mint.pubkey(),
            &fee_recipient.pubkey(), amount, 0, vec![]),
        &claimant,
    ).expect("claim from v1 should succeed");

    let recipient_after_v1 = svm.get_balance(&fee_recipient.pubkey()).unwrap_or(0);
    assert_eq!(recipient_after_v1 - recipient_before, FEE_AMOUNT, "fee paid on v1");

    // Claim from v2 (different ClaimStatus PDA)
    send_ix(
        &mut svm,
        ix_new_claim(&dist2, &claimant.pubkey(), &ata2.pubkey(), &mint.pubkey(),
            &fee_recipient.pubkey(), amount, 0, vec![]),
        &claimant,
    ).expect("claim from v2 should succeed");

    let recipient_after_v2 = svm.get_balance(&fee_recipient.pubkey()).unwrap_or(0);
    assert_eq!(
        recipient_after_v2 - recipient_before,
        FEE_AMOUNT * 2,
        "fee paid independently on both distributors"
    );

    // Both ClaimStatus PDAs should have fee_paid = true
    let (cs1, _) = claim_status_pda(&claimant.pubkey(), &dist1);
    let (cs2, _) = claim_status_pda(&claimant.pubkey(), &dist2);
    assert!(parse_claim_status(&svm.get_account(&cs1).unwrap().data).fee_paid);
    assert!(parse_claim_status(&svm.get_account(&cs2).unwrap().data).fee_paid);
}

// ── 14. [EDGE-G10] Fee recipient = claimant (degenerate case) ─────────────

#[test]
fn test_fee_recipient_equals_claimant_degenerate() {
    let claimant = Keypair::new();
    let amount_unlocked = 1_000u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut svm = setup_svm();
    warp_clock(&mut svm, now);

    let admin = Keypair::new();
    let mint = Keypair::new();

    svm.airdrop(&admin.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    svm.airdrop(&claimant.pubkey(), 5 * LAMPORTS_PER_SOL).unwrap();

    // fee_recipient = claimant's pubkey
    send_ix(
        &mut svm,
        ix_init_fee(&admin.pubkey(), &claimant.pubkey(), FEE_AMOUNT),
        &admin,
    ).unwrap();

    let root = compute_root(&claimant.pubkey(), amount_unlocked, 0);
    create_mint(&mut svm, mint.pubkey(), Some(&admin.pubkey()), amount_unlocked);

    let clawback = Keypair::new();
    create_token_account(&mut svm, clawback.pubkey(), &mint.pubkey(), &admin.pubkey(), 0);

    let clawback_start = end + 86_400 + 1;
    send_ix(
        &mut svm,
        ix_new_distributor(
            &admin.pubkey(), &mint.pubkey(), &clawback.pubkey(),
            0, root, amount_unlocked, 10, start, end, clawback_start,
        ),
        &admin,
    ).unwrap();

    let (distributor, _) = distributor_pda(&mint.pubkey(), 0);
    let (vault, _) = ata_address(&distributor, &mint.pubkey());
    {
        let mut v = svm.get_account(&vault).unwrap();
        v.data[64..72].copy_from_slice(&amount_unlocked.to_le_bytes());
        svm.set_account(vault, v).unwrap();
    }

    let claimant_ata = Keypair::new();
    create_token_account(&mut svm, claimant_ata.pubkey(), &mint.pubkey(), &claimant.pubkey(), 0);

    let sol_before = svm.get_balance(&claimant.pubkey()).unwrap_or(0);

    // Claim with fee_recipient = claimant itself
    send_ix(
        &mut svm,
        ix_new_claim(
            &distributor, &claimant.pubkey(), &claimant_ata.pubkey(), &mint.pubkey(),
            &claimant.pubkey(), // fee goes to self
            amount_unlocked, 0, vec![],
        ),
        &claimant,
    ).expect("claim should succeed even when fee_recipient = claimant");

    // Net SOL effect: fee paid to self, so only tx fee + rent lost
    let sol_after = svm.get_balance(&claimant.pubkey()).unwrap_or(0);
    let sol_spent = sol_before - sol_after;
    // Should be much less than FEE_AMOUNT + 1 SOL (just tx fee + rent)
    assert!(
        sol_spent < FEE_AMOUNT + LAMPORTS_PER_SOL,
        "net SOL cost should be minimal when fee goes to self"
    );

    // fee_paid should still be set to true
    let (cs_addr, _) = claim_status_pda(&claimant.pubkey(), &distributor);
    let cs = parse_claim_status(&svm.get_account(&cs_addr).unwrap().data);
    assert!(cs.fee_paid, "fee_paid should be true even in degenerate case");

    // Tokens received
    assert_eq!(read_token_balance(&svm, &claimant_ata.pubkey()), amount_unlocked);
}

// ── 15. [S-F1] Claim after clawback fails — no fee charged ────────────────

#[test]
fn test_claim_after_clawback_fails_no_fee() {
    let claimant = Keypair::new();
    let amount_unlocked = 1_000u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;
    let clawback_start = end + 86_400 + 1;

    let mut svm = setup_svm();
    warp_clock(&mut svm, now);

    let admin = Keypair::new();
    let fee_recipient = Keypair::new();
    let mint = Keypair::new();

    svm.airdrop(&admin.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    svm.airdrop(&claimant.pubkey(), 5 * LAMPORTS_PER_SOL).unwrap();

    send_ix(
        &mut svm,
        ix_init_fee(&admin.pubkey(), &fee_recipient.pubkey(), FEE_AMOUNT),
        &admin,
    ).unwrap();

    let root = compute_root(&claimant.pubkey(), amount_unlocked, 0);
    create_mint(&mut svm, mint.pubkey(), Some(&admin.pubkey()), amount_unlocked);

    let clawback_recv = Keypair::new();
    create_token_account(&mut svm, clawback_recv.pubkey(), &mint.pubkey(), &admin.pubkey(), 0);

    send_ix(
        &mut svm,
        ix_new_distributor(
            &admin.pubkey(), &mint.pubkey(), &clawback_recv.pubkey(),
            0, root, amount_unlocked, 10, start, end, clawback_start,
        ),
        &admin,
    ).unwrap();

    let (distributor, _) = distributor_pda(&mint.pubkey(), 0);
    let (vault, _) = ata_address(&distributor, &mint.pubkey());
    {
        let mut v = svm.get_account(&vault).unwrap();
        v.data[64..72].copy_from_slice(&amount_unlocked.to_le_bytes());
        svm.set_account(vault, v).unwrap();
    }

    // Warp past clawback_start and execute clawback
    warp_clock(&mut svm, clawback_start + 1);
    send_ix(
        &mut svm,
        ix_clawback(&distributor, &mint.pubkey(), &clawback_recv.pubkey(), &admin.pubkey()),
        &admin,
    ).expect("clawback should succeed");

    assert!(read_clawed_back(&svm, &distributor), "distributor should be clawed back");

    let claimant_ata = Keypair::new();
    create_token_account(&mut svm, claimant_ata.pubkey(), &mint.pubkey(), &claimant.pubkey(), 0);

    let fee_recipient_before = svm.get_balance(&fee_recipient.pubkey()).unwrap_or(0);

    // Try to claim after clawback — should fail
    let result = send_ix(
        &mut svm,
        ix_new_claim(
            &distributor, &claimant.pubkey(), &claimant_ata.pubkey(), &mint.pubkey(),
            &fee_recipient.pubkey(), amount_unlocked, 0, vec![],
        ),
        &claimant,
    );

    assert!(result.is_err(), "new_claim should fail after clawback");
    let err = result.unwrap_err();
    assert!(
        err.contains("ClaimExpired") || err.contains("custom program error"),
        "should get ClaimExpired, got: {}", err
    );

    // No fee charged
    let fee_recipient_after = svm.get_balance(&fee_recipient.pubkey()).unwrap_or(0);
    assert_eq!(fee_recipient_after, fee_recipient_before, "no fee should be charged on failed claim");
}

// ── 16. [S-F2] claim_locked after clawback fails — fee already paid not refunded

#[test]
fn test_claim_locked_after_clawback_fails_fee_not_refunded() {
    let claimant = Keypair::new();
    let amount_unlocked = 500u64;
    let amount_locked = 500u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;
    let clawback_start = end + 86_400 + 1;

    let mut svm = setup_svm();
    warp_clock(&mut svm, now);

    let admin = Keypair::new();
    let fee_recipient = Keypair::new();
    let mint = Keypair::new();

    svm.airdrop(&admin.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    svm.airdrop(&claimant.pubkey(), 5 * LAMPORTS_PER_SOL).unwrap();

    send_ix(
        &mut svm,
        ix_init_fee(&admin.pubkey(), &fee_recipient.pubkey(), FEE_AMOUNT),
        &admin,
    ).unwrap();

    let root = compute_root(&claimant.pubkey(), amount_unlocked, amount_locked);
    let total = amount_unlocked + amount_locked;
    create_mint(&mut svm, mint.pubkey(), Some(&admin.pubkey()), total);

    let clawback_recv = Keypair::new();
    create_token_account(&mut svm, clawback_recv.pubkey(), &mint.pubkey(), &admin.pubkey(), 0);

    send_ix(
        &mut svm,
        ix_new_distributor(
            &admin.pubkey(), &mint.pubkey(), &clawback_recv.pubkey(),
            0, root, total, 10, start, end, clawback_start,
        ),
        &admin,
    ).unwrap();

    let (distributor, _) = distributor_pda(&mint.pubkey(), 0);
    let (vault, _) = ata_address(&distributor, &mint.pubkey());
    {
        let mut v = svm.get_account(&vault).unwrap();
        v.data[64..72].copy_from_slice(&total.to_le_bytes());
        svm.set_account(vault, v).unwrap();
    }

    let claimant_ata = Keypair::new();
    create_token_account(&mut svm, claimant_ata.pubkey(), &mint.pubkey(), &claimant.pubkey(), 0);

    // new_claim succeeds — fee paid (unlocked > 0)
    send_ix(
        &mut svm,
        ix_new_claim(
            &distributor, &claimant.pubkey(), &claimant_ata.pubkey(), &mint.pubkey(),
            &fee_recipient.pubkey(), amount_unlocked, amount_locked, vec![],
        ),
        &claimant,
    ).expect("new_claim should succeed");

    let fee_recipient_after_claim = svm.get_balance(&fee_recipient.pubkey()).unwrap_or(0);
    assert!(fee_recipient_after_claim > 0, "fee should have been collected");

    // Now clawback
    warp_clock(&mut svm, clawback_start + 1);
    send_ix(
        &mut svm,
        ix_clawback(&distributor, &mint.pubkey(), &clawback_recv.pubkey(), &admin.pubkey()),
        &admin,
    ).expect("clawback should succeed");

    svm.expire_blockhash();

    // claim_locked after clawback should fail
    let result = send_ix(
        &mut svm,
        ix_claim_locked(
            &distributor, &claimant.pubkey(), &claimant_ata.pubkey(), &mint.pubkey(),
            &fee_recipient.pubkey(),
        ),
        &claimant,
    );

    assert!(result.is_err(), "claim_locked should fail after clawback");

    // Fee already paid is NOT refunded
    let fee_recipient_final = svm.get_balance(&fee_recipient.pubkey()).unwrap_or(0);
    assert_eq!(
        fee_recipient_final, fee_recipient_after_claim,
        "fee from new_claim should NOT be refunded after clawback"
    );
}

// ── 17. [EDGE-F1] Clawback ordering: clawed_back checked BEFORE fee in claim_locked

#[test]
fn test_clawback_checked_before_fee_on_claim_locked() {
    // Cliff vesting with deferred fee. Clawback happens before claim_locked.
    // Must verify: claim_locked fails AND no fee is charged.
    let claimant = Keypair::new();
    let amount_unlocked = 0u64;
    let amount_locked = 1_000u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;
    let clawback_start = end + 86_400 + 1;

    let mut svm = setup_svm();
    warp_clock(&mut svm, now);

    let admin = Keypair::new();
    let fee_recipient = Keypair::new();
    let mint = Keypair::new();

    svm.airdrop(&admin.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    svm.airdrop(&claimant.pubkey(), 5 * LAMPORTS_PER_SOL).unwrap();

    send_ix(
        &mut svm,
        ix_init_fee(&admin.pubkey(), &fee_recipient.pubkey(), FEE_AMOUNT),
        &admin,
    ).unwrap();

    let root = compute_root(&claimant.pubkey(), amount_unlocked, amount_locked);
    create_mint(&mut svm, mint.pubkey(), Some(&admin.pubkey()), amount_locked);

    let clawback_recv = Keypair::new();
    create_token_account(&mut svm, clawback_recv.pubkey(), &mint.pubkey(), &admin.pubkey(), 0);

    send_ix(
        &mut svm,
        ix_new_distributor(
            &admin.pubkey(), &mint.pubkey(), &clawback_recv.pubkey(),
            0, root, amount_locked, 10, start, end, clawback_start,
        ),
        &admin,
    ).unwrap();

    let (distributor, _) = distributor_pda(&mint.pubkey(), 0);
    let (vault, _) = ata_address(&distributor, &mint.pubkey());
    {
        let mut v = svm.get_account(&vault).unwrap();
        v.data[64..72].copy_from_slice(&amount_locked.to_le_bytes());
        svm.set_account(vault, v).unwrap();
    }

    let claimant_ata = Keypair::new();
    create_token_account(&mut svm, claimant_ata.pubkey(), &mint.pubkey(), &claimant.pubkey(), 0);

    // new_claim with 0 unlocked — fee deferred
    send_ix(
        &mut svm,
        ix_new_claim(
            &distributor, &claimant.pubkey(), &claimant_ata.pubkey(), &mint.pubkey(),
            &fee_recipient.pubkey(), amount_unlocked, amount_locked, vec![],
        ),
        &claimant,
    ).expect("new_claim should succeed");

    let (cs_addr, _) = claim_status_pda(&claimant.pubkey(), &distributor);
    let cs = parse_claim_status(&svm.get_account(&cs_addr).unwrap().data);
    assert!(!cs.fee_paid, "fee_paid should be false (deferred)");

    // Clawback BEFORE claimant can claim_locked
    warp_clock(&mut svm, clawback_start + 1);
    send_ix(
        &mut svm,
        ix_clawback(&distributor, &mint.pubkey(), &clawback_recv.pubkey(), &admin.pubkey()),
        &admin,
    ).expect("clawback should succeed");

    svm.expire_blockhash();

    let fee_recipient_before = svm.get_balance(&fee_recipient.pubkey()).unwrap_or(0);

    // claim_locked should fail with ClaimExpired, and NO fee should be charged
    let result = send_ix(
        &mut svm,
        ix_claim_locked(
            &distributor, &claimant.pubkey(), &claimant_ata.pubkey(), &mint.pubkey(),
            &fee_recipient.pubkey(),
        ),
        &claimant,
    );

    assert!(result.is_err(), "claim_locked after clawback should fail");

    let fee_recipient_after = svm.get_balance(&fee_recipient.pubkey()).unwrap_or(0);
    assert_eq!(
        fee_recipient_after, fee_recipient_before,
        "CRITICAL: no fee should be charged when clawback check fails first"
    );

    // fee_paid should still be false
    let cs2 = parse_claim_status(&svm.get_account(&cs_addr).unwrap().data);
    assert!(!cs2.fee_paid, "fee_paid should remain false after failed claim_locked");
}

// ── 18. [H-C3] Fee change between new_claim and claim_locked (cliff vesting)

#[test]
fn test_fee_change_between_new_claim_and_claim_locked() {
    let claimant = Keypair::new();
    let amount_unlocked = 0u64;
    let amount_locked = 1_000u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;
    let initial_fee = 100u64;
    let updated_fee = 500u64;

    let mut env = bootstrap_env(
        initial_fee,
        amount_unlocked,
        amount_locked,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    // Pre-fund fee_recipient so it stays rent-exempt with small fee amounts
    env.svm.airdrop(&env.fee_recipient.pubkey(), LAMPORTS_PER_SOL).unwrap();

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    // new_claim with 0 unlocked — no fee (deferred)
    send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor, &claimant.pubkey(), &claimant_ata,
            &env.mint.pubkey(), &env.fee_recipient.pubkey(),
            amount_unlocked, amount_locked, vec![],
        ),
        &claimant,
    ).expect("new_claim should succeed");

    let fee_before = env.svm.get_balance(&env.fee_recipient.pubkey()).unwrap_or(0);

    // Admin changes fee from 100 to 500 BETWEEN new_claim and claim_locked
    send_ix(
        &mut env.svm,
        ix_set_fee(&env.admin.pubkey(), &env.fee_recipient.pubkey(), updated_fee),
        &env.admin,
    ).unwrap();

    // Warp past vesting end
    warp_clock(&mut env.svm, end + 1);

    // claim_locked — should charge the NEW fee (500), not the old one (100)
    send_ix(
        &mut env.svm,
        ix_claim_locked(
            &env.distributor, &claimant.pubkey(), &claimant_ata,
            &env.mint.pubkey(), &env.fee_recipient.pubkey(),
        ),
        &claimant,
    ).expect("claim_locked should succeed");

    let fee_after = env.svm.get_balance(&env.fee_recipient.pubkey()).unwrap_or(0);
    assert_eq!(
        fee_after - fee_before,
        updated_fee,
        "claim_locked should charge the UPDATED fee ({}), not the original ({})",
        updated_fee,
        initial_fee
    );
}

// ── 19. [H-C4] Fee disabled between new_claim and claim_locked (cliff vesting)

#[test]
fn test_fee_disabled_between_new_claim_and_claim_locked() {
    let claimant = Keypair::new();
    let amount_unlocked = 0u64;
    let amount_locked = 1_000u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut env = bootstrap_env(
        FEE_AMOUNT,
        amount_unlocked,
        amount_locked,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    // new_claim with 0 unlocked — no fee (deferred)
    send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor, &claimant.pubkey(), &claimant_ata,
            &env.mint.pubkey(), &env.fee_recipient.pubkey(),
            amount_unlocked, amount_locked, vec![],
        ),
        &claimant,
    ).expect("new_claim should succeed");

    // Admin disables fee
    send_ix(
        &mut env.svm,
        ix_set_fee(&env.admin.pubkey(), &env.fee_recipient.pubkey(), 0),
        &env.admin,
    ).unwrap();

    let fee_before = env.svm.get_balance(&env.fee_recipient.pubkey()).unwrap_or(0);

    // Warp past vesting end
    warp_clock(&mut env.svm, end + 1);

    // claim_locked — fee is now 0, so no SOL should move
    send_ix(
        &mut env.svm,
        ix_claim_locked(
            &env.distributor, &claimant.pubkey(), &claimant_ata,
            &env.mint.pubkey(), &env.fee_recipient.pubkey(),
        ),
        &claimant,
    ).expect("claim_locked should succeed with disabled fee");

    let fee_after = env.svm.get_balance(&env.fee_recipient.pubkey()).unwrap_or(0);
    assert_eq!(fee_after, fee_before, "no fee should be charged when fee disabled");

    // fee_paid should remain false
    let (cs_addr, _) = claim_status_pda(&claimant.pubkey(), &env.distributor);
    let cs = parse_claim_status(&env.svm.get_account(&cs_addr).unwrap().data);
    assert!(!cs.fee_paid, "fee_paid should be false when fee was disabled");

    // Tokens should still be received
    assert_eq!(
        read_token_balance(&env.svm, &claimant_ata),
        amount_locked,
        "tokens should transfer normally even with fee disabled"
    );
}

// ── 20. [E-D3] Fee recipient drained to 0 SOL — claim still succeeds

#[test]
fn test_fee_recipient_zero_balance_claim_succeeds() {
    let claimant = Keypair::new();
    let amount_unlocked = 1_000u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut env = bootstrap_env(
        FEE_AMOUNT,
        amount_unlocked,
        0,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    // Ensure fee_recipient has exactly 0 SOL (it starts with 0 since we never airdropped)
    let recipient_bal = env.svm.get_balance(&env.fee_recipient.pubkey()).unwrap_or(0);
    assert_eq!(recipient_bal, 0, "fee_recipient should start with 0 SOL");

    // Claim should succeed — SOL is sent TO fee_recipient, not FROM it
    send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor, &claimant.pubkey(), &claimant_ata,
            &env.mint.pubkey(), &env.fee_recipient.pubkey(),
            amount_unlocked, 0, vec![],
        ),
        &claimant,
    ).expect("claim should succeed even when fee_recipient has 0 SOL");

    // Fee should have arrived
    let recipient_after = env.svm.get_balance(&env.fee_recipient.pubkey()).unwrap_or(0);
    assert_eq!(recipient_after, FEE_AMOUNT, "fee should arrive at zero-balance recipient");

    // Tokens received
    assert_eq!(read_token_balance(&env.svm, &claimant_ata), amount_unlocked);
}

// ── 21. [EDGE-G1] Minimum fee (1 lamport) ─────────────────────────────────

#[test]
fn test_minimum_fee_one_lamport() {
    let claimant = Keypair::new();
    let amount_unlocked = 1_000u64;
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut env = bootstrap_env(
        1, // 1 lamport fee
        amount_unlocked,
        0,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    // Pre-fund fee_recipient so 1 lamport doesn't cause rent issues
    env.svm.airdrop(&env.fee_recipient.pubkey(), LAMPORTS_PER_SOL).unwrap();

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    let recipient_before = env.svm.get_balance(&env.fee_recipient.pubkey()).unwrap_or(0);

    send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor, &claimant.pubkey(), &claimant_ata,
            &env.mint.pubkey(), &env.fee_recipient.pubkey(),
            amount_unlocked, 0, vec![],
        ),
        &claimant,
    ).expect("claim with 1 lamport fee should succeed");

    let recipient_after = env.svm.get_balance(&env.fee_recipient.pubkey()).unwrap_or(0);
    assert_eq!(recipient_after - recipient_before, 1, "exactly 1 lamport fee collected");

    let (cs_addr, _) = claim_status_pda(&claimant.pubkey(), &env.distributor);
    let cs = parse_claim_status(&env.svm.get_account(&cs_addr).unwrap().data);
    assert!(cs.fee_paid, "fee_paid should be true for 1 lamport fee");
}

// ── 22. [EDGE-G3] Minimum token transfer (amount_unlocked = 1) with large fee

#[test]
fn test_single_token_with_fee() {
    let claimant = Keypair::new();
    let amount_unlocked = 1u64; // single token atom
    let now = 1_000_000i64;
    let start = now + 100;
    let end = now + 200;

    let mut env = bootstrap_env(
        FEE_AMOUNT,
        amount_unlocked,
        0,
        &claimant.pubkey(),
        now,
        start,
        end,
    );

    let claimant_ata = setup_claimant(
        &mut env.svm,
        &claimant,
        &env.mint.pubkey(),
        5 * LAMPORTS_PER_SOL,
    );

    send_ix(
        &mut env.svm,
        ix_new_claim(
            &env.distributor, &claimant.pubkey(), &claimant_ata,
            &env.mint.pubkey(), &env.fee_recipient.pubkey(),
            amount_unlocked, 0, vec![],
        ),
        &claimant,
    ).expect("claim of 1 token with fee should succeed");

    assert_eq!(read_token_balance(&env.svm, &claimant_ata), 1, "1 token received");

    let (cs_addr, _) = claim_status_pda(&claimant.pubkey(), &env.distributor);
    let cs = parse_claim_status(&env.svm.get_account(&cs_addr).unwrap().data);
    assert!(cs.fee_paid, "fee charged even for 1 token claim");
}
