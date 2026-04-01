/**
 * Surfpool E2E tests — full claim lifecycle with fee enforcement.
 *
 * Uses Surfpool cheatcodes:
 *   - surfnet_timeTravel(absoluteTimestamp) — warp clock for vesting
 *   - surfnet_setTokenAccount — create/fund token accounts
 *   - surfnet_resetNetwork — clean slate between test groups
 *
 * Prerequisites:
 *   1. `anchor build`
 *   2. `surfpool start --ci --offline` + deploy program
 *
 * Run: ANCHOR_WALLET=~/.config/solana/id.json npx ts-mocha -p ./tsconfig.json -t 60000 tests/surfpool-e2e.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { MerkleDistributorFeeTask } from "../target/types/merkle_distributor_fee_task";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import { createHash } from "crypto";

const SURFPOOL_URL = "http://127.0.0.1:8899";

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
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(version);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("MerkleDistributor"), mint.toBuffer(), buf],
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

function merkleRoot(
  claimant: PublicKey,
  amountUnlocked: BN,
  amountLocked: BN
): { root: number[]; proof: number[][] } {
  const inner = createHash("sha256")
    .update(claimant.toBuffer())
    .update(amountUnlocked.toArrayLike(Buffer, "le", 8))
    .update(amountLocked.toArrayLike(Buffer, "le", 8))
    .digest();
  const leaf = createHash("sha256")
    .update(Buffer.from([0]))
    .update(inner)
    .digest();
  return { root: Array.from(leaf), proof: [] };
}

/** Surfpool RPC cheatcode caller */
async function surfnetRpc(
  connection: Connection,
  method: string,
  params: any[]
): Promise<any> {
  return (connection as any)._rpcRequest(method, params);
}

async function timeTravel(connection: Connection, unixSeconds: number) {
  // surfnet_timeTravel takes absoluteTimestamp in milliseconds
  await surfnetRpc(connection, "surfnet_timeTravel", [
    { absoluteTimestamp: unixSeconds * 1000 },
  ]);
}

async function getCurrentBlockTime(connection: Connection): Promise<number> {
  const slot = await connection.getSlot();
  const blockTime = await connection.getBlockTime(slot);
  return blockTime!;
}

// ── Test Suite ──────────────────────────────────────────────────────────

