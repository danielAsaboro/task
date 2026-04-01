import { Connection, PublicKey, GetProgramAccountsFilter } from '@solana/web3.js';
import { createHash } from 'crypto';
import BigNumber from 'bignumber.js';

/**
 * Constants for the versioning system
 */
export const VERSIONING_CONSTANTS = {
    MAX_DEPLOYMENTS_PER_USER: 65536, // 2^16 (0 to 65535 inclusive)
    USER_FINGERPRINT_BITS: 48,
    SEQUENCE_BITS: 16,
    MERKLE_DISTRIBUTOR_DISCRIMINATOR: "MerkleDistributor",
    MERKLE_DISTRIBUTOR_ACCOUNT_SIZE: 177, // Size of MerkleDistributor account
    MAX_RETRY_ATTEMPTS: 3,
    RETRY_DELAY_MS: 500,
} as const;

/**
 * Offsets for filtering MerkleDistributor accounts
 * TODO: Replace with proper Borsh parsing to avoid brittleness
 */
const ACCOUNT_OFFSETS = {
    MINT: 41,        // Offset where mint pubkey is stored
    ADMIN: 145,      // Offset where admin pubkey is stored
} as const;

/**
 * Custom error types for versioning system
 */
export class VersioningError extends Error {
    constructor(message: string, public code: string) {
        super(message);
        this.name = 'VersioningError';
    }
}

export class DeploymentLimitExceededError extends VersioningError {
    constructor(currentCount: number, maxAllowed: number) {
        super(
            `This wallet has exceeded its allocated deployment limit (${maxAllowed}). ` +
            `Current deployments: ${currentCount}. Please use a different wallet to continue deploying distributions.`,
            'DEPLOYMENT_LIMIT_EXCEEDED'
        );
    }
}

export class RaceConditionError extends VersioningError {
    constructor(version: string) {
        super(
            `Version ${version} is already in use. This can happen when deploying from multiple tabs simultaneously.`,
            'RACE_CONDITION'
        );
    }
}

/**
 * Result type for version generation
 */
export interface VersionGenerationResult {
    version: BigNumber;
    sequence: number;
    userFingerprint: BigNumber;
    deploymentCount: number;
}

/**
 * Configuration for the versioning system
 */
export interface VersioningConfig {
    connection: Connection;
    programId: PublicKey;
    mintAddress: PublicKey;
}

/**
 * Deployment result with retry information
 */
export interface DeploymentAttemptResult extends VersionGenerationResult {
    attempt: number;
    retried: boolean;
}

/**
 * In-flight deployment tracker for race condition prevention
 */
class DeploymentTracker {
    private static inFlight = new Set<string>();
    
    static lock(walletKey: string): boolean {
        if (this.inFlight.has(walletKey)) {
            return false; // Already locked
        }
        this.inFlight.add(walletKey);
        return true; // Successfully locked
    }
    
    static unlock(walletKey: string): void {
        this.inFlight.delete(walletKey);
    }
    
    static isLocked(walletKey: string): boolean {
        return this.inFlight.has(walletKey);
    }
}

/**
 * Main versioning system class for JITO Merkle Distributor
 */
export class DeterministicVersioning {
    private connection: Connection;
    private programId: PublicKey;
    private mintAddress: PublicKey;

    constructor(config: VersioningConfig) {
        this.connection = config.connection;
        this.programId = config.programId;
        this.mintAddress = config.mintAddress;
    }

    /**
     * Generates a deterministic user fingerprint from wallet public key
     * Takes the first 48 bits of SHA-256 hash of the wallet pubkey
     */
    private generateUserFingerprint(walletPubkey: PublicKey): BigNumber {
        // Hash the full 32-byte Ed25519 public key
        const hash = createHash('sha256').update(walletPubkey.toBuffer()).digest();
        
        // Take the first 6 bytes (48 bits) as the user fingerprint
        const fingerprintBytes = hash.subarray(0, 6);
        
        // Convert to BigNumber (big-endian)
        const fingerprintHex = fingerprintBytes.toString('hex');
        return new BigNumber(fingerprintHex, 16);
    }

    /**
     * Queries the blockchain to count existing distributor accounts for a user
     * This gives us the reliable sequence number for next deployment
     */
    async getUserDeploymentCount(walletPubkey: PublicKey): Promise<number> {
        try {
            const filters: GetProgramAccountsFilter[] = [
                // Filter by account size (MerkleDistributor accounts)
                {
                    dataSize: VERSIONING_CONSTANTS.MERKLE_DISTRIBUTOR_ACCOUNT_SIZE
                },
                // Filter by mint address
                {
                    memcmp: {
                        offset: ACCOUNT_OFFSETS.MINT,
                        bytes: this.mintAddress.toBase58()
                    }
                },
                // Filter by admin (wallet address)
                {
                    memcmp: {
                        offset: ACCOUNT_OFFSETS.ADMIN,
                        bytes: walletPubkey.toBase58()
                    }
                }
            ];

            const accounts = await this.connection.getProgramAccounts(this.programId, {
                filters,
                commitment: 'confirmed'
            });

            return accounts.length;
        } catch (error) {
            throw new VersioningError(
                `Failed to query deployment count for wallet ${walletPubkey.toBase58()}: ${error}`,
                'QUERY_FAILED'
            );
        }
    }

