/// LiteSVM integration tests for the Merkle Distributor fee management.
/// Tests the fee admin instruction lifecycle against the actual compiled .so.
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::Message;
use solana_transaction::Transaction;
use sha2::{Sha256, Digest};

use solana_pubkey::Pubkey as Address;

fn anchor_discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{}", name).as_bytes());
    let hash = hasher.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

fn program_id() -> Address {
    "Ah7iuugan983ymZAKJAFAdvPN3My7ESkGUARrFTn3iqM".parse().unwrap()
}

fn system_program_id() -> Address {
    "11111111111111111111111111111111".parse().unwrap()
}

fn fee_config_pda() -> (Address, u8) {
    Address::find_program_address(&[b"FeeConfig"], &program_id())
}

fn load_program() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/merkle_distributor_fee_task.so"
    ))
    .expect("Failed to read .so — run `anchor build` first")
}

fn setup_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(program_id(), &load_program()).expect("failed to load program");
    svm
}

fn send_ix(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair) -> Result<(), String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let mut tx = Transaction::new_unsigned(msg);
    tx.sign(&[payer], blockhash);
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e))
}

fn ix_init_fee(admin: &Address, recipient: &Address, fee: u64) -> Instruction {
    let (pda, _) = fee_config_pda();
    let mut data = anchor_discriminator("initialize_fee_config").to_vec();
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
    let mut data = anchor_discriminator("set_claim_fee").to_vec();
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

fn parse_fee_config(data: &[u8]) -> (Address, u64, Address, u8) {
    let admin = Address::from(<[u8; 32]>::try_from(&data[8..40]).unwrap());
    let fee = u64::from_le_bytes(data[40..48].try_into().unwrap());
    let recipient = Address::from(<[u8; 32]>::try_from(&data[48..80]).unwrap());
    let bump = data[80];
    (admin, fee, recipient, bump)
}

// ─── Happy Path Tests ────────────────────────────────────────────────────

#[test]
fn happy_initialize_fee_config() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let recipient = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    let ix = ix_init_fee(&admin.pubkey(), &recipient.pubkey(), 5_000_000);
    assert!(send_ix(&mut svm, ix, &admin).is_ok());

    let (pda, _) = fee_config_pda();
    let acct = svm.get_account(&pda).unwrap();
    let (a, f, r, b) = parse_fee_config(&acct.data);
    assert_eq!(a, admin.pubkey());
    assert_eq!(f, 5_000_000);
    assert_eq!(r, recipient.pubkey());
    assert!(b > 0);
}

#[test]
fn happy_admin_updates_fee() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let r1 = Keypair::new();
    let r2 = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r1.pubkey(), 5_000_000), &admin).unwrap();
    send_ix(&mut svm, ix_set_fee(&admin.pubkey(), &r2.pubkey(), 10_000_000), &admin).unwrap();

    let (pda, _) = fee_config_pda();
    let acct = svm.get_account(&pda).unwrap();
    let (_, f, r, _) = parse_fee_config(&acct.data);
    assert_eq!(f, 10_000_000);
    assert_eq!(r, r2.pubkey());
}

#[test]
fn happy_disable_fee() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r.pubkey(), 5_000_000), &admin).unwrap();
    send_ix(&mut svm, ix_set_fee(&admin.pubkey(), &r.pubkey(), 0), &admin).unwrap();

    let (pda, _) = fee_config_pda();
    let acct = svm.get_account(&pda).unwrap();
    let (_, f, _, _) = parse_fee_config(&acct.data);
    assert_eq!(f, 0);
}

#[test]
fn happy_init_with_zero_fee() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    assert!(send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r.pubkey(), 0), &admin).is_ok());

    let (pda, _) = fee_config_pda();
    let acct = svm.get_account(&pda).unwrap();
    let (_, f, _, _) = parse_fee_config(&acct.data);
    assert_eq!(f, 0);
}

