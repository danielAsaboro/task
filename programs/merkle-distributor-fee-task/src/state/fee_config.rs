use anchor_lang::prelude::*;

/// Global fee configuration for the protocol.
/// Single PDA per program — controls claim fees across all distributors.
#[account]
#[derive(Default, Debug)]
pub struct FeeConfig {
    /// Admin authority that can update fee settings.
    pub admin: Pubkey,
    /// Flat fee in lamports charged per claim.
    pub claim_fee: u64,
    /// Wallet that receives collected fees.
    pub fee_recipient: Pubkey,
    /// PDA bump seed.
    pub bump: u8,
}

impl FeeConfig {
    pub const LEN: usize = 8 + std::mem::size_of::<FeeConfig>();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fee_config_len() {
        assert_eq!(FeeConfig::LEN, 8 + std::mem::size_of::<FeeConfig>());
        assert!(FeeConfig::LEN >= 8 + 32 + 8 + 32 + 1);
    }

    #[test]
    fn test_fee_config_default() {
        let config = FeeConfig::default();
        assert_eq!(config.admin, Pubkey::default());
        assert_eq!(config.claim_fee, 0);
        assert_eq!(config.fee_recipient, Pubkey::default());
        assert_eq!(config.bump, 0);
    }

    #[test]
    fn test_fee_config_initialization() {
        let admin = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let config = FeeConfig {
            admin,
            claim_fee: 5_000_000,
            fee_recipient: recipient,
            bump: 255,
        };
        assert_eq!(config.admin, admin);
        assert_eq!(config.claim_fee, 5_000_000);
        assert_eq!(config.fee_recipient, recipient);
        assert_eq!(config.bump, 255);
    }

    #[test]
    fn test_fee_config_zero_fee() {
        let config = FeeConfig {
            admin: Pubkey::new_unique(),
            claim_fee: 0,
            fee_recipient: Pubkey::default(),
            bump: 1,
        };
        assert_eq!(config.claim_fee, 0);
    }

    #[test]
    fn test_fee_config_max_fee() {
        let config = FeeConfig {
            admin: Pubkey::new_unique(),
            claim_fee: u64::MAX,
            fee_recipient: Pubkey::new_unique(),
            bump: 1,
        };
        assert_eq!(config.claim_fee, u64::MAX);
    }
}
