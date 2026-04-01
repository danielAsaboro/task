/**
 * Devnet end-to-end demonstration:
 *   1. Initialize the global FeeConfig PDA (5_000_000 lamports / ~0.005 SOL per claim)
 *   2. Create a MerkleDistributor with a single-leaf tree (immediate unlock)
 *   3. Fund the distributor vault
 *   4. Claimant calls new_claim — SOL fee deducted, tokens transferred
 *   5. Print all signatures + final balances
 *
 * Run:
 *   npx ts-node scripts/devnet-e2e.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ── Config ───────────────────────────────────────────────────────────────────

const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("Ah7iuugan983ymZAKJAFAdvPN3My7ESkGUARrFTn3iqM");
const CLAIM_FEE_LAMPORTS = 5_000_000; // 0.005 SOL
const CLAIM_AMOUNT = 1_000_000; // 1 token (6 decimals)

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// Replicates the program's hashv (SHA256 of concatenation) exactly.
// leaf = SHA256(0x00 || SHA256(claimant || unlocked_le8 || locked_le8))
// For a single-leaf tree with empty proof, root == leaf.
function computeLeaf(
  claimant: PublicKey,
  amountUnlocked: BN,
  amountLocked: BN
): Buffer {
  const unlocked = Buffer.alloc(8);
  unlocked.writeBigUInt64LE(BigInt(amountUnlocked.toString()));
  const locked = Buffer.alloc(8);
  locked.writeBigUInt64LE(BigInt(amountLocked.toString()));

  const inner = createHash("sha256")
    .update(Buffer.concat([claimant.toBuffer(), unlocked, locked]))
    .digest();

  return Buffer.from(
    createHash("sha256")
      .update(Buffer.concat([Buffer.from([0]), inner]))
      .digest()
  );
}

async function fundFromAdmin(
  connection: Connection,
  admin: Keypair,
  to: PublicKey,
  lamports: number
) {
  console.log(`  funding ${to.toBase58().slice(0, 8)}... with ${lamports / LAMPORTS_PER_SOL} SOL from admin`);
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: to, lamports })
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [admin]);
  console.log(`  funded:`, explorer(sig));
}

function explorer(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const connection = new Connection(RPC, "confirmed");

  // Admin / fee recipient = deployer wallet
  const admin = loadKeypair(
    path.join(process.env.HOME!, ".config/solana/id.json")
  );
  // Claimant = fresh keypair
  const claimant = Keypair.generate();

  console.log("\n=== devnet e2e ===");
  console.log("program:  ", PROGRAM_ID.toBase58());
  console.log("admin:    ", admin.publicKey.toBase58());
  console.log("claimant: ", claimant.publicKey.toBase58());

  await fundFromAdmin(connection, admin, claimant.publicKey, 0.05 * LAMPORTS_PER_SOL);

  // Load program via Anchor
  const provider = new AnchorProvider(
    connection,
    new Wallet(admin),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../sdk/idl/merkle_distributor.json"),
      "utf-8"
    )
  );
  const program = new Program(idl, provider) as Program<any>;

  // ── 1. FeeConfig ─────────────────────────────────────────────────────────

  const [feeConfigPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("FeeConfig")],
    PROGRAM_ID
  );

  let initFeeSig: string | null = null;
  const existing = await connection.getAccountInfo(feeConfigPDA);
  if (!existing) {
    console.log("\n[1] initializing fee config...");
    initFeeSig = await program.methods
      .initializeFeeConfig(new BN(CLAIM_FEE_LAMPORTS))
      .accounts({
        feeConfig: feeConfigPDA,
        admin: admin.publicKey,
        feeRecipient: admin.publicKey, // treasury = admin for this demo
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("    sig:", explorer(initFeeSig));
  } else {
    console.log("\n[1] fee config already exists, skipping init");
  }

  // ── 2. Mint + distributor ─────────────────────────────────────────────────

  console.log("\n[2] creating mint...");
  const mint = await createMint(
    connection,
    admin,
    admin.publicKey,
    null,
    6
  );
  console.log("    mint:", mint.toBase58());

  const version = new BN(Date.now()); // unique per run
  const [distributorPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("MerkleDistributor"),
      mint.toBuffer(),
      version.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID
  );

  // clawback_receiver needs to be a token account owned by admin
  const adminATA = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    mint,
    admin.publicKey
  );

  // vault is created by new_distributor via init — just derive the address
  const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
  const vaultAddress = getAssociatedTokenAddressSync(mint, distributorPDA, true);

  const amountUnlocked = new BN(CLAIM_AMOUNT);
  const amountLocked = new BN(0);
  // For single-leaf tree with empty proof, root == leaf (verify() returns leaf == root)
  const leaf = computeLeaf(claimant.publicKey, amountUnlocked, amountLocked);
  const root = leaf; // single-leaf: proof is empty, so computed_hash == leaf must == root
  const proof: number[][] = [];

  const now = Math.floor(Date.now() / 1000);

  console.log("\n[3] creating distributor...");
  const newDistSig = await program.methods
    .newDistributor(
      version,
      Array.from(root),
      new BN(CLAIM_AMOUNT),
      new BN(1),
      new BN(now + 3600),          // start_vesting: 1h from now (must be future)
      new BN(now + 86400),         // end_vesting: 1 day
      new BN(now + 86400 * 2 + 3600) // clawback: >= end + 1 day
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
  console.log("    sig:", explorer(newDistSig));

  // ── 3. Fund vault ─────────────────────────────────────────────────────────

  console.log("\n[4] funding vault with", CLAIM_AMOUNT, "tokens...");
  await mintTo(connection, admin, mint, vaultAddress, admin, CLAIM_AMOUNT);

  // ── 4. Claim ──────────────────────────────────────────────────────────────

  const claimantATA = await getOrCreateAssociatedTokenAccount(
    connection,
    admin, // admin pays ATA creation
    mint,
    claimant.publicKey
  );

  const [claimStatusPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("ClaimStatus"),
      claimant.publicKey.toBuffer(),
      distributorPDA.toBuffer(),
    ],
    PROGRAM_ID
  );

  const feeRecipientBalBefore = await connection.getBalance(admin.publicKey);
  const claimantBalBefore = await connection.getBalance(claimant.publicKey);

  console.log("\n[5] claiming (fee:", CLAIM_FEE_LAMPORTS / LAMPORTS_PER_SOL, "SOL)...");

  // Claimant signs; admin pays for claimStatus account init
  const claimSig = await program.methods
    .newClaim(amountUnlocked, amountLocked, proof)
    .accounts({
      distributor: distributorPDA,
      claimStatus: claimStatusPDA,
      from: vaultAddress,
      to: claimantATA.address,
      claimant: claimant.publicKey,
      mint,
      feeConfig: feeConfigPDA,
      feeRecipient: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([claimant])
    .rpc();
  console.log("    sig:", explorer(claimSig));

  // ── 5. Verify ─────────────────────────────────────────────────────────────

  const tokenAcct = await getAccount(connection, claimantATA.address);
  const feeRecipientBalAfter = await connection.getBalance(admin.publicKey);
  const claimantBalAfter = await connection.getBalance(claimant.publicKey);

  const feeReceived = feeRecipientBalAfter - feeRecipientBalBefore;
  const claimantSpent = claimantBalBefore - claimantBalAfter;

  console.log("\n=== results ===");
  console.log("tokens received:       ", tokenAcct.amount.toString(), "(expected", CLAIM_AMOUNT, ")");
  console.log("fee deducted (claimant):", claimantSpent, "lamports");
  console.log("fee received (admin):   ", feeReceived, "lamports (expected ~", CLAIM_FEE_LAMPORTS, ")");

  console.log("\n=== transaction signatures ===");
  if (initFeeSig) console.log("initialize_fee_config: ", explorer(initFeeSig));
  console.log("new_distributor:       ", explorer(newDistSig));
  console.log("new_claim:             ", explorer(claimSig));

  // Emit structured output for README
  console.log("\n=== README block ===");
  console.log(`program:              Ah7iuugan983ymZAKJAFAdvPN3My7ESkGUARrFTn3iqM`);
  if (initFeeSig) console.log(`initialize_fee_config: ${initFeeSig}`);
  console.log(`new_distributor:      ${newDistSig}`);
  console.log(`new_claim:            ${claimSig}`);
  console.log(`fee config PDA:       ${feeConfigPDA.toBase58()}`);
  console.log(`distributor PDA:      ${distributorPDA.toBase58()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