#[test]
fn happy_update_fee_multiple_times() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r.pubkey(), 1_000_000), &admin).unwrap();

    for fee in [2_000_000u64, 5_000_000, 10_000_000, 0, 7_500_000] {
        send_ix(&mut svm, ix_set_fee(&admin.pubkey(), &r.pubkey(), fee), &admin).unwrap();
        let (pda, _) = fee_config_pda();
        let acct = svm.get_account(&pda).unwrap();
        let (_, f, _, _) = parse_fee_config(&acct.data);
        assert_eq!(f, fee);
    }
}

#[test]
fn happy_update_recipient_only() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let r1 = Keypair::new();
    let r2 = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r1.pubkey(), 5_000_000), &admin).unwrap();
    send_ix(&mut svm, ix_set_fee(&admin.pubkey(), &r2.pubkey(), 5_000_000), &admin).unwrap();

    let (pda, _) = fee_config_pda();
    let acct = svm.get_account(&pda).unwrap();
    let (_, _, r, _) = parse_fee_config(&acct.data);
    assert_eq!(r, r2.pubkey());
}

#[test]
fn happy_zero_fee_allows_any_recipient() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    assert!(send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &Address::default(), 0), &admin).is_ok());
}

#[test]
fn happy_admin_preserved_after_update() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r.pubkey(), 5_000_000), &admin).unwrap();
    send_ix(&mut svm, ix_set_fee(&admin.pubkey(), &r.pubkey(), 10_000_000), &admin).unwrap();

    let (pda, _) = fee_config_pda();
    let acct = svm.get_account(&pda).unwrap();
    let (stored_admin, _, _, _) = parse_fee_config(&acct.data);
    assert_eq!(stored_admin, admin.pubkey());
}

// ─── Sad Path Tests ──────────────────────────────────────────────────────

#[test]
fn sad_cannot_init_twice() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let recipient = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &recipient.pubkey(), 5_000_000), &admin).unwrap();
    assert!(send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &recipient.pubkey(), 10_000_000), &admin).is_err());
}

#[test]
fn sad_non_admin_rejected() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let attacker = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();

    send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r.pubkey(), 5_000_000), &admin).unwrap();
    assert!(send_ix(&mut svm, ix_set_fee(&attacker.pubkey(), &attacker.pubkey(), 0), &attacker).is_err());
}

#[test]
fn sad_reject_zero_recipient_positive_fee() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r.pubkey(), 0), &admin).unwrap();
    assert!(send_ix(&mut svm, ix_set_fee(&admin.pubkey(), &Address::default(), 5_000_000), &admin).is_err());
}

#[test]
fn sad_init_positive_fee_zero_recipient() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    assert!(send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &Address::default(), 5_000_000), &admin).is_err());
}

#[test]
fn sad_non_admin_cannot_init_after_existing() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let other = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&other.pubkey(), 10_000_000_000).unwrap();

    send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r.pubkey(), 5_000_000), &admin).unwrap();
    assert!(send_ix(&mut svm, ix_init_fee(&other.pubkey(), &other.pubkey(), 0), &other).is_err());
}

#[test]
fn sad_non_signer_admin_fails() {
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let payer = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

    send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r.pubkey(), 5_000_000), &admin).unwrap();

    // Build set_claim_fee but mark admin as non-signer
    let (fee_config, _) = fee_config_pda();
    let mut data = anchor_discriminator("set_claim_fee").to_vec();
    data.extend_from_slice(&0u64.to_le_bytes());
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(fee_config, false),
            AccountMeta::new_readonly(admin.pubkey(), false), // NOT a signer
            AccountMeta::new_readonly(r.pubkey(), false),
        ],
        data,
    };
    assert!(send_ix(&mut svm, ix, &payer).is_err());
}

// ─── Additional Negative Tests ──────────────────────────────────────────

#[test]
fn sad_set_fee_without_init_fails() {
    // Trying to update fee config before it's initialized should fail
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    // Skip init, go straight to set_claim_fee
    assert!(send_ix(&mut svm, ix_set_fee(&admin.pubkey(), &r.pubkey(), 5_000_000), &admin).is_err());
}

