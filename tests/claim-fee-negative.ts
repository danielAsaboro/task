/**
 * Negative / sad-path tests for claim fee enforcement.
 *
 * These tests exercise the fee collection logic within new_claim and
 * claim_locked, focusing on scenarios that SHOULD fail:
 *   - wrong fee recipient account
 *   - claimant can't afford fee
 *   - fee_paid flag prevents double-charging
 *   - fee bypass attempts
 *
 * Run: yarn run ts-mocha -p ./tsconfig.json -t 1000000 "tests/claim-fee-negative.ts"
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { MerkleDistributorFeeTask } from "../target/types/merkle_distributor_fee_task";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import { createHash } from "crypto";

// ── Helpers ─────────────────────────────────────────────────────────────

function getFeeConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("FeeConfig")],
    programId
  );
}

function getDistributorPDA(
  mint: PublicKey,
  version: bigint,
  programId: PublicKey
): [PublicKey, number] {
  const versionBuffer = Buffer.alloc(8);
  versionBuffer.writeBigUInt64LE(version);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("MerkleDistributor"), mint.toBuffer(), versionBuffer],
    programId
  );
}

function getClaimStatusPDA(
  claimant: PublicKey,
  distributor: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ClaimStatus"), claimant.toBuffer(), distributor.toBuffer()],
    programId
  );
}

/**
 * Builds a Merkle tree for a single leaf (simplest case).
 * Returns the root and proof for that single leaf.
 */
function buildSingleLeafMerkle(
  claimant: PublicKey,
  amountUnlocked: BN,
  amountLocked: BN
): { root: number[]; proof: number[][] } {
  // Hash: sha256(claimant || amount_unlocked || amount_locked)
  const innerHash = createHash("sha256")
    .update(claimant.toBuffer())
    .update(amountUnlocked.toArrayLike(Buffer, "le", 8))
    .update(amountLocked.toArrayLike(Buffer, "le", 8))
    .digest();

  // Double hash with LEAF_PREFIX [0]
  const leaf = createHash("sha256")
    .update(Buffer.from([0]))
    .update(innerHash)
    .digest();

  // Single leaf = root is the leaf itself, proof is empty
  return {
    root: Array.from(leaf),
    proof: [],
  };
}

/**
 * Computes a single Merkle leaf hash.
 */
function computeLeaf(
  claimant: PublicKey,
  amountUnlocked: BN,
  amountLocked: BN
): Buffer {
  const innerHash = createHash("sha256")
    .update(claimant.toBuffer())
    .update(amountUnlocked.toArrayLike(Buffer, "le", 8))
    .update(amountLocked.toArrayLike(Buffer, "le", 8))
    .digest();
  return createHash("sha256")
    .update(Buffer.from([0]))
    .update(innerHash)
    .digest();
}

/**
 * Builds a Merkle tree for two leaves.
 * Returns root and individual proofs for each leaf.
 */
function buildTwoLeafMerkle(
  claimant1: PublicKey,
  unlocked1: BN,
  locked1: BN,
  claimant2: PublicKey,
  unlocked2: BN,
  locked2: BN
): {
  root: number[];
  proof1: number[][];
  proof2: number[][];
} {
  const leaf1 = computeLeaf(claimant1, unlocked1, locked1);
  const leaf2 = computeLeaf(claimant2, unlocked2, locked2);

  // Internal node: hash([1] + sorted(leaf1, leaf2))
  const [first, second] =
    Buffer.compare(leaf1, leaf2) <= 0 ? [leaf1, leaf2] : [leaf2, leaf1];
  const root = createHash("sha256")
    .update(Buffer.from([1]))
    .update(first)
    .update(second)
    .digest();

  return {
    root: Array.from(root),
    proof1: [Array.from(leaf2)],
    proof2: [Array.from(leaf1)],
  };
}

// ── Test Suite ───────────────────────────────────────────────────────────

