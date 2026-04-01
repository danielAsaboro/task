import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';

/**
 * Program ID for the Merkle Distributor program
 */
export const PROGRAM_ID = new PublicKey('Ah7iuugan983ymZAKJAFAdvPN3My7ESkGUARrFTn3iqM');

/**
 * Account types
 */
export interface MerkleDistributor {
  bump: number;
  version: BN;
  root: number[];
  mint: PublicKey;
  tokenVault: PublicKey;
  maxTotalClaim: BN;
  maxNumNodes: BN;
  totalAmountClaimed: BN;
  numNodesClaimed: BN;
  startTs: BN;
  endTs: BN;
  clawbackStartTs: BN;
  clawbackReceiver: PublicKey;
  admin: PublicKey;
  clawedBack: boolean;
}

export interface ClaimStatus {
  claimant: PublicKey;
  lockedAmount: BN;
  lockedAmountWithdrawn: BN;
  unlockedAmount: BN;
  feePaid: boolean;
}

/**
 * Instruction parameter types
 */
export interface NewDistributorParams {
  version: BN;
  root: number[];
  maxTotalClaim: BN;
  maxNumNodes: BN;
  startVestingTs: BN;
  endVestingTs: BN;
  clawbackStartTs: BN;
}

export interface NewClaimParams {
  amountUnlocked: BN;
  amountLocked: BN;
  proof: number[][];
}

/**
 * Event types
 */
export interface NewClaimEvent {
  claimant: PublicKey;
  timestamp: BN;
}

export interface ClaimedEvent {
  claimant: PublicKey;
  amount: BN;
}

export interface FeeCollectedEvent {
  claimant: PublicKey;
  feeAmount: BN;
  feeRecipient: PublicKey;
  distributor: PublicKey;
}

export interface FeeConfigInitializedEvent {
  admin: PublicKey;
  claimFee: BN;
  feeRecipient: PublicKey;
}

export interface FeeConfigUpdatedEvent {
  admin: PublicKey;
  newClaimFee: BN;
  newFeeRecipient: PublicKey;
}

export interface FeeAdminUpdatedEvent {
  previousAdmin: PublicKey;
  newAdmin: PublicKey;
}

/**
 * Maximum claim fee: 1 SOL (1_000_000_000 lamports)
 */
export const MAX_CLAIM_FEE = 1_000_000_000n;

/**
 * Error codes
 */
export enum DistributorError {
  InsufficientUnlockedTokens = 6000,
  StartTooFarInFuture = 6001,
  InvalidProof = 6002,
  ExceededMaxClaim = 6003,
  MaxNodesExceeded = 6004,
  Unauthorized = 6005,
  OwnerMismatch = 6006,
  ClawbackDuringVesting = 6007,
  ClawbackBeforeStart = 6008,
  ClawbackAlreadyClaimed = 6009,
  InsufficientClawbackDelay = 6010,
  SameClawbackReceiver = 6011,
  SameAdmin = 6012,
  ClaimExpired = 6013,
  ArithmeticError = 6014,
  StartTimestampAfterEnd = 6015,
  TimestampsNotInFuture = 6016,
  InvalidVersion = 6017,
  InvalidFeeRecipient = 6018,
  SameFeeAdmin = 6019,
  FeeExceedsMaximum = 6020,
}

/**
 * Global fee configuration account
 */
export interface FeeConfig {
  admin: PublicKey;
  claimFee: BN;
  feeRecipient: PublicKey;
  bump: number;
}

/**
 * Arguments for initializing the global fee config
 */
export interface InitializeFeeConfigArgs {
  admin: PublicKey;
  claimFee: bigint;
  feeRecipient: PublicKey;
}

/**
 * Arguments for updating the claim fee
 */
export interface SetClaimFeeArgs {
  admin: PublicKey;
  claimFee: bigint;
  feeRecipient: PublicKey;
}

/**
 * Arguments for transferring fee config admin authority
 */
export interface SetFeeAdminArgs {
  admin: PublicKey;
  newAdmin: PublicKey;
}

/**
 * Helper types for SDK functions
 */
export interface CreateDistributorArgs {
  mint: PublicKey;
  version: bigint;
  root: Uint8Array;
  maxTotalClaim: bigint;
  maxNumNodes: bigint;
  startVestingTs: bigint;
  endVestingTs: bigint;
  clawbackStartTs: bigint;
  clawbackReceiver: PublicKey;
  admin: PublicKey;
}

/**
 * Creates a distributor with a single unlock date (cliff vesting).
 * Internally this maps to:
 * - startVestingTs = unlockTs - 1 second
 * - endVestingTs = unlockTs
 *
 * This 1-second window is required because on-chain enforces:
 * start_vesting_ts < end_vesting_ts.
 *
 * Important:
 * To make tokens truly unclaimable before unlock date, merkle leaves should use:
 * - amountUnlocked = 0
 * - amountLocked = full amount
 */
export interface CreateDistributorWithUnlockDateArgs {
  mint: PublicKey;
  version: bigint;
  root: Uint8Array;
  maxTotalClaim: bigint;
  maxNumNodes: bigint;
  unlockTs: bigint;
  clawbackStartTs?: bigint;
  clawbackDelaySeconds?: bigint;
  clawbackReceiver: PublicKey;
  admin: PublicKey;
}

export interface DistributorVestingSchedule {
  startVestingTs: bigint;
  endVestingTs: bigint;
  clawbackStartTs: bigint;
}

export interface CliffClaimAmounts {
  amountUnlocked: bigint;
  amountLocked: bigint;
}

export interface ClaimArgs {
  claimant: PublicKey;
  distributor: PublicKey;
  claimantTokenAccount: PublicKey;
  amountUnlocked: bigint;
  amountLocked: bigint;
  proof: Uint8Array[];
}

export interface ClaimLockedArgs {
  claimant: PublicKey;
  distributor: PublicKey;
  claimantTokenAccount: PublicKey;
}

/**
 * Creates a distributor with linear vesting over a time range.
 * Tokens vest continuously between startVestingTs and endVestingTs.
 * Users can call claimLocked at any point to withdraw proportionally vested tokens.
 */
export interface CreateDistributorWithLinearVestingArgs {
  mint: PublicKey;
  version: bigint;
  root: Uint8Array;
  maxTotalClaim: bigint;
  maxNumNodes: bigint;
  startVestingTs: bigint;
  endVestingTs: bigint;
  clawbackStartTs?: bigint;
  clawbackDelaySeconds?: bigint;
  clawbackReceiver: PublicKey;
  admin: PublicKey;
}

export interface LinearVestingAmounts {
  amountUnlocked: bigint;
  amountLocked: bigint;
}

export type VestingType = 'cliff' | 'linear';

export interface VestingInfo {
  type: VestingType;
  startTs: bigint;
  endTs: bigint;
  durationSeconds: bigint;
  /** Current vested fraction (0..1) based on provided timestamp */
  vestedFraction: number;
}

export interface WithdrawableInfo {
  lockedAmount: bigint;
  lockedAmountWithdrawn: bigint;
  vestedAmount: bigint;
  withdrawable: bigint;
}