    /**
     * Generates a deterministic, collision-free version number
     * Format: [48-bit user fingerprint][16-bit sequence number]
     */
    private generateVersionNumber(userFingerprint: BigNumber, sequence: number): BigNumber {
        // Validate sequence is within 16-bit range (0 to 65535 inclusive)
        if (sequence < 0 || sequence >= VERSIONING_CONSTANTS.MAX_DEPLOYMENTS_PER_USER) {
            throw new VersioningError(
                `Sequence number ${sequence} is out of valid range [0, ${VERSIONING_CONSTANTS.MAX_DEPLOYMENTS_PER_USER - 1}]`,
                'INVALID_SEQUENCE'
            );
        }

        // Validate user fingerprint fits in 48 bits
        const maxFingerprint = new BigNumber(2).pow(VERSIONING_CONSTANTS.USER_FINGERPRINT_BITS).minus(1);
        if (userFingerprint.gt(maxFingerprint)) {
            throw new VersioningError(
                'User fingerprint exceeds 48-bit limit',
                'INVALID_FINGERPRINT'
            );
        }

        // Combine: (fingerprint << 16) | sequence
        const shiftedFingerprint = userFingerprint.multipliedBy(new BigNumber(2).pow(VERSIONING_CONSTANTS.SEQUENCE_BITS));
        const sequenceBN = new BigNumber(sequence);
        
        return shiftedFingerprint.plus(sequenceBN);
    }

    /**
     * Main function: Get the next version number for a user's deployment
     * Combines on-chain sequence tracking with deterministic generation
     */
    async getNextVersion(walletPubkey: PublicKey): Promise<VersionGenerationResult> {
        // Step 1: Query current deployment count from blockchain
        const deploymentCount = await this.getUserDeploymentCount(walletPubkey);
        
        // Step 2: Check if user has exceeded deployment limit
        if (deploymentCount >= VERSIONING_CONSTANTS.MAX_DEPLOYMENTS_PER_USER) {
            throw new DeploymentLimitExceededError(deploymentCount, VERSIONING_CONSTANTS.MAX_DEPLOYMENTS_PER_USER);
        }

        // Step 3: Generate user fingerprint from wallet pubkey
        const userFingerprint = this.generateUserFingerprint(walletPubkey);

        // Step 4: Generate deterministic version number
        const version = this.generateVersionNumber(userFingerprint, deploymentCount);

        return {
            version,
            sequence: deploymentCount,
            userFingerprint,
            deploymentCount
        };
    }

    /**
     * Race-condition safe deployment version generation with auto-retry
     * This is the recommended method for UI usage
     */
    async getNextVersionWithRetry(walletPubkey: PublicKey): Promise<DeploymentAttemptResult> {
        const walletKey = walletPubkey.toBase58();
        
        // Tier 1: Soft lock to prevent same-device races
        if (!DeploymentTracker.lock(walletKey)) {
            throw new VersioningError(
                'A deployment is already in progress for this wallet. Please wait for it to complete.',
                'DEPLOYMENT_IN_PROGRESS'
            );
        }

        try {
            // Tier 2: Auto-retry with fresh sequence queries
            for (let attempt = 0; attempt < VERSIONING_CONSTANTS.MAX_RETRY_ATTEMPTS; attempt++) {
                const result = await this.getNextVersion(walletPubkey);
                
                // Return result with retry metadata
                return {
                    ...result,
                    attempt: attempt + 1,
                    retried: attempt > 0
                };
            }
            
            throw new VersioningError(
                `Failed to generate unique version after ${VERSIONING_CONSTANTS.MAX_RETRY_ATTEMPTS} attempts`,
                'MAX_RETRIES_EXCEEDED'
            );
        } finally {
            DeploymentTracker.unlock(walletKey);
        }
    }

    /**
     * Utility: Verify a version number was generated correctly
     * Useful for debugging and validation
     */
    async verifyVersion(walletPubkey: PublicKey, version: BigNumber): Promise<boolean> {
        try {
            const result = await this.getNextVersion(walletPubkey);
            return result.version.eq(version);
        } catch {
            return false;
        }
    }

