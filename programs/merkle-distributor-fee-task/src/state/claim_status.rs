use anchor_lang::prelude::*;

use crate::error::ErrorCode::ArithmeticError;

/// Holds whether or not a claimant has claimed tokens.
#[account]
#[derive(Default)]
pub struct ClaimStatus {
    /// Authority that claimed the tokens.
    pub claimant: Pubkey,
    /// Locked amount
    pub locked_amount: u64,
    /// Locked amount withdrawn
    pub locked_amount_withdrawn: u64,
    /// Unlocked amount
    pub unlocked_amount: u64,
    /// Whether the claim fee has been paid
    pub fee_paid: bool,
}

impl ClaimStatus {
    pub const LEN: usize = 8 + std::mem::size_of::<ClaimStatus>();

    #[allow(clippy::result_large_err)]
    pub fn amount_withdrawable(&self, curr_ts: i64, start_ts: i64, end_ts: i64) -> Result<u64> {
        let amount = self
            .unlocked_amount(curr_ts, start_ts, end_ts)?
            .checked_sub(self.locked_amount_withdrawn)
            .ok_or(ArithmeticError)?;
        Ok(amount)
    }

    #[allow(clippy::result_large_err)]
    pub fn unlocked_amount(&self, curr_ts: i64, start_ts: i64, end_ts: i64) -> Result<u64> {
        if curr_ts >= start_ts {
            if curr_ts >= end_ts {
                Ok(self.locked_amount)
            } else {
                let time_into_unlock = curr_ts.checked_sub(start_ts).ok_or(ArithmeticError)?;
                let total_unlock_time = end_ts.checked_sub(start_ts).ok_or(ArithmeticError)?;
                let amount = ((time_into_unlock as u128)
                    .checked_mul(self.locked_amount as u128)
                    .ok_or(ArithmeticError)?)
                .checked_div(total_unlock_time as u128)
                .ok_or(ArithmeticError)? as u64;
                Ok(amount)
            }
        } else {
            Ok(0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normal_unlocking_scenario() {
        let claim_status = ClaimStatus {
            claimant: Pubkey::new_unique(),
            locked_amount: 100,
            unlocked_amount: 0,
            locked_amount_withdrawn: 0,
            fee_paid: false,
        };
        assert_eq!(claim_status.unlocked_amount(50, 0, 100), Ok(50));
    }

    #[test]
    fn test_proportional_unlocking() {
        let claim_status = ClaimStatus {
            claimant: Pubkey::new_unique(),
            locked_amount: 100,
            locked_amount_withdrawn: 0,
            unlocked_amount: 0,
            fee_paid: false,
        };
        assert_eq!(claim_status.unlocked_amount(0, 0, 100), Ok(0));
        assert_eq!(claim_status.unlocked_amount(25, 0, 100), Ok(25));
        assert_eq!(claim_status.unlocked_amount(50, 0, 100), Ok(50));
        assert_eq!(claim_status.unlocked_amount(75, 0, 100), Ok(75));
        assert_eq!(claim_status.unlocked_amount(100, 0, 100), Ok(100));
    }

    #[test]
    fn test_unlocking_after_end_time() {
        let claim_status = ClaimStatus {
            claimant: Pubkey::new_unique(),
            locked_amount: 100,
            unlocked_amount: 0,
            locked_amount_withdrawn: 0,
            fee_paid: false,
        };
        assert_eq!(claim_status.unlocked_amount(150, 0, 100), Ok(100));
    }

    #[test]
    fn test_partial_withdraw() {
        for (curr_ts, expected, locked_amount_withdrawn) in [
            (0, 0, 0),
            (10, 0, 10),
            (20, 0, 20),
            (50, 0, 50),
            (50, 25, 25),
            (70, 10, 60),
            (100, 90, 10),
            (100, 0, 100),
        ] {
            let claim_status = ClaimStatus {
                claimant: Pubkey::new_unique(),
                locked_amount: 100,
                unlocked_amount: 0,
                locked_amount_withdrawn,
                fee_paid: false,
            };
            assert_eq!(claim_status.amount_withdrawable(curr_ts, 0, 100), Ok(expected));
        }
    }
}
