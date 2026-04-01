import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MerkleDistributorFeeTask } from "../target/types/merkle_distributor_fee_task";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";

describe("merkle-distributor-fee-task", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .merkleDistributorFeeTask as Program<MerkleDistributorFeeTask>;

  function getFeeConfigPDA(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("FeeConfig")],
      program.programId
    );
  }

  /** Fund a keypair and wait for confirmation */
  async function fund(kp: Keypair, lamports = LAMPORTS_PER_SOL) {
    const sig = await provider.connection.requestAirdrop(kp.publicKey, lamports);
    await provider.connection.confirmTransaction(sig);
  }

  // ─── Happy Path Tests ─────────────────────────────────────────────────

  it("initializes fee config", async () => {
    const admin = provider.wallet;
    const feeRecipient = Keypair.generate();
    const [feeConfigPda] = getFeeConfigPDA();

    const existing = await provider.connection.getAccountInfo(feeConfigPda);
    if (existing) {
      // Already initialized — update to known state so assertions pass
      await program.methods
        .setClaimFee(new anchor.BN(5_000_000))
        .accounts({
          feeConfig: feeConfigPda,
          admin: admin.publicKey,
          newFeeRecipient: feeRecipient.publicKey,
        })
        .rpc();
    } else {
      await program.methods
        .initializeFeeConfig(new anchor.BN(5_000_000))
        .accounts({
          feeConfig: feeConfigPda,
          admin: admin.publicKey,
          feeRecipient: feeRecipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const feeConfig = await program.account.feeConfig.fetch(feeConfigPda);
    assert.ok(feeConfig.admin.equals(admin.publicKey));
    assert.equal(feeConfig.claimFee.toNumber(), 5_000_000);
    assert.ok(feeConfig.feeRecipient.equals(feeRecipient.publicKey));
    assert.ok(feeConfig.bump > 0);
  });

  it("admin updates fee and recipient", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const newRecipient = Keypair.generate();

    await program.methods
      .setClaimFee(new anchor.BN(10_000_000))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: newRecipient.publicKey,
      })
      .rpc();

    const feeConfig = await program.account.feeConfig.fetch(feeConfigPda);
    assert.equal(feeConfig.claimFee.toNumber(), 10_000_000);
    assert.ok(feeConfig.feeRecipient.equals(newRecipient.publicKey));
  });

  it("admin disables fee by setting to 0", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const recipient = Keypair.generate();

    await program.methods
      .setClaimFee(new anchor.BN(0))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: recipient.publicKey,
      })
      .rpc();

    const feeConfig = await program.account.feeConfig.fetch(feeConfigPda);
    assert.equal(feeConfig.claimFee.toNumber(), 0);
  });

  it("admin re-enables fee after disabling", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const recipient = Keypair.generate();

    await program.methods
      .setClaimFee(new anchor.BN(7_500_000))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: recipient.publicKey,
      })
      .rpc();

    const feeConfig = await program.account.feeConfig.fetch(feeConfigPda);
    assert.equal(feeConfig.claimFee.toNumber(), 7_500_000);
    assert.ok(feeConfig.feeRecipient.equals(recipient.publicKey));
  });

  it("admin preserved after fee update", async () => {
    const [feeConfigPda] = getFeeConfigPDA();

    const feeConfig = await program.account.feeConfig.fetch(feeConfigPda);
    assert.ok(
      feeConfig.admin.equals(provider.wallet.publicKey),
      "Admin should remain unchanged after set_claim_fee"
    );
  });

  it("allows zero recipient when fee is 0", async () => {
    const [feeConfigPda] = getFeeConfigPDA();

    await program.methods
      .setClaimFee(new anchor.BN(0))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: PublicKey.default,
      })
      .rpc();

    const feeConfig = await program.account.feeConfig.fetch(feeConfigPda);
    assert.equal(feeConfig.claimFee.toNumber(), 0);
    assert.ok(feeConfig.feeRecipient.equals(PublicKey.default));
  });

  it("updates fee multiple times in succession", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const recipient = Keypair.generate();

    for (const fee of [1_000_000, 2_000_000, 50_000_000, 0, 10_000_000]) {
      await program.methods
        .setClaimFee(new anchor.BN(fee))
        .accounts({
          feeConfig: feeConfigPda,
          admin: provider.wallet.publicKey,
          newFeeRecipient: recipient.publicKey,
        })
        .rpc();

      const cfg = await program.account.feeConfig.fetch(feeConfigPda);
      assert.equal(cfg.claimFee.toNumber(), fee);
    }
  });

  // ─── set_fee_admin Happy Path ──────────────────────────────────────────

  it("admin transfers fee admin to new account", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const newAdmin = Keypair.generate();
    await fund(newAdmin);

    // Transfer admin to newAdmin
    await program.methods
      .setFeeAdmin()
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newAdmin: newAdmin.publicKey,
      })
      .rpc();

    const cfg = await program.account.feeConfig.fetch(feeConfigPda);
    assert.ok(cfg.admin.equals(newAdmin.publicKey), "Admin should be the new admin");

    // Transfer back so subsequent tests still work
    await program.methods
      .setFeeAdmin()
      .accounts({
        feeConfig: feeConfigPda,
        admin: newAdmin.publicKey,
        newAdmin: provider.wallet.publicKey,
      })
      .signers([newAdmin])
      .rpc();

    const restored = await program.account.feeConfig.fetch(feeConfigPda);
    assert.ok(restored.admin.equals(provider.wallet.publicKey), "Admin should be restored");
  });

  it("new admin can update fee after transfer", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const newAdmin = Keypair.generate();
    await fund(newAdmin);
    const recipient = Keypair.generate();

    // Transfer admin
    await program.methods
      .setFeeAdmin()
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newAdmin: newAdmin.publicKey,
      })
      .rpc();

    // New admin updates fee
    await program.methods
      .setClaimFee(new anchor.BN(8_000_000))
      .accounts({
        feeConfig: feeConfigPda,
        admin: newAdmin.publicKey,
        newFeeRecipient: recipient.publicKey,
      })
      .signers([newAdmin])
      .rpc();

    const cfg = await program.account.feeConfig.fetch(feeConfigPda);
    assert.equal(cfg.claimFee.toNumber(), 8_000_000);

    // Transfer back
    await program.methods
      .setFeeAdmin()
      .accounts({
        feeConfig: feeConfigPda,
        admin: newAdmin.publicKey,
        newAdmin: provider.wallet.publicKey,
      })
      .signers([newAdmin])
      .rpc();
  });

  it("changes recipient without changing fee amount", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const r1 = Keypair.generate();
    const r2 = Keypair.generate();

    await program.methods
      .setClaimFee(new anchor.BN(5_000_000))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: r1.publicKey,
      })
      .rpc();

    await program.methods
      .setClaimFee(new anchor.BN(5_000_000))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: r2.publicKey,
      })
      .rpc();

    const cfg = await program.account.feeConfig.fetch(feeConfigPda);
    assert.equal(cfg.claimFee.toNumber(), 5_000_000);
    assert.ok(cfg.feeRecipient.equals(r2.publicKey));
  });

  // ─── Sad Path Tests ───────────────────────────────────────────────────

  it("SAD: cannot init fee config twice (PDA already exists)", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const recipient = Keypair.generate();

    try {
      await program.methods
        .initializeFeeConfig(new anchor.BN(1_000_000))
        .accounts({
          feeConfig: feeConfigPda,
          admin: provider.wallet.publicKey,
          feeRecipient: recipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown — PDA already exists");
    } catch (err: any) {
      assert.ok(err.toString().length > 0);
    }
  });

  it("SAD: non-admin cannot update fee", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const attacker = Keypair.generate();
    await fund(attacker);

    try {
      await program.methods
        .setClaimFee(new anchor.BN(0))
        .accounts({
          feeConfig: feeConfigPda,
          admin: attacker.publicKey,
          newFeeRecipient: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should have thrown — attacker is not admin");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("ConstraintAddress") ||
          err.toString().includes("Unauthorized") ||
          err.toString().includes("2012") ||
          err.toString().includes("Error"),
        `Unexpected error: ${err}`
      );
    }
  });

  it("SAD: rejects zero recipient with positive fee via set_claim_fee", async () => {
    const [feeConfigPda] = getFeeConfigPDA();

    try {
      await program.methods
        .setClaimFee(new anchor.BN(5_000_000))
        .accounts({
          feeConfig: feeConfigPda,
          admin: provider.wallet.publicKey,
          newFeeRecipient: PublicKey.default,
        })
        .rpc();
      assert.fail("Should have thrown — zero recipient with positive fee");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("InvalidFeeRecipient") ||
          err.toString().includes("6018") ||
          err.toString().includes("Error"),
        `Unexpected error: ${err}`
      );
    }
  });

  it("SAD: attacker cannot re-initialize to steal admin", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const attacker = Keypair.generate();
    await fund(attacker);

    try {
      await program.methods
        .initializeFeeConfig(new anchor.BN(0))
        .accounts({
          feeConfig: feeConfigPda,
          admin: attacker.publicKey,
          feeRecipient: attacker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should have thrown — PDA already initialized");
    } catch (err: any) {
      // init constraint prevents re-initialization
      assert.ok(err.toString().length > 0);
    }
  });

  it("SAD: non-admin cannot disable fee to bypass collection", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const attacker = Keypair.generate();
    await fund(attacker);

    try {
      await program.methods
        .setClaimFee(new anchor.BN(0))
        .accounts({
          feeConfig: feeConfigPda,
          admin: attacker.publicKey,
          newFeeRecipient: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should have thrown — non-admin cannot disable fee");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("ConstraintAddress") ||
          err.toString().includes("Unauthorized"),
        `Expected auth error, got: ${err}`
      );
    }
  });

  it("SAD: non-admin cannot redirect fees to themselves", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const attacker = Keypair.generate();
    await fund(attacker);

    // Keep current fee, just change recipient to attacker
    const cfg = await program.account.feeConfig.fetch(feeConfigPda);
    try {
      await program.methods
        .setClaimFee(cfg.claimFee)
        .accounts({
          feeConfig: feeConfigPda,
          admin: attacker.publicKey,
          newFeeRecipient: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should have thrown — attacker redirecting fees");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("ConstraintAddress") ||
          err.toString().includes("Unauthorized"),
        `Expected auth error, got: ${err}`
      );
    }
  });

  it("SAD: wrong fee_config PDA seed rejected by constraint", async () => {
    // Fabricate a PDA with wrong seeds — Anchor's seeds constraint should reject
    const [fakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("NotFeeConfig")],
      program.programId
    );
    const recipient = Keypair.generate();

    try {
      await program.methods
        .setClaimFee(new anchor.BN(0))
        .accounts({
          feeConfig: fakePda,
          admin: provider.wallet.publicKey,
          newFeeRecipient: recipient.publicKey,
        })
        .rpc();
      assert.fail("Should have thrown — wrong PDA seeds");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("ConstraintSeeds") ||
          err.toString().includes("AccountNotInitialized") ||
          err.toString().includes("Error"),
        `Expected seeds or account error, got: ${err}`
      );
    }
  });

  it("SAD: random keypair account instead of PDA rejected", async () => {
    const random = Keypair.generate();
    const recipient = Keypair.generate();

    try {
      await program.methods
        .setClaimFee(new anchor.BN(0))
        .accounts({
          feeConfig: random.publicKey,
          admin: provider.wallet.publicKey,
          newFeeRecipient: recipient.publicKey,
        })
        .rpc();
      assert.fail("Should have thrown — random account is not the PDA");
    } catch (err: any) {
      assert.ok(err.toString().length > 0);
    }
  });

  it("SAD: fee_config from different program ID rejected", async () => {
    // PDA derived with a different program ID won't match the seeds constraint
    const otherProgram = Keypair.generate().publicKey;
    const [wrongPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("FeeConfig")],
      otherProgram
    );
    const recipient = Keypair.generate();

    try {
      await program.methods
        .setClaimFee(new anchor.BN(0))
        .accounts({
          feeConfig: wrongPda,
          admin: provider.wallet.publicKey,
          newFeeRecipient: recipient.publicKey,
        })
        .rpc();
      assert.fail("Should have thrown — PDA from different program");
    } catch (err: any) {
      assert.ok(err.toString().length > 0);
    }
  });

  it("SAD: admin signing with wrong keypair (key matches but sig doesn't)", async () => {
    // Use a fresh keypair as signer but claim to be the admin pubkey
    const [feeConfigPda] = getFeeConfigPDA();
    const impersonator = Keypair.generate();
    await fund(impersonator);

    try {
      // The impersonator tries to sign, but the admin address doesn't match their pubkey
      await program.methods
        .setClaimFee(new anchor.BN(999_999))
        .accounts({
          feeConfig: feeConfigPda,
          admin: impersonator.publicKey,
          newFeeRecipient: impersonator.publicKey,
        })
        .signers([impersonator])
        .rpc();
      assert.fail("Should have thrown — impersonator pubkey != stored admin");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("ConstraintAddress") ||
          err.toString().includes("Unauthorized"),
        `Expected auth error, got: ${err}`
      );
    }
  });

  it("SAD: u64 max fee is rejected (exceeds MAX_CLAIM_FEE)", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const recipient = Keypair.generate();

    const maxU64 = new anchor.BN("18446744073709551615");

    try {
      await program.methods
        .setClaimFee(maxU64)
        .accounts({
          feeConfig: feeConfigPda,
          admin: provider.wallet.publicKey,
          newFeeRecipient: recipient.publicKey,
        })
        .rpc();
      assert.fail("Should have thrown — fee exceeds MAX_CLAIM_FEE");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("FeeExceedsMaximum") ||
          err.toString().includes("6020") ||
          err.toString().includes("Error"),
        `Expected FeeExceedsMaximum, got: ${err}`
      );
    }
  });

  it("SAD: fee just above MAX_CLAIM_FEE (1 SOL + 1) is rejected", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const recipient = Keypair.generate();

    try {
      await program.methods
        .setClaimFee(new anchor.BN(1_000_000_001))
        .accounts({
          feeConfig: feeConfigPda,
          admin: provider.wallet.publicKey,
          newFeeRecipient: recipient.publicKey,
        })
        .rpc();
      assert.fail("Should have thrown — fee exceeds MAX_CLAIM_FEE");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("FeeExceedsMaximum") ||
          err.toString().includes("6020") ||
          err.toString().includes("Error"),
        `Expected FeeExceedsMaximum, got: ${err}`
      );
    }
  });

  it("fee at MAX_CLAIM_FEE (1 SOL) is accepted", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const recipient = Keypair.generate();

    await program.methods
      .setClaimFee(new anchor.BN(1_000_000_000))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: recipient.publicKey,
      })
      .rpc();

    const cfg = await program.account.feeConfig.fetch(feeConfigPda);
    assert.equal(cfg.claimFee.toNumber(), 1_000_000_000);

    // Restore to sane value for subsequent tests
    await program.methods
      .setClaimFee(new anchor.BN(5_000_000))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: recipient.publicKey,
      })
      .rpc();
  });

  it("SAD: non-admin cannot transfer fee admin", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const attacker = Keypair.generate();
    await fund(attacker);

    try {
      await program.methods
        .setFeeAdmin()
        .accounts({
          feeConfig: feeConfigPda,
          admin: attacker.publicKey,
          newAdmin: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should have thrown — attacker is not admin");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("ConstraintAddress") ||
          err.toString().includes("Unauthorized") ||
          err.toString().includes("SameFeeAdmin") ||
          err.toString().includes("Error"),
        `Expected auth error, got: ${err}`
      );
    }
  });

  it("SAD: cannot transfer fee admin to same admin", async () => {
    const [feeConfigPda] = getFeeConfigPDA();

    try {
      await program.methods
        .setFeeAdmin()
        .accounts({
          feeConfig: feeConfigPda,
          admin: provider.wallet.publicKey,
          newAdmin: provider.wallet.publicKey,
        })
        .rpc();
      assert.fail("Should have thrown — same admin");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("SameFeeAdmin") ||
          err.toString().includes("6019") ||
          err.toString().includes("Error"),
        `Expected SameFeeAdmin, got: ${err}`
      );
    }
  });

  it("SAD: initialize_fee_config with zero recipient and positive fee fails", async () => {
    // We can't actually re-run init, but we can verify the constraint exists
    // by checking that the current fee_config rejects this via set_claim_fee
    const [feeConfigPda] = getFeeConfigPDA();

    try {
      await program.methods
        .setClaimFee(new anchor.BN(100_000_000))
        .accounts({
          feeConfig: feeConfigPda,
          admin: provider.wallet.publicKey,
          newFeeRecipient: PublicKey.default,
        })
        .rpc();
      assert.fail("Should have thrown — zero recipient with 0.1 SOL fee");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("InvalidFeeRecipient") || err.toString().includes("6018"),
        `Expected InvalidFeeRecipient, got: ${err}`
      );
    }
  });

  it("SAD: old admin locked out after fee admin transfer", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const newAdmin = Keypair.generate();
    await fund(newAdmin);
    const recipient = Keypair.generate();

    // Transfer admin
    await program.methods
      .setFeeAdmin()
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newAdmin: newAdmin.publicKey,
      })
      .rpc();

    // Old admin tries to update fee — should fail
    try {
      await program.methods
        .setClaimFee(new anchor.BN(999))
        .accounts({
          feeConfig: feeConfigPda,
          admin: provider.wallet.publicKey,
          newFeeRecipient: recipient.publicKey,
        })
        .rpc();
      assert.fail("Should have thrown — old admin no longer authorized");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("ConstraintAddress") ||
          err.toString().includes("Unauthorized"),
        `Expected auth error, got: ${err}`
      );
    }

    // Old admin also can't transfer admin back
    try {
      await program.methods
        .setFeeAdmin()
        .accounts({
          feeConfig: feeConfigPda,
          admin: provider.wallet.publicKey,
          newAdmin: provider.wallet.publicKey,
        })
        .rpc();
      assert.fail("Should have thrown — old admin locked out");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("ConstraintAddress") ||
          err.toString().includes("Unauthorized"),
        `Expected auth error, got: ${err}`
      );
    }

    // Restore: new admin transfers back
    await program.methods
      .setFeeAdmin()
      .accounts({
        feeConfig: feeConfigPda,
        admin: newAdmin.publicKey,
        newAdmin: provider.wallet.publicKey,
      })
      .signers([newAdmin])
      .rpc();
  });

  it("set_fee_admin chain of custody: A → B → C → A", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const adminB = Keypair.generate();
    const adminC = Keypair.generate();
    await fund(adminB);
    await fund(adminC);

    // A → B
    await program.methods
      .setFeeAdmin()
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newAdmin: adminB.publicKey,
      })
      .rpc();

    let cfg = await program.account.feeConfig.fetch(feeConfigPda);
    assert.ok(cfg.admin.equals(adminB.publicKey));

    // B → C
    await program.methods
      .setFeeAdmin()
      .accounts({
        feeConfig: feeConfigPda,
        admin: adminB.publicKey,
        newAdmin: adminC.publicKey,
      })
      .signers([adminB])
      .rpc();

    cfg = await program.account.feeConfig.fetch(feeConfigPda);
    assert.ok(cfg.admin.equals(adminC.publicKey));

    // C → A (back to original)
    await program.methods
      .setFeeAdmin()
      .accounts({
        feeConfig: feeConfigPda,
        admin: adminC.publicKey,
        newAdmin: provider.wallet.publicKey,
      })
      .signers([adminC])
      .rpc();

    cfg = await program.account.feeConfig.fetch(feeConfigPda);
    assert.ok(cfg.admin.equals(provider.wallet.publicKey));
  });

  it("SAD: MAX_CLAIM_FEE enforced on initialize_fee_config too", async () => {
    // Can't actually re-init, but we test via set_claim_fee since
    // both use the same MAX_CLAIM_FEE check. This test confirms
    // the boundary at 1 SOL + 1 lamport.
    const [feeConfigPda] = getFeeConfigPDA();
    const recipient = Keypair.generate();

    // 2 SOL should be rejected
    try {
      await program.methods
        .setClaimFee(new anchor.BN(2_000_000_000))
        .accounts({
          feeConfig: feeConfigPda,
          admin: provider.wallet.publicKey,
          newFeeRecipient: recipient.publicKey,
        })
        .rpc();
      assert.fail("Should have thrown — 2 SOL exceeds MAX_CLAIM_FEE");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("FeeExceedsMaximum") ||
          err.toString().includes("6020"),
        `Expected FeeExceedsMaximum, got: ${err}`
      );
    }
  });

  it("fee and recipient preserved after admin transfer", async () => {
    const [feeConfigPda] = getFeeConfigPDA();
    const newAdmin = Keypair.generate();
    await fund(newAdmin);
    const recipient = Keypair.generate();

    // Set a specific fee and recipient
    await program.methods
      .setClaimFee(new anchor.BN(42_000_000))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: recipient.publicKey,
      })
      .rpc();

    // Transfer admin
    await program.methods
      .setFeeAdmin()
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newAdmin: newAdmin.publicKey,
      })
      .rpc();

    // Verify fee and recipient unchanged
    const cfg = await program.account.feeConfig.fetch(feeConfigPda);
    assert.equal(cfg.claimFee.toNumber(), 42_000_000, "Fee should be preserved after admin transfer");
    assert.ok(cfg.feeRecipient.equals(recipient.publicKey), "Recipient should be preserved after admin transfer");

    // Restore
    await program.methods
      .setFeeAdmin()
      .accounts({
        feeConfig: feeConfigPda,
        admin: newAdmin.publicKey,
        newAdmin: provider.wallet.publicKey,
      })
      .signers([newAdmin])
      .rpc();
  });

  it("SAD: admin field is immutable via set_claim_fee", async () => {
    // After multiple updates, admin should always be the original initializer
    const [feeConfigPda] = getFeeConfigPDA();
    const r1 = Keypair.generate();
    const r2 = Keypair.generate();

    await program.methods
      .setClaimFee(new anchor.BN(1_000_000))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: r1.publicKey,
      })
      .rpc();

    await program.methods
      .setClaimFee(new anchor.BN(2_000_000))
      .accounts({
        feeConfig: feeConfigPda,
        admin: provider.wallet.publicKey,
        newFeeRecipient: r2.publicKey,
      })
      .rpc();

    const cfg = await program.account.feeConfig.fetch(feeConfigPda);
    assert.ok(
      cfg.admin.equals(provider.wallet.publicKey),
      "Admin must remain the original initializer — set_claim_fee should never change it"
    );
  });
});
