import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID } from './types';

/**
 * Seeds for PDA derivation
 */
const MERKLE_DISTRIBUTOR_SEED = 'MerkleDistributor';
const CLAIM_STATUS_SEED = 'ClaimStatus';
const FEE_CONFIG_SEED = 'FeeConfig';

/**
 * Derives the PDA for a MerkleDistributor account
 * @param mint The mint public key
 * @param version The version number
 * @returns [PDA, bump] tuple
 */
export function getDistributorPDA(mint: PublicKey, version: bigint): [PublicKey, number] {
  const versionBuffer = Buffer.alloc(8);
  versionBuffer.writeBigUInt64LE(version);
  
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(MERKLE_DISTRIBUTOR_SEED),
      mint.toBuffer(),
      versionBuffer,
    ],
    PROGRAM_ID
  );
}

/**
 * Derives the PDA for a ClaimStatus account
 * @param claimant The claimant's public key
 * @param distributor The distributor's public key
 * @returns [PDA, bump] tuple
 */
export function getClaimStatusPDA(claimant: PublicKey, distributor: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(CLAIM_STATUS_SEED),
      claimant.toBuffer(),
      distributor.toBuffer(),
    ],
    PROGRAM_ID
  );
}

/**
 * Derives the PDA for the global FeeConfig account
 * @param programId Optional program ID override
 * @returns [PDA, bump] tuple
 */
export function getFeeConfigPDA(programId: PublicKey = PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(FEE_CONFIG_SEED)],
    programId
  );
}

/**
 * Converts a hex string to Uint8Array
 * @param hex Hex string (with or without 0x prefix)
 * @returns Uint8Array
 */
export function hexToUint8Array(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleanHex.length % 2 !== 0) {
    throw new Error('Hex string must have even length');
  }
  
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Converts Uint8Array to hex string
 * @param bytes Uint8Array
 * @returns Hex string without 0x prefix
 */
export function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Converts bigint to BN (Anchor's Big Number)
 * @param value bigint value
 * @returns BN
 */
export function bigintToBN(value: bigint): any {
  const { BN } = require('@coral-xyz/anchor');
  return new BN(value.toString());
}

/**
 * Validates that a merkle proof is properly formatted
 * @param proof Array of hex strings or Uint8Arrays
 * @returns boolean
 */
export function validateMerkleProof(proof: (string | Uint8Array)[]): boolean {
  for (const element of proof) {
    if (typeof element === 'string') {
      try {
        const bytes = hexToUint8Array(element);
        if (bytes.length !== 32) return false;
      } catch {
        return false;
      }
    } else if (element instanceof Uint8Array) {
      if (element.length !== 32) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Gets the current Unix timestamp
 * @returns Current timestamp in seconds
 */
export function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Validates timestamp parameters for distributor creation
 * @param startVestingTs Start vesting timestamp
 * @param endVestingTs End vesting timestamp  
 * @param clawbackStartTs Clawback start timestamp
 * @returns Object with validation result and error message if invalid
 */
export function validateTimestamps(
  startVestingTs: bigint,
  endVestingTs: bigint,
  clawbackStartTs: bigint
): { valid: boolean; error?: string } {
  const now = BigInt(getCurrentTimestamp());
  const oneDay = BigInt(86400); // 24 hours in seconds
  
  // Match on-chain requirements from new_distributor.rs.
  if (startVestingTs >= endVestingTs) {
    return { valid: false, error: 'Start vesting timestamp must be strictly before end vesting timestamp' };
  }

  if (startVestingTs <= now || endVestingTs <= now || clawbackStartTs <= now) {
    return { valid: false, error: 'Start, end, and clawback timestamps must all be in the future' };
  }

  if (clawbackStartTs <= endVestingTs) {
    return { valid: false, error: 'Clawback start must be after end vesting timestamp' };
  }

  if (clawbackStartTs < endVestingTs + oneDay) {
    return { valid: false, error: 'Clawback start must be at least one day after end vesting timestamp' };
  }
  
  return { valid: true };
}
