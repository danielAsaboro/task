use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
mod types;
use types::merkle_distributor_fee_task as mdt;

fn pid() -> Pubkey {
    mdt::program_id()
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
        }
    }

    #[init]
    fn start(&mut self) {
        let admin_kp = self.trident.random_keypair();
        let admin_pk = admin_kp.pubkey();
        self.trident.airdrop(&admin_pk, 50_000_000_000);
        self.fuzz_accounts.admin.insert_with_address(admin_pk);

        let recipient_pk = self.trident.random_pubkey();
        self.fuzz_accounts.fee_recipient.insert_with_address(recipient_pk);

        let (fee_config_pda, _) = Pubkey::find_program_address(&[b"FeeConfig"], &pid());
        self.fuzz_accounts.fee_config.insert_with_address(fee_config_pda);
    }

    /// Fuzz initialize_fee_config with random fee amounts
    #[flow]
    fn initialize_fee_config(&mut self) {
        let admin_pk = match self.fuzz_accounts.admin.get(&mut self.trident) {
            Some(pk) => pk,
            None => return,
        };
        let recipient_pk = match self.fuzz_accounts.fee_recipient.get(&mut self.trident) {
            Some(pk) => pk,
            None => return,
        };

        let claim_fee: u64 = self.trident.random_from_range(0..=10_000_000_000u64);

        let ix = mdt::InitializeFeeConfigInstruction::data(
            mdt::InitializeFeeConfigInstructionData::new(claim_fee),
        )
        .accounts(mdt::InitializeFeeConfigInstructionAccounts::new(
            Pubkey::find_program_address(&[b"FeeConfig"], &pid()).0,
            admin_pk,
            recipient_pk,
        ))
        .instruction();

        let _result = self.trident.process_transaction(&[ix], Some("init_fee_config"));
    }

    /// Fuzz set_claim_fee with random fee values
    #[flow]
    fn set_claim_fee(&mut self) {
        let admin_pk = match self.fuzz_accounts.admin.get(&mut self.trident) {
            Some(pk) => pk,
            None => return,
        };

        let new_recipient = self.trident.random_pubkey();
        let claim_fee: u64 = self.trident.random_from_range(0..=10_000_000_000u64);

        let ix = mdt::SetClaimFeeInstruction::data(
            mdt::SetClaimFeeInstructionData::new(claim_fee),
        )
        .accounts(mdt::SetClaimFeeInstructionAccounts::new(
            Pubkey::find_program_address(&[b"FeeConfig"], &pid()).0,
            admin_pk,
            new_recipient,
        ))
        .instruction();

        let _result = self.trident.process_transaction(&[ix], Some("set_claim_fee"));
    }

    /// Invariant: non-admin must NEVER succeed at setting fee
    #[flow]
    fn non_admin_set_fee(&mut self) {
        let attacker = self.trident.random_keypair();
        self.trident.airdrop(&attacker.pubkey(), 5_000_000_000);

        let ix = mdt::SetClaimFeeInstruction::data(
            mdt::SetClaimFeeInstructionData::new(0),
        )
        .accounts(mdt::SetClaimFeeInstructionAccounts::new(
            Pubkey::find_program_address(&[b"FeeConfig"], &pid()).0,
            attacker.pubkey(),
            attacker.pubkey(),
        ))
        .instruction();

        let result = self.trident.process_transaction(&[ix], Some("non_admin_set_fee"));
        assert!(
            result.is_error(),
            "INVARIANT VIOLATED: non-admin was able to set claim fee!"
        );
    }

    #[end]
    fn end(&mut self) {}
}

fn main() {
    FuzzTest::fuzz(500, 50);
}