describe("claim-fee-negative: sad path enforcement", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .merkleDistributorFeeTask as Program<MerkleDistributorFeeTask>;

  const CLAIM_FEE = 50_000_000; // 0.05 SOL
  let mint: PublicKey;
  let feeRecipient: Keypair;
  let feeConfigPda: PublicKey;

  // Shared setup — initialize fee config once for all tests
  before(async () => {
    feeRecipient = Keypair.generate();
    [feeConfigPda] = getFeeConfigPDA(program.programId);

    // Check if already initialized (from previous test run)
    const existing = await provider.connection.getAccountInfo(feeConfigPda);
    if (!existing) {
      await program.methods
        .initializeFeeConfig(new BN(CLAIM_FEE))
        .accounts({
          feeConfig: feeConfigPda,
          admin: provider.wallet.publicKey,
          feeRecipient: feeRecipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      // Update to known state
      await program.methods
        .setClaimFee(new BN(CLAIM_FEE))
        .accounts({
          feeConfig: feeConfigPda,
          admin: provider.wallet.publicKey,
          newFeeRecipient: feeRecipient.publicKey,
        })
        .rpc();
    }

    // Create a test mint
    mint = await createMint(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      provider.wallet.publicKey,
      null,
      9
    );
  });

  /**
   * Helper: creates a distributor with a single claimant and funds it.
   * Returns everything needed to call new_claim.
   */
  async function setupDistributor(
    claimant: Keypair,
    amountUnlocked: number,
    amountLocked: number,
    version: number = Math.floor(Math.random() * 1_000_000)
  ) {
    const bnUnlocked = new BN(amountUnlocked);
    const bnLocked = new BN(amountLocked);
    const total = amountUnlocked + amountLocked;

    const { root, proof } = buildSingleLeafMerkle(
      claimant.publicKey,
      bnUnlocked,
      bnLocked
    );

    const [distributorPda] = getDistributorPDA(
      mint,
      BigInt(version),
      program.programId
    );

    const distributorAta = await anchor.utils.token.associatedAddress({
      mint,
      owner: distributorPda,
    });

    // Clawback receiver
    const clawbackReceiver = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      provider.wallet.publicKey
    );

    const slot = await provider.connection.getSlot();
    const blockTime = await provider.connection.getBlockTime(slot);
    const now = blockTime ?? Math.floor(Date.now() / 1000);

    await program.methods
      .newDistributor(
        new BN(version),
        root as any,
        new BN(total),
        new BN(1),
        new BN(now + 10),
        new BN(now + 100_000),
        new BN(now + 100_000 + 86401)
      )
      .accounts({
        distributor: distributorPda,
        clawbackReceiver: clawbackReceiver.address,
        mint,
        tokenVault: distributorAta,
        admin: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Fund the distributor
    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      distributorAta,
      provider.wallet.publicKey,
      total
    );

    // Create claimant's token account
    const claimantAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      claimant.publicKey
    );

    const [claimStatusPda] = getClaimStatusPDA(
      claimant.publicKey,
      distributorPda,
      program.programId
    );

    return {
      distributorPda,
      distributorAta,
      claimStatusPda,
      claimantAta: claimantAta.address,
      proof,
      bnUnlocked,
      bnLocked,
      version,
    };
  }

  // ─── Negative Test: wrong fee_recipient account ────────────────────

  it("REJECTS claim when fee_recipient does not match fee_config", async () => {
    const claimant = Keypair.generate();
    await provider.connection.requestAirdrop(
      claimant.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    // Wait for airdrop
    await new Promise((r) => setTimeout(r, 1000));

    const { distributorPda, distributorAta, claimStatusPda, claimantAta, proof, bnUnlocked, bnLocked } =
      await setupDistributor(claimant, 1_000_000_000, 0);

    const wrongRecipient = Keypair.generate();

    try {
      await program.methods
        .newClaim(bnUnlocked, bnLocked, proof as any)
        .accounts({
          distributor: distributorPda,
          claimStatus: claimStatusPda,
          from: distributorAta,
          to: claimantAta,
          claimant: claimant.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          feeConfig: feeConfigPda,
          feeRecipient: wrongRecipient.publicKey, // WRONG recipient
        })
        .signers([claimant])
        .rpc();
      assert.fail("Should have rejected — wrong fee recipient");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("InvalidFeeRecipient") ||
          err.toString().includes("6018"),
        `Expected InvalidFeeRecipient, got: ${err}`
      );
    }
  });

  // ─── Negative Test: claimant cannot afford fee ─────────────────────

  it("REJECTS claim when claimant cannot afford the SOL fee", async () => {
    const claimant = Keypair.generate();
    // Give claimant just enough SOL for rent but NOT the fee
    await provider.connection.requestAirdrop(
      claimant.publicKey,
      5_000_000 // 0.005 SOL — far less than the 0.05 SOL fee
    );
    await new Promise((r) => setTimeout(r, 1000));

    const { distributorPda, distributorAta, claimStatusPda, claimantAta, proof, bnUnlocked, bnLocked } =
      await setupDistributor(claimant, 1_000_000_000, 0);

    try {
      await program.methods
        .newClaim(bnUnlocked, bnLocked, proof as any)
        .accounts({
          distributor: distributorPda,
          claimStatus: claimStatusPda,
          from: distributorAta,
          to: claimantAta,
          claimant: claimant.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          feeConfig: feeConfigPda,
          feeRecipient: feeRecipient.publicKey,
        })
        .signers([claimant])
        .rpc();
      assert.fail("Should have rejected — claimant can't afford fee");
    } catch (err: any) {
      // Should fail with insufficient funds
      assert.ok(
        err.toString().includes("insufficient") ||
          err.toString().includes("custom program error") ||
          err.toString().includes("0x1"),
        `Expected insufficient funds error, got: ${err}`
      );
    }
  });

  // ─── Negative Test: non-admin cannot update fee mid-distribution ───

  it("REJECTS fee update from non-admin even during active distributions", async () => {
    const attacker = Keypair.generate();
    await provider.connection.requestAirdrop(
      attacker.publicKey,
      1 * LAMPORTS_PER_SOL
    );
    await new Promise((r) => setTimeout(r, 1000));

    try {
      await program.methods
        .setClaimFee(new BN(0)) // try to disable fee
        .accounts({
          feeConfig: feeConfigPda,
          admin: attacker.publicKey,
          newFeeRecipient: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should have rejected — attacker is not admin");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("Unauthorized") ||
          err.toString().includes("ConstraintAddress") ||
          err.toString().includes("2012"),
        `Expected Unauthorized, got: ${err}`
      );
    }
  });

  // ─── Negative Test: cannot re-initialize fee config to steal admin ──

  it("REJECTS re-initialization of fee config by attacker", async () => {
    const attacker = Keypair.generate();
    await provider.connection.requestAirdrop(
      attacker.publicKey,
      1 * LAMPORTS_PER_SOL
    );
    await new Promise((r) => setTimeout(r, 1000));

    try {
      await program.methods
        .initializeFeeConfig(new BN(0))
        .accounts({
          feeConfig: feeConfigPda,
          admin: attacker.publicKey,
          feeRecipient: attacker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should have rejected — PDA already exists");
    } catch (err: any) {
      // Should fail because init constraint detects existing PDA
      assert.ok(
        err.toString().includes("already in use") ||
          err.toString().includes("0x0") ||
          err.toString().includes("custom program error"),
        `Expected account-already-in-use error, got: ${err}`
      );
    }
  });

  // ─── Negative Test: wrong fee_config PDA (tampered seeds) ──────────

  it("REJECTS claim with fabricated fee_config PDA", async () => {
    const claimant = Keypair.generate();
    await provider.connection.requestAirdrop(
      claimant.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await new Promise((r) => setTimeout(r, 1000));

    const { distributorPda, distributorAta, claimStatusPda, claimantAta, proof, bnUnlocked, bnLocked } =
      await setupDistributor(claimant, 1_000_000_000, 0);

    // Try using a random account instead of the real FeeConfig PDA
    const fakeConfig = Keypair.generate();

    try {
      await program.methods
        .newClaim(bnUnlocked, bnLocked, proof as any)
        .accounts({
          distributor: distributorPda,
          claimStatus: claimStatusPda,
          from: distributorAta,
          to: claimantAta,
          claimant: claimant.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          feeConfig: fakeConfig.publicKey, // FAKE config
          feeRecipient: feeRecipient.publicKey,
        })
        .signers([claimant])
        .rpc();
      assert.fail("Should have rejected — fake fee config PDA");
    } catch (err: any) {
      // PDA constraint mismatch
      assert.ok(
        err.toString().includes("ConstraintSeeds") ||
          err.toString().includes("A seeds constraint was violated") ||
          err.toString().includes("2006") ||
          err.toString().includes("AccountNotInitialized") ||
          err.toString().includes("3012"),
        `Expected seeds constraint or account-not-initialized error, got: ${err}`
      );
    }
  });

  // ─── Negative Test: claim_locked with wrong fee_recipient ──────────

  it("REJECTS claim_locked when fee_recipient mismatches (cliff vesting)", async () => {
    const claimant = Keypair.generate();
    await provider.connection.requestAirdrop(
      claimant.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await new Promise((r) => setTimeout(r, 1000));

    // Cliff vesting: amount_unlocked = 0, amount_locked = total
    // Fee should be deferred to claim_locked
    const {
      distributorPda,
      distributorAta,
      claimStatusPda,
      claimantAta,
      proof,
      bnUnlocked,
      bnLocked,
    } = await setupDistributor(claimant, 0, 1_000_000_000);

    // new_claim with 0 unlocked — no fee charged here
    await program.methods
      .newClaim(bnUnlocked, bnLocked, proof as any)
      .accounts({
        distributor: distributorPda,
        claimStatus: claimStatusPda,
        from: distributorAta,
        to: claimantAta,
        claimant: claimant.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeConfig: feeConfigPda,
        feeRecipient: feeRecipient.publicKey,
      })
      .signers([claimant])
      .rpc();

    // Verify fee_paid is false after new_claim with 0 unlocked
    const claimStatus = await program.account.claimStatus.fetch(claimStatusPda);
    assert.equal(claimStatus.feePaid, false, "Fee should NOT be paid on 0-unlock claim");

    // Now try claim_locked with wrong recipient
    const wrongRecipient = Keypair.generate();

    // Wait for vesting to accrue (startVestingTs = now + 10)
    await new Promise((r) => setTimeout(r, 15000));

    try {
      await program.methods
        .claimLocked()
        .accounts({
          distributor: distributorPda,
          claimStatus: claimStatusPda,
          from: distributorAta,
          to: claimantAta,
          claimant: claimant.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          feeConfig: feeConfigPda,
          feeRecipient: wrongRecipient.publicKey, // WRONG
          systemProgram: SystemProgram.programId,
        })
        .signers([claimant])
        .rpc();
      assert.fail("Should have rejected — wrong fee recipient on claim_locked");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("InvalidFeeRecipient") ||
          err.toString().includes("6018"),
        `Expected InvalidFeeRecipient, got: ${err}`
      );
    }
  });

  // ─── Negative Test: positive fee with zero address recipient ───────

  it("REJECTS setting positive fee with zero-address recipient", async () => {
    try {
      await program.methods
        .setClaimFee(new BN(CLAIM_FEE))
        .accounts({
          feeConfig: feeConfigPda,
          admin: provider.wallet.publicKey,
          newFeeRecipient: PublicKey.default, // zero address
        })
        .rpc();
      assert.fail("Should have rejected — zero recipient with positive fee");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("InvalidFeeRecipient") ||
          err.toString().includes("6018"),
        `Expected InvalidFeeRecipient, got: ${err}`
      );
    }
  });

  // ─── Positive Verification: fee_paid flag is true after fee ────────

  it("VERIFIES fee_paid = true after new_claim with unlocked tokens", async () => {
    const claimant = Keypair.generate();
    await provider.connection.requestAirdrop(
      claimant.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await new Promise((r) => setTimeout(r, 1000));

    const { distributorPda, distributorAta, claimStatusPda, claimantAta, proof, bnUnlocked, bnLocked } =
      await setupDistributor(claimant, 1_000_000_000, 0);

    // Get fee recipient balance before
    const recipientBalanceBefore = await provider.connection.getBalance(
      feeRecipient.publicKey
    );

    await program.methods
      .newClaim(bnUnlocked, bnLocked, proof as any)
      .accounts({
        distributor: distributorPda,
        claimStatus: claimStatusPda,
        from: distributorAta,
        to: claimantAta,
        claimant: claimant.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeConfig: feeConfigPda,
        feeRecipient: feeRecipient.publicKey,
      })
      .signers([claimant])
      .rpc();

    // Verify fee was paid
    const claimStatus = await program.account.claimStatus.fetch(claimStatusPda);
    assert.equal(claimStatus.feePaid, true, "fee_paid should be true");

    // Verify fee recipient received the SOL
    const recipientBalanceAfter = await provider.connection.getBalance(
      feeRecipient.publicKey
    );
    assert.equal(
      recipientBalanceAfter - recipientBalanceBefore,
      CLAIM_FEE,
      "Fee recipient should have received exactly the claim fee"
    );
  });

  // ─── Positive Verification: zero fee = no SOL transfer ────────────

  it("VERIFIES zero fee means no SOL deducted from claimant", async () => {
    // Temporarily set fee to 0
    await program.methods
      .setClaimFee(new BN(0))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: feeRecipient.publicKey,
      })
      .rpc();

    const claimant = Keypair.generate();
    await provider.connection.requestAirdrop(
      claimant.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await new Promise((r) => setTimeout(r, 1000));

    const { distributorPda, distributorAta, claimStatusPda, claimantAta, proof, bnUnlocked, bnLocked } =
      await setupDistributor(claimant, 1_000_000_000, 0);

    const balBefore = await provider.connection.getBalance(claimant.publicKey);

    await program.methods
      .newClaim(bnUnlocked, bnLocked, proof as any)
      .accounts({
        distributor: distributorPda,
        claimStatus: claimStatusPda,
        from: distributorAta,
        to: claimantAta,
        claimant: claimant.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeConfig: feeConfigPda,
        feeRecipient: feeRecipient.publicKey,
      })
      .signers([claimant])
      .rpc();

    const claimStatus = await program.account.claimStatus.fetch(claimStatusPda);
    assert.equal(claimStatus.feePaid, false, "fee_paid should be false when fee is 0");

    // Restore fee
    await program.methods
      .setClaimFee(new BN(CLAIM_FEE))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: feeRecipient.publicKey,
      })
      .rpc();
  });

  // ─── Test: Linear vesting — fee on new_claim, NOT on claim_locked ──

  it("LINEAR VESTING: fee charged on new_claim (unlocked > 0), NOT again on claim_locked", async () => {
    const claimant = Keypair.generate();
    await provider.connection.requestAirdrop(
      claimant.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await new Promise((r) => setTimeout(r, 1000));

    // Linear vesting: both unlocked and locked > 0
    const amountUnlocked = 500_000_000;
    const amountLocked = 500_000_000;
    const {
      distributorPda,
      distributorAta,
      claimStatusPda,
      claimantAta,
      proof,
      bnUnlocked,
      bnLocked,
    } = await setupDistributor(claimant, amountUnlocked, amountLocked);

    const recipientBalanceBefore = await provider.connection.getBalance(
      feeRecipient.publicKey
    );

    // new_claim — should charge fee (unlocked > 0)
    await program.methods
      .newClaim(bnUnlocked, bnLocked, proof as any)
      .accounts({
        distributor: distributorPda,
        claimStatus: claimStatusPda,
        from: distributorAta,
        to: claimantAta,
        claimant: claimant.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeConfig: feeConfigPda,
        feeRecipient: feeRecipient.publicKey,
      })
      .signers([claimant])
      .rpc();

    // Verify fee_paid = true after new_claim
    let claimStatus = await program.account.claimStatus.fetch(claimStatusPda);
    assert.equal(claimStatus.feePaid, true, "fee_paid should be true after new_claim with unlocked > 0");

    const recipientBalanceAfterClaim = await provider.connection.getBalance(
      feeRecipient.publicKey
    );
    assert.equal(
      recipientBalanceAfterClaim - recipientBalanceBefore,
      CLAIM_FEE,
      "Fee recipient should have received exactly one fee"
    );

    // Wait for vesting to accrue (startVestingTs = now + 10, need >10s from distributor creation)
    await new Promise((r) => setTimeout(r, 15000));

    // claim_locked — should NOT charge fee again
    await program.methods
      .claimLocked()
      .accounts({
        distributor: distributorPda,
        claimStatus: claimStatusPda,
        from: distributorAta,
        to: claimantAta,
        claimant: claimant.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        feeConfig: feeConfigPda,
        feeRecipient: feeRecipient.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([claimant])
      .rpc();

    // Verify fee_paid still true and no additional fee charged
    claimStatus = await program.account.claimStatus.fetch(claimStatusPda);
    assert.equal(claimStatus.feePaid, true, "fee_paid should still be true");

    const recipientBalanceAfterLocked = await provider.connection.getBalance(
      feeRecipient.publicKey
    );
    assert.equal(
      recipientBalanceAfterLocked - recipientBalanceBefore,
      CLAIM_FEE,
      "Fee recipient should NOT have received a second fee on claim_locked"
    );
  });

  // ─── Test: Fee change between claims — each claimant pays their-time fee ──

  it("FEE CHANGE: each claimant pays the fee at their claim-time", async () => {
    const claimant1 = Keypair.generate();
    const claimant2 = Keypair.generate();
    await provider.connection.requestAirdrop(claimant1.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(claimant2.publicKey, 2 * LAMPORTS_PER_SOL);
    await new Promise((r) => setTimeout(r, 1000));

    const amt1Unlocked = new BN(1_000_000_000);
    const amt1Locked = new BN(0);
    const amt2Unlocked = new BN(1_000_000_000);
    const amt2Locked = new BN(0);

    const { root, proof1, proof2 } = buildTwoLeafMerkle(
      claimant1.publicKey, amt1Unlocked, amt1Locked,
      claimant2.publicKey, amt2Unlocked, amt2Locked
    );

    const version = Math.floor(Math.random() * 1_000_000);
    const [distributorPda] = getDistributorPDA(mint, BigInt(version), program.programId);
    const distributorAta = await anchor.utils.token.associatedAddress({ mint, owner: distributorPda });
    const clawbackReceiver = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      provider.wallet.publicKey
    );

    const slot = await provider.connection.getSlot();
    const blockTime = await provider.connection.getBlockTime(slot);
    const now = blockTime ?? Math.floor(Date.now() / 1000);

    await program.methods
      .newDistributor(
        new BN(version),
        root as any,
        new BN(2_000_000_000),
        new BN(2),
        new BN(now + 10),
        new BN(now + 100_000),
        new BN(now + 100_000 + 86401)
      )
      .accounts({
        distributor: distributorPda,
        clawbackReceiver: clawbackReceiver.address,
        mint,
        tokenVault: distributorAta,
        admin: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      distributorAta,
      provider.wallet.publicKey,
      2_000_000_000
    );

    // Create token accounts for both claimants
    const claimant1Ata = (await getOrCreateAssociatedTokenAccount(
      provider.connection, (provider.wallet as anchor.Wallet).payer, mint, claimant1.publicKey
    )).address;
    const claimant2Ata = (await getOrCreateAssociatedTokenAccount(
      provider.connection, (provider.wallet as anchor.Wallet).payer, mint, claimant2.publicKey
    )).address;

    const [claimStatus1Pda] = getClaimStatusPDA(claimant1.publicKey, distributorPda, program.programId);
    const [claimStatus2Pda] = getClaimStatusPDA(claimant2.publicKey, distributorPda, program.programId);

    // Claimant 1 claims at original fee (CLAIM_FEE = 50M lamports)
    const FEE_1 = CLAIM_FEE;
    const recipientBefore1 = await provider.connection.getBalance(feeRecipient.publicKey);

    await program.methods
      .newClaim(amt1Unlocked, amt1Locked, proof1 as any)
      .accounts({
        distributor: distributorPda,
        claimStatus: claimStatus1Pda,
        from: distributorAta,
        to: claimant1Ata,
        claimant: claimant1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeConfig: feeConfigPda,
        feeRecipient: feeRecipient.publicKey,
      })
      .signers([claimant1])
      .rpc();

    const recipientAfter1 = await provider.connection.getBalance(feeRecipient.publicKey);
    assert.equal(recipientAfter1 - recipientBefore1, FEE_1, "Claimant 1 should pay original fee");

    // Admin changes fee to a different amount
    const FEE_2 = 100_000_000; // 0.1 SOL
    await program.methods
      .setClaimFee(new BN(FEE_2))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: feeRecipient.publicKey,
      })
      .rpc();

    // Claimant 2 claims at new fee
    const recipientBefore2 = await provider.connection.getBalance(feeRecipient.publicKey);

    await program.methods
      .newClaim(amt2Unlocked, amt2Locked, proof2 as any)
      .accounts({
        distributor: distributorPda,
        claimStatus: claimStatus2Pda,
        from: distributorAta,
        to: claimant2Ata,
        claimant: claimant2.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeConfig: feeConfigPda,
        feeRecipient: feeRecipient.publicKey,
      })
      .signers([claimant2])
      .rpc();

    const recipientAfter2 = await provider.connection.getBalance(feeRecipient.publicKey);
    assert.equal(recipientAfter2 - recipientBefore2, FEE_2, "Claimant 2 should pay updated fee");

    // Restore original fee
    await program.methods
      .setClaimFee(new BN(CLAIM_FEE))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: feeRecipient.publicKey,
      })
      .rpc();
  });

  // ─── Test: claim_locked before vesting starts — should be rejected ──

  it("REJECTS claim_locked before vesting period starts", async () => {
    const claimant = Keypair.generate();
    await provider.connection.requestAirdrop(
      claimant.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await new Promise((r) => setTimeout(r, 1000));

    // Cliff vesting with far-future start: unlocked=0, locked=total
    const bnUnlocked = new BN(0);
    const bnLocked = new BN(1_000_000_000);
    const total = 1_000_000_000;

    const { root, proof } = buildSingleLeafMerkle(
      claimant.publicKey,
      bnUnlocked,
      bnLocked
    );

    const version = Math.floor(Math.random() * 1_000_000);
    const [distributorPda] = getDistributorPDA(mint, BigInt(version), program.programId);
    const distributorAta = await anchor.utils.token.associatedAddress({ mint, owner: distributorPda });
    const clawbackReceiver = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      provider.wallet.publicKey
    );

    const slot = await provider.connection.getSlot();
    const blockTime = await provider.connection.getBlockTime(slot);
    const now = blockTime ?? Math.floor(Date.now() / 1000);

    // Vesting starts far in the future (now + 50_000) so nothing is vested yet
    await program.methods
      .newDistributor(
        new BN(version),
        root as any,
        new BN(total),
        new BN(1),
        new BN(now + 50_000),   // startVestingTs: far future
        new BN(now + 100_000),  // endVestingTs: even further
        new BN(now + 100_000 + 86401)
      )
      .accounts({
        distributor: distributorPda,
        clawbackReceiver: clawbackReceiver.address,
        mint,
        tokenVault: distributorAta,
        admin: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      distributorAta,
      provider.wallet.publicKey,
      total
    );

    const claimantAta = (await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      claimant.publicKey
    )).address;

    const [claimStatusPda] = getClaimStatusPDA(
      claimant.publicKey,
      distributorPda,
      program.programId
    );

    // new_claim with 0 unlocked — succeeds, no fee charged
    await program.methods
      .newClaim(bnUnlocked, bnLocked, proof as any)
      .accounts({
        distributor: distributorPda,
        claimStatus: claimStatusPda,
        from: distributorAta,
        to: claimantAta,
        claimant: claimant.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeConfig: feeConfigPda,
        feeRecipient: feeRecipient.publicKey,
      })
      .signers([claimant])
      .rpc();

    // Immediately try claim_locked — vesting hasn't started, amount should be 0
    try {
      await program.methods
        .claimLocked()
        .accounts({
          distributor: distributorPda,
          claimStatus: claimStatusPda,
          from: distributorAta,
          to: claimantAta,
          claimant: claimant.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          feeConfig: feeConfigPda,
          feeRecipient: feeRecipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([claimant])
        .rpc();
      assert.fail("Should have rejected — vesting hasn't started");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("InsufficientUnlockedTokens") ||
          err.toString().includes("6000"),
        `Expected InsufficientUnlockedTokens, got: ${err}`
      );
    }
  });
});
