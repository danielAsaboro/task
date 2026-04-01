import { 
  PublicKey, 
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  Transaction,
} from '@solana/web3.js';
import { 
  Program, 
  AnchorProvider, 
  BN 
} from '@coral-xyz/anchor';
import { 
  TOKEN_PROGRAM_ID, 
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress 
} from '@solana/spl-token';

import idl from '../idl/merkle_distributor.json';
import {
  PROGRAM_ID,
  MerkleDistributor as MerkleDistributorAccount,
  ClaimStatus,
  CreateDistributorArgs,
  CreateDistributorWithUnlockDateArgs,
  CreateDistributorWithLinearVestingArgs,
  DistributorVestingSchedule,
  CliffClaimAmounts,
  LinearVestingAmounts,
  VestingInfo,
  WithdrawableInfo,
  ClaimArgs,
  ClaimLockedArgs,
  FeeConfig,
  InitializeFeeConfigArgs,
  SetClaimFeeArgs,
  SetFeeAdminArgs,
  MAX_CLAIM_FEE,
} from './types';
import {
  getDistributorPDA,
  getClaimStatusPDA,
  getFeeConfigPDA,
  bigintToBN,
  validateTimestamps,
  validateMerkleProof
} from './utils';

/**
 * Known Anchor/program error codes mapped to user-friendly messages.
 */
export const ERROR_MESSAGES: Record<number, string> = {
  6000: 'No unlocked tokens available to withdraw yet. Vesting may not have started or all vested tokens have been claimed.',
  6002: 'Invalid Merkle proof. The proof does not match the on-chain Merkle root for this distributor.',
  6003: 'Total claimed amount exceeds the maximum allowed for this distributor.',
  6004: 'Maximum number of claimants reached for this distributor.',
  6005: 'Unauthorized. Only the fee config admin can perform this action.',
  6006: 'Token account owner does not match the claimant.',
  6013: 'This distribution has been clawed back and claims are no longer accepted.',
  6014: 'Arithmetic overflow — claim amounts may be too large.',
  6015: 'Start vesting timestamp must be before end vesting timestamp.',
  6016: 'Timestamps must be in the future.',
  6017: 'A distributor with this version already exists for this mint.',
  6018: 'Fee recipient address does not match the fee configuration. Use getFeeConfig() to check the current recipient.',
  6019: 'New and old fee admin are identical.',
  6020: 'Claim fee exceeds the maximum allowed (1 SOL).',
};

/**
 * Parses an Anchor/program error and returns a user-friendly message.
 * Falls back to the original error if no mapping exists.
 */
export function formatError(err: any, context: string): Error {
  const errStr = err?.toString?.() ?? String(err);

  // Try to extract Anchor error code
  const codeMatch = errStr.match(/Error Number: (\d+)/);
  if (codeMatch) {
    const code = parseInt(codeMatch[1], 10);
    const friendly = ERROR_MESSAGES[code];
    if (friendly) {
      return new Error(`${context}: ${friendly} (error ${code})`);
    }
  }

  // Check for common Solana RPC errors
  if (errStr.includes('AccountNotFound') || errStr.includes('Account does not exist')) {
    return new Error(`${context}: Account not found on-chain. Has the fee config been initialized?`);
  }
  if (errStr.includes('insufficient') || errStr.includes('0x1')) {
    return new Error(`${context}: Insufficient SOL balance. The claimant needs enough SOL to cover the claim fee and transaction fees.`);
  }
  if (errStr.includes('already in use') || errStr.includes('0x0')) {
    return new Error(`${context}: Account already initialized. Fee config can only be initialized once.`);
  }

  return new Error(`${context}: ${errStr}`);
}

/**
 * MerkleDistributor SDK class providing a clean interface to the Anchor program
 */
export class MerkleDistributor {
  public readonly program: Program;
  public readonly provider: AnchorProvider;
  public readonly programId: PublicKey;
  private static readonly DEFAULT_CLAWBACK_DELAY_SECONDS = 30n * 24n * 60n * 60n;

  constructor(provider: AnchorProvider, programId?: PublicKey) {
    this.provider = provider;
    this.programId = programId || PROGRAM_ID;
    this.program = new Program(idl as any, this.programId, provider);
  }

  private async buildCreateDistributorContext(args: CreateDistributorArgs): Promise<{
    distributorPDA: PublicKey;
    distributorTokenAccount: PublicKey;
    anchorArgs: {
      version: any;
      root: number[];
      maxTotalClaim: any;
      maxNumNodes: any;
      startVestingTs: any;
      endVestingTs: any;
      clawbackStartTs: any;
    };
  }> {
    // Validate timestamps before building instruction payload.
    const timestampValidation = validateTimestamps(
      args.startVestingTs,
      args.endVestingTs,
      args.clawbackStartTs
    );

    if (!timestampValidation.valid) {
      throw new Error(`Invalid timestamps: ${timestampValidation.error}`);
    }

    const versionBuffer = Buffer.alloc(8);
    versionBuffer.writeBigUInt64LE(args.version);
    const [distributorPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('MerkleDistributor'),
        args.mint.toBuffer(),
        versionBuffer
      ],
      this.programId
    );