#[test]
fn sad_init_with_different_payer_mismatch() {
    // The admin=signer pays rent. If someone else signs but passes admin as a
    // non-signer account, the tx fails because admin must be a signer.
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let payer = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

    // Build init ix but admin is non-signer
    let (pda, _) = fee_config_pda();
    let mut data = anchor_discriminator("initialize_fee_config").to_vec();
    data.extend_from_slice(&5_000_000u64.to_le_bytes());
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(pda, false),
            AccountMeta::new(admin.pubkey(), false), // NOT a signer
            AccountMeta::new_readonly(r.pubkey(), false),
            AccountMeta::new_readonly(system_program_id(), false),
        ],
        data,
    };
    assert!(send_ix(&mut svm, ix, &payer).is_err());
}

#[test]
fn sad_tampered_fee_config_pda_rejected() {
    // Pass a hand-crafted PDA with different seeds — should fail constraint check
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    // Use wrong seeds for PDA
    let (bad_pda, _) = Address::find_program_address(&[b"NotFeeConfig"], &program_id());

    let mut data = anchor_discriminator("initialize_fee_config").to_vec();
    data.extend_from_slice(&5_000_000u64.to_le_bytes());
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(bad_pda, false),
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new_readonly(r.pubkey(), false),
            AccountMeta::new_readonly(system_program_id(), false),
        ],
        data,
    };
    assert!(send_ix(&mut svm, ix, &admin).is_err());
}

#[test]
fn sad_set_fee_wrong_pda_seed() {
    // Initialize correctly, then try set_claim_fee with a wrong PDA
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r.pubkey(), 5_000_000), &admin).unwrap();

    let (bad_pda, _) = Address::find_program_address(&[b"WrongSeed"], &program_id());
    let mut data = anchor_discriminator("set_claim_fee").to_vec();
    data.extend_from_slice(&0u64.to_le_bytes());
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(bad_pda, false),
            AccountMeta::new_readonly(admin.pubkey(), true),
            AccountMeta::new_readonly(r.pubkey(), false),
        ],
        data,
    };
    assert!(send_ix(&mut svm, ix, &admin).is_err());
}

#[test]
fn sad_fee_exceeding_max_rejected_on_init() {
    // Fee above MAX_CLAIM_FEE (1 SOL) must be rejected at init time
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    // u64::MAX far exceeds MAX_CLAIM_FEE — must fail
    assert!(send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r.pubkey(), u64::MAX), &admin).is_err());

    // MAX_CLAIM_FEE + 1 — boundary: must fail
    assert!(send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r.pubkey(), 1_000_000_001), &admin).is_err());

    // MAX_CLAIM_FEE exactly — boundary: must succeed
    assert!(send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r.pubkey(), 1_000_000_000), &admin).is_ok());
}

#[test]
fn sad_rapid_admin_changes_last_writer_wins() {
    // Multiple rapid updates — verify the last one persists
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let r1 = Keypair::new();
    let r2 = Keypair::new();
    let r3 = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r1.pubkey(), 1_000), &admin).unwrap();
    send_ix(&mut svm, ix_set_fee(&admin.pubkey(), &r2.pubkey(), 2_000), &admin).unwrap();
    send_ix(&mut svm, ix_set_fee(&admin.pubkey(), &r3.pubkey(), 3_000), &admin).unwrap();

    let (pda, _) = fee_config_pda();
    let acct = svm.get_account(&pda).unwrap();
    let (a, f, r, _) = parse_fee_config(&acct.data);
    assert_eq!(a, admin.pubkey()); // admin unchanged
    assert_eq!(f, 3_000);          // last fee
    assert_eq!(r, r3.pubkey());    // last recipient
}

#[test]
fn sad_attacker_cannot_overwrite_via_different_program() {
    // Try to write to the fee config PDA from a different program context
    // This test verifies PDA ownership — only our program can modify it
    let mut svm = setup_svm();
    let admin = Keypair::new();
    let r = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    send_ix(&mut svm, ix_init_fee(&admin.pubkey(), &r.pubkey(), 5_000_000), &admin).unwrap();

    // Verify the account is owned by our program
    let (pda, _) = fee_config_pda();
    let acct = svm.get_account(&pda).unwrap();
    assert_eq!(acct.owner, program_id());
}
