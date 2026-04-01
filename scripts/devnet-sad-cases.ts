/**
 * Devnet sad-path demonstration.
 *
 * Each case submits a transaction that MUST fail on-chain.
 * Instructions are built with Anchor (for account resolution) then sent
 * via connection.sendTransaction with skipPreflight so they land and get
 * a real signature — verifiable on Explorer as a failed tx.
 *
 * Cases:
 *   1. Non-admin calls set_claim_fee              → Unauthorized (6005)
 *   2. Wrong fee_recipient on new_claim           → InvalidFeeRecipient (6018)
 *   3. Claimant has insufficient SOL for fee      → tx reverts atomically, no tokens move
 *   4. Re-initialize fee_config                   → account already in use
 *
 * Run:
 *   npx ts-node --transpile-only scripts/devnet-sad-cases.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
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
  getAssociatedTokenAddressSync,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("Ah7iuugan983ymZAKJAFAdvPN3My7ESkGUARrFTn3iqM");
const CLAIM_FEE_LAMPORTS = 5_000_000;
const CLAIM_AMOUNT = 1_000_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function computeLeaf(claimant: PublicKey, amountUnlocked: BN, amountLocked: BN): Buffer {
  const unlocked = Buffer.alloc(8);
  unlocked.writeBigUInt64LE(BigInt(amountUnlocked.toString()));
  const locked = Buffer.alloc(8);
  locked.writeBigUInt64LE(BigInt(amountLocked.toString()));
  const inner = createHash("sha256")
    .update(Buffer.concat([claimant.toBuffer(), unlocked, locked]))
    .digest();
  return Buffer.from(
    createHash("sha256").update(Buffer.concat([Buffer.from([0]), inner])).digest()
  );
}

function explorer(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

async function fundFromAdmin(connection: Connection, admin: Keypair, to: PublicKey, lamports: number) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: to, lamports })
  );
  await sendAndConfirmTransaction(connection, tx, [admin]);
}

/** Sends a tx expected to fail, captures the on-chain sig. */
async function sendAndExpectFailure(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[]
): Promise<{ sig: string; error: string }> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);

  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: true });

  // Wait for confirmation (the tx will be confirmed as failed)
  const result = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  const error = result.value.err
    ? JSON.stringify(result.value.err)
    : "no error — tx unexpectedly succeeded";

  return { sig, error };
}

