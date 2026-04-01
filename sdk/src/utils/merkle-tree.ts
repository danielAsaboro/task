import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';

/**
 * JITO Merkle Tree implementation that exactly matches the Solana program
 * Fixes InvalidProof errors by implementing proper double-hashing
 */

// Prefixes to prevent second pre-image attacks
const LEAF_PREFIX = Buffer.from([0]);
const INTERMEDIATE_PREFIX = Buffer.from([1]);

export interface AirdropRecipient {
  address: PublicKey;
  unlockedAmount: number;
  lockedAmount: number;
}

/**
 * Production-ready Merkle Tree for JITO Merkle Distributor
 * Uses double-hashing to match Solana program expectations exactly
 */
export class JitoMerkleTree {
  private leaves: Buffer[] = [];
  private tree: Buffer[][] = [];
  private root: Buffer | null = null;

  constructor(recipients: AirdropRecipient[]) {
    // Create leaves from recipient data
    this.leaves = recipients.map(recipient => this.createLeaf(recipient));
    this.buildTree();
  }

  private createLeaf(recipient: AirdropRecipient): Buffer {
    // Create leaf data exactly like TreeNode.hash(): address (32 bytes) + unlocked (8 bytes LE) + locked (8 bytes LE)
    const addressBytes = recipient.address.toBuffer();
    const unlockedBytes = Buffer.alloc(8);
    unlockedBytes.writeBigUInt64LE(BigInt(recipient.unlockedAmount));
    const lockedBytes = Buffer.alloc(8);
    lockedBytes.writeBigUInt64LE(BigInt(recipient.lockedAmount));
    
    const leafData = Buffer.concat([addressBytes, unlockedBytes, lockedBytes]);
    
    // FIXED: Match Rust program's DOUBLE HASHING exactly
    // Step 1: Hash the raw data (like Rust's first hashv call)
    const firstHash = createHash('sha256').update(leafData).digest();
    
    // Step 2: Hash the result with LEAF_PREFIX (like Rust's second hashv call)
    const finalHash = createHash('sha256').update(Buffer.concat([LEAF_PREFIX, firstHash])).digest();
    
    return finalHash;
  }

  private hashLeaf(data: Buffer): Buffer {
    // For verification, we need to match the Rust program's approach
    // Step 1: Hash the raw data first
    const firstHash = createHash('sha256').update(data).digest();
    
    // Step 2: Hash with LEAF_PREFIX
    const finalHash = createHash('sha256').update(Buffer.concat([LEAF_PREFIX, firstHash])).digest();
    
    return finalHash;
  }

  private hashIntermediate(left: Buffer, right: Buffer): Buffer {
    // Equivalent to hash_intermediate! macro: hashv(&[INTERMEDIATE_PREFIX, left, right])
    return createHash('sha256').update(Buffer.concat([INTERMEDIATE_PREFIX, left, right])).digest();
  }

  private buildTree() {
    if (this.leaves.length === 0) {
      throw new Error('Cannot build tree with no leaves');
    }

    let currentLevel = [...this.leaves];
    this.tree = [currentLevel];

    while (currentLevel.length > 1) {
      const nextLevel: Buffer[] = [];
      
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left; // Duplicate if odd
        
        // Use sorted hashing like Rust airdrop_merkle_tree.rs (sorted_hashes = true)
        if (left.compare(right) <= 0) {
          nextLevel.push(this.hashIntermediate(left, right));
        } else {
          nextLevel.push(this.hashIntermediate(right, left));
        }
      }
      
      currentLevel = nextLevel;
      this.tree.push(currentLevel);
    }

    this.root = currentLevel[0];
  }

  getRoot(): Buffer {
    if (!this.root) {
      throw new Error('Tree not built yet');
    }
    return this.root;
  }

  getProof(index: number): Buffer[] {
    if (index >= this.leaves.length) {
      throw new Error('Index out of bounds');
    }

    const proof: Buffer[] = [];
    let currentIndex = index;

    for (let level = 0; level < this.tree.length - 1; level++) {
      const currentLevel = this.tree[level];
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < currentLevel.length) {
        proof.push(currentLevel[siblingIndex]);
      } else {
        // Duplicate the current node if sibling doesn't exist
        proof.push(currentLevel[currentIndex]);
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  verifyProof(index: number, leafData: Buffer, proof: Buffer[]): boolean {
    // Match Rust program's verification exactly with double hashing
    let computedHash = this.hashLeaf(leafData);
    
    for (const proofElement of proof) {
      // Use sorting like Rust verify.rs
      if (computedHash.compare(proofElement) <= 0) {
        computedHash = this.hashIntermediate(computedHash, proofElement);
      } else {
        computedHash = this.hashIntermediate(proofElement, computedHash);
      }
    }

    return computedHash.equals(this.getRoot());
  }

  // Helper method to get raw leaf data for a specific recipient (before hashing)
  getRawLeafForRecipient(recipient: AirdropRecipient): Buffer {
    // Return the raw leaf data (before any hashing)
    const addressBytes = recipient.address.toBuffer();
    const unlockedBytes = Buffer.alloc(8);
    unlockedBytes.writeBigUInt64LE(BigInt(recipient.unlockedAmount));
    const lockedBytes = Buffer.alloc(8);
    lockedBytes.writeBigUInt64LE(BigInt(recipient.lockedAmount));
    
    return Buffer.concat([addressBytes, unlockedBytes, lockedBytes]);
  }

  // Helper method to find index of a recipient
  findRecipientIndex(recipients: AirdropRecipient[], targetAddress: PublicKey): number {
    return recipients.findIndex(r => r.address.equals(targetAddress));
  }
}

/**
 * Creates a JITO-compatible merkle tree with the specified recipients
 */
export function createJitoMerkleTree(recipients: AirdropRecipient[]): {
  tree: JitoMerkleTree;
  root: Uint8Array;
  recipients: AirdropRecipient[];
} {
  const tree = new JitoMerkleTree(recipients);
  const root = new Uint8Array(tree.getRoot());
  
  return {
    tree,
    root,
    recipients
  };
}

/**
 * Generates a merkle proof for a specific recipient
 */
export function generateProofForRecipient(
  tree: JitoMerkleTree,
  recipients: AirdropRecipient[],
  targetAddress: PublicKey
): {
  proof: Uint8Array[];
  index: number;
  recipient: AirdropRecipient;
} {
  const index = tree.findRecipientIndex(recipients, targetAddress);
  if (index === -1) {
    throw new Error(`Recipient ${targetAddress.toString()} not found in merkle tree`);
  }

  const recipient = recipients[index];
  const proof = tree.getProof(index);
  
  return {
    proof: proof.map(p => new Uint8Array(p)),
    index,
    recipient
  };
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
 * Convert hex string to Uint8Array
 */
export function hexToUint8Array(hex: string): Uint8Array {
  // Remove 0x prefix if present
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  
  // Ensure even length
  const paddedHex = cleanHex.length % 2 === 0 ? cleanHex : '0' + cleanHex;
  
  const bytes = new Uint8Array(paddedHex.length / 2);
  for (let i = 0; i < paddedHex.length; i += 2) {
    bytes[i / 2] = parseInt(paddedHex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 */
export function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
} 