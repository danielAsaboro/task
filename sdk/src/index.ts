// Main SDK exports
export { MerkleDistributor } from './distributor';

// Type exports
export type {
  MerkleDistributor as MerkleDistributorAccount,
  ClaimStatus,
  CreateDistributorArgs,
  CreateDistributorWithUnlockDateArgs,
  CreateDistributorWithLinearVestingArgs,
  DistributorVestingSchedule,
  CliffClaimAmounts,
  LinearVestingAmounts,
  VestingType,
  VestingInfo,
  WithdrawableInfo,
  ClaimArgs,
  ClaimLockedArgs,
  NewClaimEvent,
  ClaimedEvent,
  NewDistributorParams,
  NewClaimParams,
  FeeConfig,
  InitializeFeeConfigArgs,
  SetClaimFeeArgs,
  FeeCollectedEvent,
} from './types';

export { PROGRAM_ID, DistributorError } from './types';

// Utility exports
export {
  getDistributorPDA,
  getClaimStatusPDA,
  getFeeConfigPDA,
  hexToUint8Array,
  uint8ArrayToHex,
  bigintToBN,
  validateMerkleProof,
  getCurrentTimestamp,
  validateTimestamps,
} from './utils';

// Versioning system exports
export {
  DeterministicVersioning,
  generateNextVersionSafe,
  getDeterministicVersion,
  getDistributionVersion,
  getDailyVersion,
  getSequentialVersion,
  isAccountCollisionError,
  VERSIONING_CONSTANTS,
  VersioningError,
  DeploymentLimitExceededError,
  RaceConditionError,
} from './versioning-system';

export type {
  VersionGenerationResult,
  VersioningConfig,
  DeploymentAttemptResult,
} from './versioning-system';

// Merkle tree utilities exports
export {
  JitoMerkleTree,
  createJitoMerkleTree,
  generateProofForRecipient,
  validateMerkleProof as validateJitoMerkleProof,
} from './utils/merkle-tree';

export type {
  AirdropRecipient,
} from './utils/merkle-tree'; 