async function setupDistributor(
  connection: Connection,
  program: Program<any>,
  admin: Keypair,
  claimant: PublicKey,
  mint: PublicKey
) {
  const version = new BN(Date.now());
  const [distributorPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("MerkleDistributor"),
      mint.toBuffer(),
      version.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID
  );

  const vaultAddress = getAssociatedTokenAddressSync(mint, distributorPDA, true);
  const adminATA = await getOrCreateAssociatedTokenAccount(connection, admin, mint, admin.publicKey);

  const amountUnlocked = new BN(CLAIM_AMOUNT);
  const amountLocked = new BN(0);
  const leaf = computeLeaf(claimant, amountUnlocked, amountLocked);

  const now = Math.floor(Date.now() / 1000);
  await program.methods
    .newDistributor(
      version,
      Array.from(leaf),
      new BN(CLAIM_AMOUNT),
      new BN(1),
      new BN(now + 3600),
      new BN(now + 86400),
      new BN(now + 86400 * 2 + 3600)
    )
    .accounts({
      distributor: distributorPDA,
      clawbackReceiver: adminATA.address,
      mint,
      tokenVault: vaultAddress,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  await mintTo(connection, admin, mint, vaultAddress, admin, CLAIM_AMOUNT);
  return { distributorPDA, vaultAddress, amountUnlocked, amountLocked };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const admin = loadKeypair(path.join(process.env.HOME!, ".config/solana/id.json"));

  const provider = new AnchorProvider(connection, new Wallet(admin), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../sdk/idl/merkle_distributor.json"), "utf-8")
  );
  const program = new Program(idl, provider) as Program<any>;

  const [feeConfigPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("FeeConfig")],
    PROGRAM_ID
  );

  console.log("\n=== devnet sad-path cases ===");
  console.log("program:", PROGRAM_ID.toBase58());
  console.log("admin:  ", admin.publicKey.toBase58());

  const results: { case: string; expected: string; sig: string; error: string }[] = [];

  // ── Case 1: non-admin calls set_claim_fee ─────────────────────────────────

  console.log("\n[1] non-admin calls set_claim_fee...");
  const impostor = Keypair.generate();
  await fundFromAdmin(connection, admin, impostor.publicKey, 0.01 * LAMPORTS_PER_SOL);

  // Build instruction via admin's program, but swap in impostor as the admin account
  const ix1 = await program.methods
    .setClaimFee(new BN(1))
    .accounts({
      feeConfig: feeConfigPDA,
      admin: impostor.publicKey,       // ← impostor pretending to be admin
      newFeeRecipient: impostor.publicKey,
    })
    .instruction();

  const r1 = await sendAndExpectFailure(connection, new Transaction().add(ix1), [impostor]);
  results.push({ case: "non-admin calls set_claim_fee", expected: "Unauthorized (6005)", ...r1 });
  console.log("  on-chain error:", r1.error);
  console.log("  explorer:      ", explorer(r1.sig));

  // ── Case 2: wrong fee_recipient on new_claim ──────────────────────────────

  console.log("\n[2] wrong fee_recipient on new_claim...");
  const mint2 = await createMint(connection, admin, admin.publicKey, null, 6);
  const claimant2 = Keypair.generate();
  await fundFromAdmin(connection, admin, claimant2.publicKey, 0.05 * LAMPORTS_PER_SOL);

  const { distributorPDA: dist2, vaultAddress: vault2, amountUnlocked: au2, amountLocked: al2 } =
    await setupDistributor(connection, program, admin, claimant2.publicKey, mint2);

  const claimant2ATA = await getOrCreateAssociatedTokenAccount(
    connection, admin, mint2, claimant2.publicKey
  );
  const [claimStatus2] = PublicKey.findProgramAddressSync(
    [Buffer.from("ClaimStatus"), claimant2.publicKey.toBuffer(), dist2.toBuffer()],
    PROGRAM_ID
  );

  const wrongRecipient = Keypair.generate().publicKey;

  const ix2 = await program.methods
    .newClaim(au2, al2, [])
    .accounts({
      distributor: dist2,
      claimStatus: claimStatus2,
      from: vault2,
      to: claimant2ATA.address,
      claimant: claimant2.publicKey,
      mint: mint2,
      feeConfig: feeConfigPDA,
      feeRecipient: wrongRecipient,     // ← wrong: not fee_config.fee_recipient
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const r2 = await sendAndExpectFailure(
    connection,
    new Transaction().add(ix2),
    [claimant2]
  );
  results.push({ case: "wrong fee_recipient on new_claim", expected: "InvalidFeeRecipient (6018)", ...r2 });
  console.log("  on-chain error:", r2.error);
  console.log("  explorer:      ", explorer(r2.sig));

  // Verify no tokens leaked
  const bal2 = await connection.getTokenAccountBalance(claimant2ATA.address);
  console.log("  tokens in claimant ATA after failed claim:", bal2.value.amount, "(must be 0)");

  // ── Case 3: insufficient SOL for fee — atomic revert, no token leak ────────

  console.log("\n[3] claimant has insufficient SOL (fee > balance)...");
  const mint3 = await createMint(connection, admin, admin.publicKey, null, 6);
  const brokeClaimant = Keypair.generate();
  // Fund just enough for tx fee, not the 5_000_000 lamport claim fee
  await fundFromAdmin(connection, admin, brokeClaimant.publicKey, 0.002 * LAMPORTS_PER_SOL);

  const { distributorPDA: dist3, vaultAddress: vault3, amountUnlocked: au3, amountLocked: al3 } =
    await setupDistributor(connection, program, admin, brokeClaimant.publicKey, mint3);

  const brokeATA = await getOrCreateAssociatedTokenAccount(
    connection, admin, mint3, brokeClaimant.publicKey
  );
  const [claimStatus3] = PublicKey.findProgramAddressSync(
    [Buffer.from("ClaimStatus"), brokeClaimant.publicKey.toBuffer(), dist3.toBuffer()],
    PROGRAM_ID
  );

  const ix3 = await program.methods
    .newClaim(au3, al3, [])
    .accounts({
      distributor: dist3,
      claimStatus: claimStatus3,
      from: vault3,
      to: brokeATA.address,
      claimant: brokeClaimant.publicKey,
      mint: mint3,
      feeConfig: feeConfigPDA,
      feeRecipient: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const r3 = await sendAndExpectFailure(
    connection,
    new Transaction().add(ix3),
    [brokeClaimant]
  );

  const bal3 = await connection.getTokenAccountBalance(brokeATA.address);
  results.push({ case: "insufficient SOL — tx reverts, no token leak", expected: "insufficient lamports", ...r3 });
  console.log("  on-chain error:", r3.error);
  console.log("  tokens in claimant ATA after failed claim:", bal3.value.amount, "(must be 0)");
  console.log("  explorer:      ", explorer(r3.sig));

  // ── Case 4: re-initialize fee_config ──────────────────────────────────────

  console.log("\n[4] re-initialize fee_config (already exists)...");
  const ix4 = await program.methods
    .initializeFeeConfig(new BN(999))
    .accounts({
      feeConfig: feeConfigPDA,
      admin: admin.publicKey,
      feeRecipient: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const r4 = await sendAndExpectFailure(
    connection,
    new Transaction().add(ix4),
    [admin]
  );
  results.push({ case: "re-initialize fee_config", expected: "account already in use", ...r4 });
  console.log("  on-chain error:", r4.error);
  console.log("  explorer:      ", explorer(r4.sig));

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n=== sad path summary ===");
  for (const r of results) {
    console.log(`\n  ${r.case}`);
    console.log(`  expected: ${r.expected}`);
    console.log(`  error:    ${r.error}`);
    console.log(`  sig:      ${r.sig}`);
  }

  console.log("\n=== README block ===");
  for (const r of results) {
    console.log(`${r.case}: ${r.sig}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