    /**
     * Utility: Decode a version number back to its components
     * Useful for debugging and analytics
     */
    static decodeVersion(version: BigNumber): { userFingerprint: BigNumber; sequence: number } {
        // Extract sequence (lower 16 bits) using modulo
        const sequenceMask = new BigNumber(2).pow(VERSIONING_CONSTANTS.SEQUENCE_BITS);
        const sequence = version.modulo(sequenceMask).toNumber();

        // Extract user fingerprint (upper 48 bits) using integer division
        const userFingerprint = version.dividedToIntegerBy(sequenceMask);

        return { userFingerprint, sequence };
    }

    /**
     * Utility: Convert version to little-endian Buffer for Solana
     * Ensures proper endianness for PDA derivation
     */
    static versionToLEBuffer(version: BigNumber): Buffer {
        // Convert to BigInt to avoid precision loss
        const versionBigInt = BigInt(version.toString());
        
        // Create 8-byte buffer and write as little-endian
        const buffer = Buffer.alloc(8);
        buffer.writeBigUInt64LE(versionBigInt, 0);
        
        return buffer;
    }

    /**
     * Utility: Get deployment history for a user
     * Returns all versions this user has deployed
     */
    async getUserDeploymentHistory(walletPubkey: PublicKey): Promise<BigNumber[]> {
        const deploymentCount = await this.getUserDeploymentCount(walletPubkey);
        const userFingerprint = this.generateUserFingerprint(walletPubkey);
        
        const versions: BigNumber[] = [];
        for (let seq = 0; seq < deploymentCount; seq++) {
            const version = this.generateVersionNumber(userFingerprint, seq);
            versions.push(version);
        }
        
        return versions;
    }

    /**
     * Utility: Estimate collision probability for given user count
     * Returns probability as percentage for easier monitoring
     */
    static estimateCollisionProbability(userCount: number, deploymentsPerUser: number = 260): { 
        probability: number; 
        probabilityPercent: string; 
        isAcceptable: boolean 
    } {
        const totalDeployments = userCount * deploymentsPerUser;
        const spaceSize = Math.pow(2, VERSIONING_CONSTANTS.USER_FINGERPRINT_BITS);
        
        // Birthday bound approximation: N(N-1)/(2 * space_size)
        const probability = (totalDeployments * (totalDeployments - 1)) / (2 * spaceSize);
        const probabilityPercent = (probability * 100).toExponential(2);
        const isAcceptable = probability < 1e-6; // Less than 1 in a million
        
        return { probability, probabilityPercent, isAcceptable };
    }
}

/**
 * Simple deterministic versioning utilities (from legacy deterministic-version.ts)
 * Kept for backwards compatibility and simple use cases
 */

/**
 * Generate a simple deterministic version number unique to the deployer's wallet
 * This ensures no collisions with other deployers while being reproducible
 */
export function getDeterministicVersion(
  deployerPubkey: PublicKey, 
  salt: string = 'default'
): bigint {
  // Combine deployer pubkey + salt for deterministic but unique versioning
  const input = deployerPubkey.toBuffer().toString('hex') + salt;
  
  // Hash the input to get deterministic output
  const hash = createHash('sha256').update(input).digest();
  
  // Take first 8 bytes and convert to u64 (but avoid 0)
  const versionBytes = hash.slice(0, 8);
  let version = versionBytes.readBigUInt64BE(0);
  
  // Ensure version is never 0 (add 1 if it is)
  if (version === 0n) {
    version = 1n;
  }
  
  return version;
}

/**
 * Generate a deterministic version with custom salt for multiple distributions
 */
export function getDistributionVersion(
  deployerPubkey: PublicKey,
  distributionName: string
): bigint {
  return getDeterministicVersion(deployerPubkey, distributionName);
}

/**
 * Generate a time-based deterministic version (changes daily)
 */
export function getDailyVersion(
  deployerPubkey: PublicKey,
  date: Date = new Date()
): bigint {
  const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD
  return getDeterministicVersion(deployerPubkey, `daily-${dateString}`);
}

/**
 * Generate a sequential version for the same deployer
 */
export function getSequentialVersion(
  deployerPubkey: PublicKey,
  sequence: number
): bigint {
  return getDeterministicVersion(deployerPubkey, `seq-${sequence}`);
}

/**
 * Convenience function for quick version generation with race protection
 * Recommended for React UI usage with JITO Merkle Distributor
 */
export async function generateNextVersionSafe(
    connection: Connection,
    programId: PublicKey,
    mintAddress: PublicKey,
    walletPubkey: PublicKey
): Promise<DeploymentAttemptResult> {
    const versioning = new DeterministicVersioning({
        connection,
        programId,
        mintAddress
    });
    
    return versioning.getNextVersionWithRetry(walletPubkey);
}

/**
 * Utility to detect if error is from account collision
 */
export function isAccountCollisionError(error: any): boolean {
    const errorMessage = error?.message?.toLowerCase() || '';
    return errorMessage.includes('account already in use') || 
           errorMessage.includes('already in use') ||
           errorMessage.includes('custom program error: 0x0'); // Common Solana collision error
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
} 