    const distributorTokenAccount = await getAssociatedTokenAddress(
      args.mint,
      distributorPDA,
      true // allowOwnerOffCurve
    );

    const anchorArgs = {
      version: bigintToBN(args.version),
      root: Array.from(args.root),
      maxTotalClaim: bigintToBN(args.maxTotalClaim),
      maxNumNodes: bigintToBN(args.maxNumNodes),
      startVestingTs: bigintToBN(args.startVestingTs),
      endVestingTs: bigintToBN(args.endVestingTs),
      clawbackStartTs: bigintToBN(args.clawbackStartTs),
    };

    return {
      distributorPDA,
      distributorTokenAccount,
      anchorArgs,
    };
  }

  private normalizeUnlockDateArgs(args: CreateDistributorWithUnlockDateArgs): CreateDistributorArgs {
    const schedule = this.buildUnlockDateSchedule(args.unlockTs, {
      clawbackStartTs: args.clawbackStartTs,
      clawbackDelaySeconds: args.clawbackDelaySeconds,
    });

    return {
      mint: args.mint,
      version: args.version,
      root: args.root,
      maxTotalClaim: args.maxTotalClaim,
      maxNumNodes: args.maxNumNodes,
      startVestingTs: schedule.startVestingTs,
      endVestingTs: schedule.endVestingTs,
      clawbackStartTs: schedule.clawbackStartTs,
      clawbackReceiver: args.clawbackReceiver,
      admin: args.admin,
    };
  }

  /**
   * Builds a cliff vesting schedule from a single unlock timestamp.
   *
   * On-chain requires `start_vesting_ts < end_vesting_ts`, so we model
   * unlock as a 1-second vesting window that fully unlocks at `unlockTs`.
   */
  buildUnlockDateSchedule(
    unlockTs: bigint,
    options: {
      clawbackStartTs?: bigint;
      clawbackDelaySeconds?: bigint;
    } = {}
  ): DistributorVestingSchedule {
    const { clawbackStartTs, clawbackDelaySeconds } = options;

    if (clawbackStartTs !== undefined && clawbackDelaySeconds !== undefined) {
      throw new Error('Provide either clawbackStartTs or clawbackDelaySeconds, not both');
    }

    if (clawbackDelaySeconds !== undefined && clawbackDelaySeconds <= 0n) {
      throw new Error('clawbackDelaySeconds must be greater than zero');
    }

    if (unlockTs <= 0n) {
      throw new Error('unlockTs must be greater than zero');
    }

    const startVestingTs = unlockTs - 1n;
    const endVestingTs = unlockTs;
    const resolvedClawbackStartTs = clawbackStartTs
      ?? endVestingTs + (clawbackDelaySeconds ?? MerkleDistributor.DEFAULT_CLAWBACK_DELAY_SECONDS);

    return {
      startVestingTs,
      endVestingTs,
      clawbackStartTs: resolvedClawbackStartTs,
    };
  }

  /**
   * Returns claim amounts for a cliff unlock leaf.
   * Use this helper when all recipient tokens should unlock only at unlockTs.
   */
  buildCliffClaimAmounts(totalAmount: bigint): CliffClaimAmounts {
    if (totalAmount < 0n) {
      throw new Error('totalAmount cannot be negative');
    }

    return {
      amountUnlocked: 0n,
      amountLocked: totalAmount,
    };
  }

  // ── Linear vesting helpers ───────────────────────────────────────────

  /**
   * Builds a linear vesting schedule from start/end timestamps.
   * Tokens vest continuously between startVestingTs and endVestingTs.
   */
  buildLinearVestingSchedule(
    startVestingTs: bigint,
    endVestingTs: bigint,
    options: {
      clawbackStartTs?: bigint;
      clawbackDelaySeconds?: bigint;
    } = {}
  ): DistributorVestingSchedule {
    const { clawbackStartTs, clawbackDelaySeconds } = options;

    if (clawbackStartTs !== undefined && clawbackDelaySeconds !== undefined) {
      throw new Error('Provide either clawbackStartTs or clawbackDelaySeconds, not both');
    }

    if (clawbackDelaySeconds !== undefined && clawbackDelaySeconds <= 0n) {
      throw new Error('clawbackDelaySeconds must be greater than zero');
    }

    if (startVestingTs >= endVestingTs) {
      throw new Error('startVestingTs must be before endVestingTs');
    }

    const resolvedClawbackStartTs = clawbackStartTs
      ?? endVestingTs + (clawbackDelaySeconds ?? MerkleDistributor.DEFAULT_CLAWBACK_DELAY_SECONDS);

    return {
      startVestingTs,
      endVestingTs,
      clawbackStartTs: resolvedClawbackStartTs,
    };
  }

  /**
   * Returns claim amounts for a linear vesting leaf.
   * @param totalAmount Total tokens for this recipient
   * @param immediateUnlockFraction Fraction (0..1) available immediately. Default 0.
   */
  buildLinearVestingAmounts(totalAmount: bigint, immediateUnlockFraction: number = 0): LinearVestingAmounts {
    if (totalAmount < 0n) {
      throw new Error('totalAmount cannot be negative');
    }
    if (immediateUnlockFraction < 0 || immediateUnlockFraction > 1) {
      throw new Error('immediateUnlockFraction must be between 0 and 1');
    }

    const amountUnlocked = BigInt(Math.floor(Number(totalAmount) * immediateUnlockFraction));
    const amountLocked = totalAmount - amountUnlocked;

    return { amountUnlocked, amountLocked };
  }

  private normalizeLinearVestingArgs(args: CreateDistributorWithLinearVestingArgs): CreateDistributorArgs {
    const schedule = this.buildLinearVestingSchedule(args.startVestingTs, args.endVestingTs, {
      clawbackStartTs: args.clawbackStartTs,
      clawbackDelaySeconds: args.clawbackDelaySeconds,
    });

    return {
      mint: args.mint,
      version: args.version,
      root: args.root,
      maxTotalClaim: args.maxTotalClaim,
      maxNumNodes: args.maxNumNodes,
      startVestingTs: schedule.startVestingTs,
      endVestingTs: schedule.endVestingTs,
      clawbackStartTs: schedule.clawbackStartTs,
      clawbackReceiver: args.clawbackReceiver,
      admin: args.admin,
    };
  }

  /**
   * Creates a new merkle distributor with linear vesting.
   * Tokens vest continuously between startVestingTs and endVestingTs.
   */
  async createDistributorWithLinearVesting(args: CreateDistributorWithLinearVestingArgs): Promise<string> {
    const normalizedArgs = this.normalizeLinearVestingArgs(args);
    return this.createDistributor(normalizedArgs);
  }

  /**
   * Creates a transaction instruction for a linear vesting distributor.
   */
  async createDistributorWithLinearVestingInstruction(
    args: CreateDistributorWithLinearVestingArgs
  ): Promise<TransactionInstruction> {
    const normalizedArgs = this.normalizeLinearVestingArgs(args);
    return this.createDistributorInstruction(normalizedArgs);
  }

  // ── Vesting introspection ──────────────────────────────────────────

  /**
   * Determines the vesting type and state of a distributor.
   * Cliff = endTs - startTs <= 1 second (SDK convention).
   * Linear = any larger window.
   * @param distributor Distributor public key or already-fetched account
   * @param nowUnix Optional override for current time (unix seconds)
   */
  async getVestingInfo(
    distributor: PublicKey | MerkleDistributorAccount,
    nowUnix?: number
  ): Promise<VestingInfo> {
    const account = distributor instanceof PublicKey
      ? await this.getDistributor(distributor)
      : distributor;

    const startTs = BigInt(account.startTs.toString());
    const endTs = BigInt(account.endTs.toString());
    const durationSeconds = endTs - startTs;
    const type = durationSeconds <= 1n ? 'cliff' : 'linear';

    const now = BigInt(nowUnix ?? Math.floor(Date.now() / 1000));
    let vestedFraction: number;
    if (now >= endTs) {
      vestedFraction = 1;
    } else if (now <= startTs) {
      vestedFraction = 0;
    } else {
      vestedFraction = Number(now - startTs) / Number(durationSeconds);
    }

    return { type, startTs, endTs, durationSeconds, vestedFraction };
  }

  /**
   * Computes how many locked tokens a claimant can withdraw right now.
   * Mirrors the on-chain linear formula: (elapsed / total) * lockedAmount - alreadyWithdrawn.
   */
  async getWithdrawableAmount(
    claimant: PublicKey,
    distributor: PublicKey,
    nowUnix?: number
  ): Promise<WithdrawableInfo | null> {
    const [account, claimStatus] = await Promise.all([
      this.getDistributor(distributor),
      this.getClaimStatusForClaimant(claimant, distributor),
    ]);

    if (!claimStatus) return null;

    const startTs = BigInt(account.startTs.toString());
    const endTs = BigInt(account.endTs.toString());
    const lockedAmount = BigInt(claimStatus.lockedAmount.toString());
    const lockedAmountWithdrawn = BigInt(claimStatus.lockedAmountWithdrawn.toString());

    const now = BigInt(nowUnix ?? Math.floor(Date.now() / 1000));

    let vestedAmount: bigint;
    if (now >= endTs) {
      vestedAmount = lockedAmount;
    } else if (now <= startTs) {
      vestedAmount = 0n;
    } else {
      // Match on-chain: (elapsed * lockedAmount) / totalDuration
      const elapsed = now - startTs;
      const total = endTs - startTs;
      vestedAmount = (elapsed * lockedAmount) / total;
    }

    const withdrawable = vestedAmount - lockedAmountWithdrawn;

    return { lockedAmount, lockedAmountWithdrawn, vestedAmount, withdrawable };
  }

  /**
   * Creates a new merkle distributor
   * @param args CreateDistributorArgs
   * @returns Transaction signature
   */
  async createDistributor(args: CreateDistributorArgs): Promise<string> {
    const { distributorPDA, distributorTokenAccount, anchorArgs } = await this.buildCreateDistributorContext(args);

    const signature = await this.program.methods
      .newDistributor(
        anchorArgs.version,
        anchorArgs.root,
        anchorArgs.maxTotalClaim,
        anchorArgs.maxNumNodes,
        anchorArgs.startVestingTs,
        anchorArgs.endVestingTs,
        anchorArgs.clawbackStartTs
      )
      .accounts({
        distributor: distributorPDA,
        clawbackReceiver: args.clawbackReceiver,
        mint: args.mint,
        tokenVault: distributorTokenAccount,
        admin: args.admin,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    return signature;
  }

  /**
   * Creates a new merkle distributor using a single unlock date (cliff vesting).
   * This maps unlockTs to startVestingTs/endVestingTs under the hood.
   *
   * Important:
   * To block claims before unlock date, merkle leaves must use locked amounts.
   */
  async createDistributorWithUnlockDate(args: CreateDistributorWithUnlockDateArgs): Promise<string> {
    const normalizedArgs = this.normalizeUnlockDateArgs(args);
    return this.createDistributor(normalizedArgs);
  }

  /**
   * Creates a transaction instruction for creating a new merkle distributor
   * @param args CreateDistributorArgs
   * @returns TransactionInstruction
   */
  async createDistributorInstruction(args: CreateDistributorArgs): Promise<TransactionInstruction> {
    const { distributorPDA, distributorTokenAccount, anchorArgs } = await this.buildCreateDistributorContext(args);

    const instruction = await this.program.methods
      .newDistributor(
        anchorArgs.version,
        anchorArgs.root,
        anchorArgs.maxTotalClaim,
        anchorArgs.maxNumNodes,
        anchorArgs.startVestingTs,
        anchorArgs.endVestingTs,
        anchorArgs.clawbackStartTs
      )
      .accounts({
        distributor: distributorPDA,
        clawbackReceiver: args.clawbackReceiver,
        mint: args.mint,
        tokenVault: distributorTokenAccount,
        admin: args.admin,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    return instruction;
  }

  /**
   * Creates a transaction instruction for a cliff vesting distributor with unlock date.
   */
  async createDistributorWithUnlockDateInstruction(
    args: CreateDistributorWithUnlockDateArgs
  ): Promise<TransactionInstruction> {
    const normalizedArgs = this.normalizeUnlockDateArgs(args);
    return this.createDistributorInstruction(normalizedArgs);
  }

  /**
   * Claims tokens from the distributor
   * @param args ClaimArgs
   * @returns Transaction signature
   */
  async claim(args: ClaimArgs): Promise<string> {
    // Validate proof format
    if (!validateMerkleProof(args.proof)) {
      throw new Error('Invalid merkle proof format');
    }

    // Get distributor info and fee config to derive accounts
    const [distributorInfo, feeConfig] = await Promise.all([
      this.getDistributor(args.distributor),
      this.getFeeConfig(),
    ]);

    // Derive PDAs using the custom program ID
    const [claimStatusPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('ClaimStatus'),
        args.claimant.toBuffer(),
        args.distributor.toBuffer()
      ],
      this.programId
    );

    const [feeConfigPDA] = getFeeConfigPDA(this.programId);

    const distributorTokenAccount = await getAssociatedTokenAddress(
      distributorInfo.mint,
      args.distributor,
      true // allowOwnerOffCurve
    );

    // Convert proof to the format expected by Anchor
    const anchorProof = args.proof.map(p => Array.from(p));

    try {
      const signature = await this.program.methods
        .newClaim(
          bigintToBN(args.amountUnlocked),
          bigintToBN(args.amountLocked),
          anchorProof
        )
        .accounts({
          distributor: args.distributor,
          claimStatus: claimStatusPDA,
          from: distributorTokenAccount,
          to: args.claimantTokenAccount,
          claimant: args.claimant,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          feeConfig: feeConfigPDA,
          feeRecipient: feeConfig.feeRecipient,
        })
        .rpc();

      return signature;
    } catch (err) {
      throw formatError(err, 'claim');
    }
  }

  /**
   * Creates a transaction instruction for claiming tokens
   * @param args ClaimArgs
   * @returns TransactionInstruction
   */
  async claimInstruction(args: ClaimArgs): Promise<TransactionInstruction> {
    // Validate proof format
    if (!validateMerkleProof(args.proof)) {
      throw new Error('Invalid merkle proof format');
    }

    // Get distributor info and fee config to derive accounts
    const [distributorInfo, feeConfig] = await Promise.all([
      this.getDistributor(args.distributor),
      this.getFeeConfig(),
    ]);

    // Derive PDAs using the custom program ID
    const [claimStatusPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('ClaimStatus'),
        args.claimant.toBuffer(),
        args.distributor.toBuffer()
      ],
      this.programId
    );

    const [feeConfigPDA] = getFeeConfigPDA(this.programId);

    const distributorTokenAccount = await getAssociatedTokenAddress(
      distributorInfo.mint,
      args.distributor,
      true // allowOwnerOffCurve
    );

    // Convert proof to the format expected by Anchor
    const anchorProof = args.proof.map(p => Array.from(p));

    const instruction = await this.program.methods
      .newClaim(
        bigintToBN(args.amountUnlocked),
        bigintToBN(args.amountLocked),
        anchorProof
      )
      .accounts({
        distributor: args.distributor,
        claimStatus: claimStatusPDA,
        from: distributorTokenAccount,
        to: args.claimantTokenAccount,
        claimant: args.claimant,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeConfig: feeConfigPDA,
        feeRecipient: feeConfig.feeRecipient,
      })
      .instruction();

    return instruction;
  }

  /**
   * Claims locked tokens after vesting period
   * @param args ClaimLockedArgs
   * @returns Transaction signature
   */
  async claimLocked(args: ClaimLockedArgs): Promise<string> {
    // Get distributor info and fee config to derive accounts
    const [distributorInfo, feeConfig] = await Promise.all([
      this.getDistributor(args.distributor),
      this.getFeeConfig(),
    ]);

    // Derive PDAs using the custom program ID
    const [claimStatusPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('ClaimStatus'),
        args.claimant.toBuffer(),
        args.distributor.toBuffer()
      ],
      this.programId
    );

    const [feeConfigPDA] = getFeeConfigPDA(this.programId);

    const distributorTokenAccount = await getAssociatedTokenAddress(
      distributorInfo.mint,
      args.distributor,
      true // allowOwnerOffCurve
    );

    try {
      const signature = await this.program.methods
        .claimLocked()
        .accounts({
          distributor: args.distributor,
          claimStatus: claimStatusPDA,
          from: distributorTokenAccount,
          to: args.claimantTokenAccount,
          claimant: args.claimant,
          tokenProgram: TOKEN_PROGRAM_ID,
          feeConfig: feeConfigPDA,
          feeRecipient: feeConfig.feeRecipient,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      return signature;
    } catch (err) {
      throw formatError(err, 'claimLocked');
    }
  }

  /**
   * Creates a transaction instruction for claiming locked tokens
   * @param args ClaimLockedArgs
   * @returns TransactionInstruction
   */
  async claimLockedInstruction(args: ClaimLockedArgs): Promise<TransactionInstruction> {
    // Get distributor info and fee config to derive accounts
    const [distributorInfo, feeConfig] = await Promise.all([
      this.getDistributor(args.distributor),
      this.getFeeConfig(),
    ]);

    // Derive PDAs using the custom program ID
    const [claimStatusPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('ClaimStatus'),
        args.claimant.toBuffer(),
        args.distributor.toBuffer()
      ],
      this.programId
    );

    const [feeConfigPDA] = getFeeConfigPDA(this.programId);

    const distributorTokenAccount = await getAssociatedTokenAddress(
      distributorInfo.mint,
      args.distributor,
      true // allowOwnerOffCurve
    );

    const instruction = await this.program.methods
      .claimLocked()
      .accounts({
        distributor: args.distributor,
        claimStatus: claimStatusPDA,
        from: distributorTokenAccount,
        to: args.claimantTokenAccount,
        claimant: args.claimant,
        tokenProgram: TOKEN_PROGRAM_ID,
        feeConfig: feeConfigPDA,
        feeRecipient: feeConfig.feeRecipient,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    return instruction;
  }

  /**
   * Claws back remaining tokens to the clawback receiver
   * @param distributor Distributor public key
   * @param claimant Claimant public key (can be anyone after clawback period)
   * @returns Transaction signature
   */
  async clawback(distributor: PublicKey, claimant: PublicKey): Promise<string> {
    // Get distributor info
    const distributorInfo = await this.getDistributor(distributor);
    
    const distributorTokenAccount = await getAssociatedTokenAddress(
      distributorInfo.mint,
      distributor,
      true // allowOwnerOffCurve
    );

    const clawbackTokenAccount = await getAssociatedTokenAddress(
      distributorInfo.mint,
      distributorInfo.clawbackReceiver
    );

    const signature = await this.program.methods
      .clawback()
      .accounts({
        distributor,
        from: distributorTokenAccount,
        to: clawbackTokenAccount,
        claimant,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    return signature;
  }

  /**
   * Creates a transaction instruction for clawing back tokens
   * @param distributor Distributor public key
   * @param claimant Claimant public key (can be anyone after clawback period)
   * @returns TransactionInstruction
   */
  async clawbackInstruction(distributor: PublicKey, claimant: PublicKey): Promise<TransactionInstruction> {
    // Get distributor info
    const distributorInfo = await this.getDistributor(distributor);
    
    const distributorTokenAccount = await getAssociatedTokenAddress(
      distributorInfo.mint,
      distributor,
      true // allowOwnerOffCurve
    );

    const clawbackTokenAccount = await getAssociatedTokenAddress(
      distributorInfo.mint,
      distributorInfo.clawbackReceiver
    );

    const instruction = await this.program.methods
      .clawback()
      .accounts({
        distributor,
        from: distributorTokenAccount,
        to: clawbackTokenAccount,
        claimant,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    return instruction;
  }

  /**
   * Sets a new admin for the distributor
   * @param distributor Distributor public key
   * @param currentAdmin Current admin public key
   * @param newAdmin New admin public key
   * @returns Transaction signature
   */
  async setAdmin(distributor: PublicKey, currentAdmin: PublicKey, newAdmin: PublicKey): Promise<string> {
    const signature = await this.program.methods
      .setAdmin()
      .accounts({
        distributor,
        admin: currentAdmin,
        newAdmin,
      })
      .rpc();

    return signature;
  }

  /**
   * Creates a transaction instruction for setting a new admin
   * @param distributor Distributor public key
   * @param currentAdmin Current admin public key
   * @param newAdmin New admin public key
   * @returns TransactionInstruction
   */
  async setAdminInstruction(distributor: PublicKey, currentAdmin: PublicKey, newAdmin: PublicKey): Promise<TransactionInstruction> {
    const instruction = await this.program.methods
      .setAdmin()
      .accounts({
        distributor,
        admin: currentAdmin,
        newAdmin,
      })
      .instruction();

    return instruction;
  }

  /**
   * Sets a new clawback receiver for the distributor
   * @param distributor Distributor public key
   * @param newClawbackReceiver New clawback receiver public key
   * @param admin Admin public key
   * @returns Transaction signature
   */
  async setClawbackReceiver(
    distributor: PublicKey, 
    newClawbackReceiver: PublicKey, 
    admin: PublicKey
  ): Promise<string> {
    const signature = await this.program.methods
      .setClawbackReceiver()
      .accounts({
        distributor,
        newClawbackAccount: newClawbackReceiver,
        admin,
      })
      .rpc();

    return signature;
  }

  /**
   * Creates a transaction instruction for setting a new clawback receiver
   * @param distributor Distributor public key
   * @param newClawbackReceiver New clawback receiver public key
   * @param admin Admin public key
   * @returns TransactionInstruction
   */
  async setClawbackReceiverInstruction(
    distributor: PublicKey, 
    newClawbackReceiver: PublicKey, 
    admin: PublicKey
  ): Promise<TransactionInstruction> {
    const instruction = await this.program.methods
      .setClawbackReceiver()
      .accounts({
        distributor,
        newClawbackAccount: newClawbackReceiver,
        admin,
      })
      .instruction();

    return instruction;
  }

  /**
   * Fetches a distributor account
   * @param distributor Distributor public key
   * @returns MerkleDistributor account data
   */
  async getDistributor(distributor: PublicKey): Promise<MerkleDistributorAccount> {
    const account = await this.program.account.merkleDistributor.fetch(distributor);
    return account as unknown as MerkleDistributorAccount;
  }

  /**
   * Fetches a claim status account
   * @param claimStatus Claim status public key
   * @returns ClaimStatus account data
   */
  async getClaimStatus(claimStatus: PublicKey): Promise<ClaimStatus> {
    const account = await this.program.account.claimStatus.fetch(claimStatus);
    return account as unknown as ClaimStatus;
  }

  /**
   * Fetches claim status for a specific claimant and distributor
   * @param claimant Claimant public key
   * @param distributor Distributor public key
   * @returns ClaimStatus account data or null if not found
   */
  async getClaimStatusForClaimant(claimant: PublicKey, distributor: PublicKey): Promise<ClaimStatus | null> {
    try {
      const [claimStatusPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('ClaimStatus'),
          claimant.toBuffer(),
          distributor.toBuffer()
        ],
        this.programId
      );
      return await this.getClaimStatus(claimStatusPDA);
    } catch (error) {
      // Account doesn't exist yet
      return null;
    }
  }

  /**
   * Checks if a claimant has already claimed
   * @param claimant Claimant public key
   * @param distributor Distributor public key
   * @returns Boolean indicating if tokens have been claimed
   */
  async hasClaimed(claimant: PublicKey, distributor: PublicKey): Promise<boolean> {
    const claimStatus = await this.getClaimStatusForClaimant(claimant, distributor);
    return claimStatus !== null;
  }

  /**
   * Queries all existing distributors for a given mint
   * @param mint The mint to query distributors for
   * @param maxVersion Maximum version to check (default: 100)
   * @returns Map of version to distributor info
   */
  async queryDistributorsForMint(mint: PublicKey, maxVersion: number = 100): Promise<Map<bigint, {
    pda: PublicKey;
    account: MerkleDistributorAccount;
    version: bigint;
  }>> {
    const distributors = new Map();
    
    for (let version = 0n; version <= BigInt(maxVersion); version++) {
      try {
        const [pda] = getDistributorPDA(mint, version);
        const account = await this.getDistributor(pda);
        
        distributors.set(version, {
          pda,
          account,
          version
        });
      } catch (error) {
        // Distributor doesn't exist for this version, continue
        continue;
      }
    }
    
    return distributors;
  }

  /**
   * Finds the next available version for a mint
   * @param mint The mint to find next version for
   * @param startFrom Starting version to check from (default: 0)
   * @param maxCheck Maximum version to check (default: 1000)
   * @returns Next available version number
   */
  async findNextAvailableVersion(mint: PublicKey, startFrom: bigint = 0n, maxCheck: number = 1000): Promise<bigint> {
    for (let version = startFrom; version <= BigInt(maxCheck); version++) {
      try {
        const [pda] = getDistributorPDA(mint, version);
        await this.getDistributor(pda);
        // If we get here, distributor exists, continue to next version
        continue;
      } catch (error) {
        // Distributor doesn't exist, this version is available
        return version;
      }
    }
    
    throw new Error(`No available version found between ${startFrom} and ${maxCheck}`);
  }

  /**
   * Gets a comprehensive overview of distributions for a mint
   * @param mint The mint to get overview for
   * @param maxVersion Maximum version to check (default: 100)
   * @returns Distribution overview with used versions, next available, and stats
   */
  async getDistributionOverview(mint: PublicKey, maxVersion: number = 100): Promise<{
    mint: PublicKey;
    usedVersions: bigint[];
    nextAvailableVersion: bigint;
    totalDistributors: number;
    totalClaimed: bigint;
    totalUnclaimed: bigint;
    distributors: Map<bigint, {
      pda: PublicKey;
      account: MerkleDistributorAccount;
      version: bigint;
      claimedAmount: bigint;
      remainingAmount: bigint;
    }>;
  }> {
    const distributors = await this.queryDistributorsForMint(mint, maxVersion);
    const usedVersions = Array.from(distributors.keys()).sort((a, b) => Number(a - b));
    const nextAvailableVersion = await this.findNextAvailableVersion(mint, 0n, maxVersion + 100);
    
    let totalClaimed = 0n;
    let totalUnclaimed = 0n;
    
    const distributorMap = new Map();
    
    for (const [version, info] of distributors) {
      const claimedAmount = BigInt(info.account.totalAmountClaimed.toString());
      const maxClaim = BigInt(info.account.maxTotalClaim.toString());
      const remainingAmount = maxClaim - claimedAmount;
      
      totalClaimed += claimedAmount;
      totalUnclaimed += remainingAmount;
      
      distributorMap.set(version, {
        ...info,
        claimedAmount,
        remainingAmount
      });
    }
    
    return {
      mint,
      usedVersions,
      nextAvailableVersion,
      totalDistributors: distributors.size,
      totalClaimed,
      totalUnclaimed,
      distributors: distributorMap
    };
  }

  /**
   * Checks if a version is available for a mint
   * @param mint The mint to check
   * @param version The version to check
   * @returns Boolean indicating if version is available
   */
  async isVersionAvailable(mint: PublicKey, version: bigint): Promise<boolean> {
    try {
      const [pda] = getDistributorPDA(mint, version);
      await this.getDistributor(pda);
      return false; // Distributor exists, version not available
    } catch (error) {
      return true; // Distributor doesn't exist, version available
    }
  }

  /**
   * Gets the PDA for a specific mint and version
   * @param mint The mint
   * @param version The version
   * @returns [PDA, bump] tuple
   */
  getDistributorPDA(mint: PublicKey, version: bigint): [PublicKey, number] {
    return getDistributorPDA(mint, version);
  }

  /**
   * Batch check multiple versions for availability
   * @param mint The mint to check versions for
   * @param versions Array of versions to check
   * @returns Map of version to availability status
   */
  async batchCheckVersions(mint: PublicKey, versions: bigint[]): Promise<Map<bigint, boolean>> {
    const results = new Map<bigint, boolean>();
    
    const checks = versions.map(async (version) => {
      const available = await this.isVersionAvailable(mint, version);
      results.set(version, available);
    });
    
    await Promise.all(checks);
    return results;
  }

  /**
   * Builds a transaction with multiple instructions
   * @param instructions Array of transaction instructions to bundle
   * @returns Transaction ready to be signed and sent
   */
  buildTransaction(instructions: TransactionInstruction[]): Transaction {
    const transaction = new Transaction();
    instructions.forEach(ix => transaction.add(ix));
    return transaction;
  }

  /**
   * Sends and confirms a transaction with multiple instructions
   * @param instructions Array of transaction instructions to bundle and send
   * @returns Transaction signature
   */
  async sendTransaction(instructions: TransactionInstruction[]): Promise<string> {
    const transaction = this.buildTransaction(instructions);
    const signature = await this.provider.sendAndConfirm(transaction);
    return signature;
  }

  // ── Fee management ─────────────────────────────────────────────────

  /**
   * Initializes the global fee configuration
   * @param args InitializeFeeConfigArgs
   * @returns Transaction signature
   */
  async initializeFeeConfig(args: InitializeFeeConfigArgs): Promise<string> {
    if (args.claimFee < 0n) {
      throw new Error('initializeFeeConfig: claimFee cannot be negative.');
    }
    if (args.claimFee > MAX_CLAIM_FEE) {
      throw new Error(`initializeFeeConfig: claimFee exceeds maximum allowed (${MAX_CLAIM_FEE} lamports / 1 SOL).`);
    }
    if (args.claimFee > 0n && args.feeRecipient.equals(PublicKey.default)) {
      throw new Error('initializeFeeConfig: feeRecipient cannot be the zero address when claimFee > 0. Provide a valid wallet address to receive fees.');
    }

    const [feeConfigPDA] = getFeeConfigPDA(this.programId);

    try {
      const signature = await this.program.methods
        .initializeFeeConfig(bigintToBN(args.claimFee))
        .accounts({
          feeConfig: feeConfigPDA,
          admin: args.admin,
          feeRecipient: args.feeRecipient,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      return signature;
    } catch (err) {
      throw formatError(err, 'initializeFeeConfig');
    }
  }

  /**
   * Creates a transaction instruction for initializing the fee configuration
   * @param args InitializeFeeConfigArgs
   * @returns TransactionInstruction
   */
  async initializeFeeConfigInstruction(args: InitializeFeeConfigArgs): Promise<TransactionInstruction> {
    const [feeConfigPDA] = getFeeConfigPDA(this.programId);

    const instruction = await this.program.methods
      .initializeFeeConfig(bigintToBN(args.claimFee))
      .accounts({
        feeConfig: feeConfigPDA,
        admin: args.admin,
        feeRecipient: args.feeRecipient,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    return instruction;
  }

  /**
   * Updates the global claim fee amount and recipient
   * @param args SetClaimFeeArgs
   * @returns Transaction signature
   */
  async setClaimFee(args: SetClaimFeeArgs): Promise<string> {
    if (args.claimFee < 0n) {
      throw new Error('setClaimFee: claimFee cannot be negative.');
    }
    if (args.claimFee > MAX_CLAIM_FEE) {
      throw new Error(`setClaimFee: claimFee exceeds maximum allowed (${MAX_CLAIM_FEE} lamports / 1 SOL).`);
    }
    if (args.claimFee > 0n && args.feeRecipient.equals(PublicKey.default)) {
      throw new Error('setClaimFee: feeRecipient cannot be the zero address when claimFee > 0. Provide a valid wallet address to receive fees.');
    }

    const [feeConfigPDA] = getFeeConfigPDA(this.programId);

    try {
      const signature = await this.program.methods
        .setClaimFee(bigintToBN(args.claimFee))
        .accounts({
          feeConfig: feeConfigPDA,
          admin: args.admin,
          newFeeRecipient: args.feeRecipient,
        })
        .rpc();

      return signature;
    } catch (err) {
      throw formatError(err, 'setClaimFee');
    }
  }

  /**
   * Creates a transaction instruction for updating the claim fee
   * @param args SetClaimFeeArgs
   * @returns TransactionInstruction
   */
  async setClaimFeeInstruction(args: SetClaimFeeArgs): Promise<TransactionInstruction> {
    const [feeConfigPDA] = getFeeConfigPDA(this.programId);

    const instruction = await this.program.methods
      .setClaimFee(bigintToBN(args.claimFee))
      .accounts({
        feeConfig: feeConfigPDA,
        admin: args.admin,
        newFeeRecipient: args.feeRecipient,
      })
      .instruction();

    return instruction;
  }

  /**
   * Fetches the global fee configuration
   * @returns FeeConfig account data
   */
  async getFeeConfig(): Promise<FeeConfig> {
    const [feeConfigPDA] = getFeeConfigPDA(this.programId);
    try {
      const account = await this.program.account.feeConfig.fetch(feeConfigPDA);
      return account as unknown as FeeConfig;
    } catch (err) {
      throw formatError(err, 'getFeeConfig');
    }
  }

  /**
   * Transfers fee config admin authority to a new account
   * @param args SetFeeAdminArgs
   * @returns Transaction signature
   */
  async setFeeAdmin(args: SetFeeAdminArgs): Promise<string> {
    if (args.admin.equals(args.newAdmin)) {
      throw new Error('setFeeAdmin: new admin cannot be the same as the current admin.');
    }

    const [feeConfigPDA] = getFeeConfigPDA(this.programId);

    try {
      const signature = await this.program.methods
        .setFeeAdmin()
        .accounts({
          feeConfig: feeConfigPDA,
          admin: args.admin,
          newAdmin: args.newAdmin,
        })
        .rpc();

      return signature;
    } catch (err) {
      throw formatError(err, 'setFeeAdmin');
    }
  }

  /**
   * Creates a transaction instruction for transferring fee config admin
   * @param args SetFeeAdminArgs
   * @returns TransactionInstruction
   */
  async setFeeAdminInstruction(args: SetFeeAdminArgs): Promise<TransactionInstruction> {
    const [feeConfigPDA] = getFeeConfigPDA(this.programId);

    const instruction = await this.program.methods
      .setFeeAdmin()
      .accounts({
        feeConfig: feeConfigPDA,
        admin: args.admin,
        newAdmin: args.newAdmin,
      })
      .instruction();

    return instruction;
  }

  /**
   * Gets the FeeConfig PDA address
   * @returns [PDA, bump] tuple
   */
  getFeeConfigPDA(): [PublicKey, number] {
    return getFeeConfigPDA(this.programId);
  }
}
