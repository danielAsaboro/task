use trident_fuzz::fuzzing::*;

/// Storage for all account addresses used in fuzz testing.
///
/// This struct serves as a centralized repository for account addresses,
/// enabling their reuse across different instruction flows and test scenarios.
///
/// Docs: https://ackee.xyz/trident/docs/latest/trident-api-macro/trident-types/fuzz-accounts/
#[derive(Default)]
pub struct AccountAddresses {
    pub distributor: AddressStorage,

    pub claim_status: AddressStorage,

    pub from: AddressStorage,

    pub to: AddressStorage,

    pub claimant: AddressStorage,

    pub token_program: AddressStorage,

    pub fee_config: AddressStorage,

    pub fee_recipient: AddressStorage,

    pub system_program: AddressStorage,

    pub admin: AddressStorage,

    pub clawback_receiver: AddressStorage,

    pub mint: AddressStorage,

    pub token_vault: AddressStorage,

    pub associated_token_program: AddressStorage,

    pub new_admin: AddressStorage,

    pub new_fee_recipient: AddressStorage,

    pub new_clawback_account: AddressStorage,
}
