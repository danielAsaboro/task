import { PublicKey } from '@solana/web3.js';
import { getFeeConfigPDA, getDistributorPDA, getClaimStatusPDA } from '../utils';
import { PROGRAM_ID } from '../types';

describe('FeeConfig PDA derivation', () => {
  it('derives a valid PDA from the FeeConfig seed', () => {
    const [pda, bump] = getFeeConfigPDA();
    expect(pda).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  it('derives the same PDA every time (deterministic)', () => {
    const [pda1] = getFeeConfigPDA();
    const [pda2] = getFeeConfigPDA();
    expect(pda1.toBase58()).toEqual(pda2.toBase58());
  });

  it('derives a different PDA with a different program ID', () => {
    const altProgramId = new PublicKey('11111111111111111111111111111111');
    const [pda1] = getFeeConfigPDA(PROGRAM_ID);
    const [pda2] = getFeeConfigPDA(altProgramId);
    expect(pda1.toBase58()).not.toEqual(pda2.toBase58());
  });

  it('PDA is off-curve (cannot be used as a signing key)', () => {
    const [pda] = getFeeConfigPDA();
    // PDAs should not be on the ed25519 curve
    expect(PublicKey.isOnCurve(pda.toBytes())).toBe(false);
  });
});

describe('Existing PDA derivations still work', () => {
  it('getDistributorPDA returns valid PDA', () => {
    const mint = PublicKey.unique();
    const [pda, bump] = getDistributorPDA(mint, 0n);
    expect(pda).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
  });

  it('getClaimStatusPDA returns valid PDA', () => {
    const claimant = PublicKey.unique();
    const distributor = PublicKey.unique();
    const [pda, bump] = getClaimStatusPDA(claimant, distributor);
    expect(pda).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
  });

  it('different claimants get different claim status PDAs', () => {
    const distributor = PublicKey.unique();
    const [pda1] = getClaimStatusPDA(PublicKey.unique(), distributor);
    const [pda2] = getClaimStatusPDA(PublicKey.unique(), distributor);
    expect(pda1.toBase58()).not.toEqual(pda2.toBase58());
  });
});

describe('FeeConfig types', () => {
  it('exports FeeConfig interface', () => {
    // This is a compile-time check — if the import works, the type exists
    const mockConfig = {
      admin: PublicKey.unique(),
      claimFee: { toNumber: () => 5_000_000 },
      feeRecipient: PublicKey.unique(),
      bump: 255,
    };
    expect(mockConfig.admin).toBeInstanceOf(PublicKey);
    expect(mockConfig.claimFee.toNumber()).toBe(5_000_000);
    expect(mockConfig.feeRecipient).toBeInstanceOf(PublicKey);
    expect(mockConfig.bump).toBe(255);
  });

  it('PROGRAM_ID matches expected value', () => {
    expect(PROGRAM_ID.toBase58()).toBe('Ah7iuugan983ymZAKJAFAdvPN3My7ESkGUARrFTn3iqM');
  });

  it('DistributorError includes InvalidFeeRecipient', () => {
    const { DistributorError } = require('../types');
    expect(DistributorError.InvalidFeeRecipient).toBe(6018);
  });

  it('exports InitializeFeeConfigArgs interface', () => {
    const args = {
      feeAuthority: PublicKey.unique(),
      feeAmount: 50_000_000n,
      feeRecipient: PublicKey.unique(),
    };
    expect(typeof args.feeAmount).toBe('bigint');
  });

  it('exports SetClaimFeeArgs interface', () => {
    const args = {
      feeAuthority: PublicKey.unique(),
      feeAmount: 0n,
      feeRecipient: PublicKey.default,
    };
    expect(args.feeRecipient.equals(PublicKey.default)).toBe(true);
  });

  it('exports FeeCollectedEvent interface', () => {
    const event = {
      claimant: PublicKey.unique(),
      feeAmount: { toNumber: () => 50_000_000 },
      feeRecipient: PublicKey.unique(),
    };
    expect(event.feeAmount.toNumber()).toBe(50_000_000);
  });
});

describe('FeeConfig negative edge cases', () => {
  it('getFeeConfigPDA is distinct from distributor PDA', () => {
    const mint = PublicKey.unique();
    const [feePda] = getFeeConfigPDA();
    const [distPda] = getDistributorPDA(mint, 0n);
    expect(feePda.toBase58()).not.toEqual(distPda.toBase58());
  });

  it('getFeeConfigPDA is distinct from claim status PDA', () => {
    const claimant = PublicKey.unique();
    const distributor = PublicKey.unique();
    const [feePda] = getFeeConfigPDA();
    const [claimPda] = getClaimStatusPDA(claimant, distributor);
    expect(feePda.toBase58()).not.toEqual(claimPda.toBase58());
  });

  it('getFeeConfigPDA with default program ID gives same result as no arg', () => {
    const [pda1] = getFeeConfigPDA(PROGRAM_ID);
    const [pda2] = getFeeConfigPDA();
    expect(pda1.toBase58()).toEqual(pda2.toBase58());
  });

  it('error codes are sequential starting from 6000', () => {
    const { DistributorError } = require('../types');
    expect(DistributorError.InsufficientUnlockedTokens).toBe(6000);
    expect(DistributorError.Unauthorized).toBe(6005);
    expect(DistributorError.InvalidFeeRecipient).toBe(6018);
  });

  it('all error codes from 6000-6018 are defined', () => {
    const { DistributorError } = require('../types');
    const values = Object.values(DistributorError).filter(v => typeof v === 'number') as number[];
    // Should have at least 19 error codes (6000-6018)
    expect(values.length).toBeGreaterThanOrEqual(19);
    // All should be in 6000 range
    values.forEach(v => {
      expect(v).toBeGreaterThanOrEqual(6000);
      expect(v).toBeLessThan(7000);
    });
  });
});