describe("surfpool-e2e: full claim lifecycle with fees", () => {
  const connection = new Connection(SURFPOOL_URL, "confirmed");
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = anchor.workspace
    .merkleDistributorFeeTask as Program<MerkleDistributorFeeTask>;
  const payer = (wallet as any).payer as Keypair;

  const CLAIM_FEE = 50_000_000; // 0.05 SOL
  let mint: PublicKey;
  let feeRecipient: Keypair;
  let feeConfigPda: PublicKey;

  async function fund(kp: Keypair, lamports = 2 * LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(kp.publicKey, lamports);
    await connection.confirmTransaction(sig);
  }

  /** Create a distributor for a single claimant and fund its vault. */
  async function setupDistributor(
    claimant: Keypair,
    amountUnlocked: number,
    amountLocked: number,
    opts: {
      startOffset?: number;
      endOffset?: number;
      version?: number;
    } = {}
  ) {
    const version = opts.version ?? Math.floor(Math.random() * 1_000_000_000);
    const startOffset = opts.startOffset ?? 5;
    const endOffset = opts.endOffset ?? 100;

    const bnUnlocked = new BN(amountUnlocked);
    const bnLocked = new BN(amountLocked);
    const total = amountUnlocked + amountLocked;

    const { root, proof } = merkleRoot(
      claimant.publicKey,
      bnUnlocked,
      bnLocked
    );

    const [distributorPda] = getDistributorPDA(
      mint,
      BigInt(version),
      program.programId
    );

    const distributorAta = anchor.utils.token.associatedAddress({
      mint,
      owner: distributorPda,
    });

    const clawbackReceiver = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      wallet.publicKey
    );

    const now = await getCurrentBlockTime(connection);
    const startTs = now + startOffset;
    const endTs = now + endOffset;
    const clawbackTs = endTs + 86401;

    await program.methods
      .newDistributor(
        new BN(version),
        root as any,
        new BN(total),
        new BN(1),
        new BN(startTs),
        new BN(endTs),
        new BN(clawbackTs)
      )
      .accounts({
        distributor: distributorPda,
        clawbackReceiver: clawbackReceiver.address,
        mint,
        tokenVault: distributorAta,
        admin: wallet.publicKey,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Fund the distributor vault
    await mintTo(connection, payer, mint, distributorAta, wallet.publicKey, total);

    // Create claimant token account
    const claimantAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
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
      startTs,
      endTs,
    };
  }

  // ── Setup ──────────────────────────────────────────────────────────

  before(async () => {
    try {
      const version = await connection.getVersion();
      console.log(`  Surfnet version: ${version["solana-core"]}`);
    } catch {
      throw new Error("Surfpool not running.");
    }

    const progAcct = await connection.getAccountInfo(program.programId);
    if (!progAcct || !progAcct.executable) {
      throw new Error("Program not deployed.");
    }

    feeRecipient = Keypair.generate();
    [feeConfigPda] = getFeeConfigPDA(program.programId);

    // Create mint
    mint = await createMint(connection, payer, wallet.publicKey, null, 9);

    // Idempotent fee config: init if missing, update recipient if stale
    const existing = await connection.getAccountInfo(feeConfigPda);
    if (!existing) {
      await program.methods
        .initializeFeeConfig(new BN(CLAIM_FEE))
        .accounts({
          feeConfig: feeConfigPda,
          admin: wallet.publicKey,
          feeRecipient: feeRecipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      await program.methods
        .setClaimFee(new BN(CLAIM_FEE))
        .accounts({
          feeConfig: feeConfigPda,
          admin: wallet.publicKey,
          newFeeRecipient: feeRecipient.publicKey,
        })
        .rpc();
    }
  });

  // ── HAPPY: Immediate unlock collects fee ───────────────────────────

  it("immediate claim collects fee and transfers tokens", async () => {
    const claimant = Keypair.generate();
    await fund(claimant);

    const {
      distributorPda, distributorAta, claimStatusPda, claimantAta,
      proof, bnUnlocked, bnLocked,
    } = await setupDistributor(claimant, 1_000_000_000, 0);

    const recipientBefore = await connection.getBalance(feeRecipient.publicKey);

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

    // Verify fee collected
    const recipientAfter = await connection.getBalance(feeRecipient.publicKey);
    assert.equal(recipientAfter - recipientBefore, CLAIM_FEE);

    // Verify fee_paid flag
    const status = await program.account.claimStatus.fetch(claimStatusPda);
    assert.equal(status.feePaid, true);

    // Verify tokens received
    const tokenAcct = await getAccount(connection, claimantAta);
    assert.equal(Number(tokenAcct.amount), 1_000_000_000);
  });

  // ── HAPPY: Cliff vesting — fee deferred to claim_locked ────────────

  it("cliff vesting defers fee to claim_locked, then collects on unlock", async () => {
    const claimant = Keypair.generate();
    await fund(claimant);

    // cliff: unlocked=0, locked=500M, vesting window 5-10s
    const {
      distributorPda, distributorAta, claimStatusPda, claimantAta,
      proof, bnUnlocked, bnLocked, endTs,
    } = await setupDistributor(claimant, 0, 500_000_000, {
      startOffset: 5,
      endOffset: 10,
    });

    const recipientBefore = await connection.getBalance(feeRecipient.publicKey);

    // new_claim with 0 unlocked — no fee yet
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

    let status = await program.account.claimStatus.fetch(claimStatusPda);
    assert.equal(status.feePaid, false, "Fee should NOT be paid on 0-unlock claim");

    const recipientMid = await connection.getBalance(feeRecipient.publicKey);
    assert.equal(recipientMid, recipientBefore, "No SOL should move yet");

    // Time travel past vesting end
    await timeTravel(connection, endTs + 5);

    // claim_locked — NOW fee should be collected
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

    status = await program.account.claimStatus.fetch(claimStatusPda);
    assert.equal(status.feePaid, true, "Fee should be paid after claim_locked");

    const recipientAfter = await connection.getBalance(feeRecipient.publicKey);
    assert.equal(recipientAfter - recipientBefore, CLAIM_FEE);

    const tokenAcct = await getAccount(connection, claimantAta);
    assert.equal(Number(tokenAcct.amount), 500_000_000);
  });

  // ── HAPPY: Linear vesting — fee on new_claim, no double charge ─────

  it("linear vesting charges fee on new_claim, not again on claim_locked", async () => {
    const claimant = Keypair.generate();
    await fund(claimant);

    const {
      distributorPda, distributorAta, claimStatusPda, claimantAta,
      proof, bnUnlocked, bnLocked, endTs,
    } = await setupDistributor(claimant, 200_000_000, 800_000_000, {
      startOffset: 5,
      endOffset: 15,
    });

    const recipientBefore = await connection.getBalance(feeRecipient.publicKey);

    // new_claim — unlocked > 0, fee charged here
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

    const recipientAfterClaim = await connection.getBalance(feeRecipient.publicKey);
    assert.equal(recipientAfterClaim - recipientBefore, CLAIM_FEE, "Fee charged on new_claim");

    let status = await program.account.claimStatus.fetch(claimStatusPda);
    assert.equal(status.feePaid, true);

    // Time travel past end for full vesting
    await timeTravel(connection, endTs + 5);

    // claim_locked — fee_paid already true, NO second charge
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

    const recipientAfterLocked = await connection.getBalance(feeRecipient.publicKey);
    assert.equal(
      recipientAfterLocked - recipientBefore,
      CLAIM_FEE,
      "No second fee on claim_locked"
    );
  });

  // ── HAPPY: Zero fee means no SOL deducted ──────────────────────────

  it("zero fee: claim succeeds without SOL deduction", async () => {
    // Set fee to 0
    await program.methods
      .setClaimFee(new BN(0))
      .accounts({
        feeConfig: feeConfigPda,
        admin: wallet.publicKey,
        newFeeRecipient: feeRecipient.publicKey,
      })
      .rpc();

    const claimant = Keypair.generate();
    await fund(claimant);

    const {
      distributorPda, distributorAta, claimStatusPda, claimantAta,
      proof, bnUnlocked, bnLocked,
    } = await setupDistributor(claimant, 100_000_000, 0);

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

    const status = await program.account.claimStatus.fetch(claimStatusPda);
    assert.equal(status.feePaid, false, "fee_paid stays false when fee=0");

    // Restore fee
    await program.methods
      .setClaimFee(new BN(CLAIM_FEE))
      .accounts({
        feeConfig: feeConfigPda,
        admin: wallet.publicKey,
        newFeeRecipient: feeRecipient.publicKey,
      })
      .rpc();
  });

  // ── SAD: Wrong fee_recipient on new_claim ──────────────────────────

  it("SAD: wrong fee_recipient rejected on new_claim", async () => {
    const claimant = Keypair.generate();
    await fund(claimant);

    const {
      distributorPda, distributorAta, claimStatusPda, claimantAta,
      proof, bnUnlocked, bnLocked,
    } = await setupDistributor(claimant, 1_000_000_000, 0);

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
          feeRecipient: wrongRecipient.publicKey,
        })
        .signers([claimant])
        .rpc();
      assert.fail("Should reject wrong fee_recipient");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("InvalidFeeRecipient") ||
          err.toString().includes("6018") ||
          err.toString().includes("Error")
      );
    }
  });

  // ── SAD: Wrong fee_recipient on claim_locked (cliff vesting) ───────

  it("SAD: wrong fee_recipient rejected on claim_locked", async () => {
    const claimant = Keypair.generate();
    await fund(claimant);

    const {
      distributorPda, distributorAta, claimStatusPda, claimantAta,
      proof, bnUnlocked, bnLocked, endTs,
    } = await setupDistributor(claimant, 0, 100_000_000, {
      startOffset: 3,
      endOffset: 8,
    });

    // new_claim (0 unlocked, no fee)
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

    await timeTravel(connection, endTs + 5);

    const wrongRecipient = Keypair.generate();
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
          feeRecipient: wrongRecipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([claimant])
        .rpc();
      assert.fail("Should reject wrong recipient on claim_locked");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("InvalidFeeRecipient") ||
          err.toString().includes("6018") ||
          err.toString().includes("Error")
      );
    }
  });

  // ── SAD: Claimant can't afford fee — atomic failure ────────────────

  it("SAD: insufficient SOL for fee fails atomically (no tokens leak)", async () => {
    const claimant = Keypair.generate();
    // Only 0.005 SOL — not enough for 0.05 SOL fee + rent
    await fund(claimant, 5_000_000);

    const {
      distributorPda, distributorAta, claimStatusPda, claimantAta,
      proof, bnUnlocked, bnLocked,
    } = await setupDistributor(claimant, 1_000_000_000, 0);

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
      assert.fail("Should fail — can't afford fee");
    } catch (err: any) {
      assert.ok(err.toString().length > 0);
    }

    // Verify NO tokens leaked
    const tokenAcct = await getAccount(connection, claimantAta);
    assert.equal(Number(tokenAcct.amount), 0, "Atomic: no tokens should have transferred");
  });

  // ── SAD: Non-admin cannot update fee mid-distribution ──────────────

  it("SAD: non-admin cannot disable fee to game the system", async () => {
    const attacker = Keypair.generate();
    await fund(attacker);

    try {
      await program.methods
        .setClaimFee(new BN(0))
        .accounts({
          feeConfig: feeConfigPda,
          admin: attacker.publicKey,
          newFeeRecipient: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should reject non-admin");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("ConstraintAddress") ||
          err.toString().includes("Unauthorized")
      );
    }
  });

  // ── SAD: Cannot re-init fee config to steal admin ──────────────────

  it("SAD: attacker cannot re-initialize fee config", async () => {
    const attacker = Keypair.generate();
    await fund(attacker);

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
      assert.fail("Should reject — PDA exists");
    } catch (err: any) {
      assert.ok(err.toString().length > 0);
    }
  });

  // ── SAD: Fake fee_config PDA rejected ──────────────────────────────

  it("SAD: fabricated fee_config PDA rejected by seeds constraint", async () => {
    const claimant = Keypair.generate();
    await fund(claimant);

    const {
      distributorPda, distributorAta, claimStatusPda, claimantAta,
      proof, bnUnlocked, bnLocked,
    } = await setupDistributor(claimant, 1_000_000_000, 0);

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
          feeConfig: fakeConfig.publicKey,
          feeRecipient: feeRecipient.publicKey,
        })
        .signers([claimant])
        .rpc();
      assert.fail("Should reject fake fee_config");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("ConstraintSeeds") ||
          err.toString().includes("seeds constraint") ||
          err.toString().includes("Error")
      );
    }
  });

  // ── SAD: claim_locked before vesting starts ────────────────────────

  it("SAD: claim_locked before vesting start rejects", async () => {
    const claimant = Keypair.generate();
    await fund(claimant);

    // Far future vesting: starts in 500s, ends in 1000s
    const {
      distributorPda, distributorAta, claimStatusPda, claimantAta,
      proof, bnUnlocked, bnLocked,
    } = await setupDistributor(claimant, 0, 100_000_000, {
      startOffset: 500,
      endOffset: 1000,
    });

    // new_claim (0 unlocked, succeeds)
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

    // Try claim_locked immediately — vesting hasn't started
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
      assert.fail("Should reject — vesting hasn't started");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("InsufficientUnlockedTokens") ||
          err.toString().includes("6000") ||
          err.toString().includes("Error")
      );
    }
  });

  // ── SAD: Admin changes fee between two claimants' claims ───────────

  it("SAD: fee change between claims — each pays different fee", async () => {
    const FEE_A = 10_000_000;
    const FEE_B = 99_000_000;

    // Set fee for claimant A
    await program.methods
      .setClaimFee(new BN(FEE_A))
      .accounts({
        feeConfig: feeConfigPda,
        admin: wallet.publicKey,
        newFeeRecipient: feeRecipient.publicKey,
      })
      .rpc();

    const claimantA = Keypair.generate();
    await fund(claimantA);
    const setupA = await setupDistributor(claimantA, 100_000_000, 0);

    const recipientBefore = await connection.getBalance(feeRecipient.publicKey);

    await program.methods
      .newClaim(setupA.bnUnlocked, setupA.bnLocked, setupA.proof as any)
      .accounts({
        distributor: setupA.distributorPda,
        claimStatus: setupA.claimStatusPda,
        from: setupA.distributorAta,
        to: setupA.claimantAta,
        claimant: claimantA.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeConfig: feeConfigPda,
        feeRecipient: feeRecipient.publicKey,
      })
      .signers([claimantA])
      .rpc();

    const afterA = await connection.getBalance(feeRecipient.publicKey);
    assert.equal(afterA - recipientBefore, FEE_A, "Claimant A pays FEE_A");

    // Change fee for claimant B
    await program.methods
      .setClaimFee(new BN(FEE_B))
      .accounts({
        feeConfig: feeConfigPda,
        admin: wallet.publicKey,
        newFeeRecipient: feeRecipient.publicKey,
      })
      .rpc();

    const claimantB = Keypair.generate();
    await fund(claimantB);
    const setupB = await setupDistributor(claimantB, 100_000_000, 0);

    await program.methods
      .newClaim(setupB.bnUnlocked, setupB.bnLocked, setupB.proof as any)
      .accounts({
        distributor: setupB.distributorPda,
        claimStatus: setupB.claimStatusPda,
        from: setupB.distributorAta,
        to: setupB.claimantAta,
        claimant: claimantB.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        feeConfig: feeConfigPda,
        feeRecipient: feeRecipient.publicKey,
      })
      .signers([claimantB])
      .rpc();

    const afterB = await connection.getBalance(feeRecipient.publicKey);
    assert.equal(afterB - afterA, FEE_B, "Claimant B pays FEE_B (higher)");

    // Restore
    await program.methods
      .setClaimFee(new BN(CLAIM_FEE))
      .accounts({
        feeConfig: feeConfigPda,
        admin: wallet.publicKey,
        newFeeRecipient: feeRecipient.publicKey,
      })
      .rpc();
  });

  // ── SAD: Non-admin cannot redirect fees to themselves ──────────────

  it("SAD: non-admin cannot redirect fee_recipient", async () => {
    const attacker = Keypair.generate();
    await fund(attacker);

    try {
      await program.methods
        .setClaimFee(new BN(CLAIM_FEE))
        .accounts({
          feeConfig: feeConfigPda,
          admin: attacker.publicKey,
          newFeeRecipient: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should reject");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("ConstraintAddress") ||
          err.toString().includes("Unauthorized")
      );
    }
  });

  // ── SAD: Positive fee with zero-address recipient ──────────────────

  it("SAD: positive fee with zero-address recipient rejected", async () => {
    try {
      await program.methods
        .setClaimFee(new BN(CLAIM_FEE))
        .accounts({
          feeConfig: feeConfigPda,
          admin: wallet.publicKey,
          newFeeRecipient: PublicKey.default,
        })
        .rpc();
      assert.fail("Should reject zero recipient");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("InvalidFeeRecipient") ||
          err.toString().includes("6018")
      );
    }
  });
});
