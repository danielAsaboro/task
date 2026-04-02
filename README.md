# merkle-distributor-fee-task

Jito's Merkle Distributor, extended with on-chain admin-controlled claim fees. Built as a technical evaluation for [Fractals Finance](https://fractals.finance) — a B2B DePIN distribution platform running [sync.fractals.fun](https://sync.fractals.fun).

**The problem it solves:** Fractals collects a flat claim fee today, gated by merkle proof distribution — users only receive their proof after paying. This moves fee enforcement on-chain as a protocol-level guarantee, so fee collection doesn't depend solely on the application layer.

---

## What's added over base Jito

Three new instructions and a global `FeeConfig` PDA:

| Instruction | Who | What |
|---|---|---|
| `initialize_fee_config` | Fee admin (once) | Creates the global PDA, sets initial fee + recipient |
| `set_claim_fee` | Fee admin | Updates fee amount and/or recipient atomically |
| `set_fee_admin` | Fee admin | Transfers admin authority to a new account |

A `MAX_CLAIM_FEE` cap of 1 SOL (1,000,000,000 lamports) is enforced on both `initialize_fee_config` and `set_claim_fee` to prevent accidental or malicious fee values.

`new_claim` and `claim_locked` now pull the `FeeConfig` and transfer SOL before touching tokens. Fee is collected once per claimant per distributor — tracked by a `fee_paid: bool` field added to `ClaimStatus`. Cliff-vesting claims (where `new_claim` transfers 0 tokens) defer the fee to the first `claim_locked` call.

**Why SOL, not a token:** flat lamports, no oracle, no ATA creation per claimant, insufficient funds revert the entire tx atomically.

---

## Program ID

```
Ah7iuugan983ymZAKJAFAdvPN3My7ESkGUARrFTn3iqM
```

Deployed on **devnet**. [View on Explorer](https://explorer.solana.com/address/Ah7iuugan983ymZAKJAFAdvPN3My7ESkGUARrFTn3iqM?cluster=devnet)

---

## Live devnet transactions

End-to-end run on devnet — fee config initialized, distributor created, claim executed with 0.005 SOL fee collected on-chain, admin transferred and restored.

| Step | Transaction |
|---|---|
| `initialize_fee_config` (5_000_000 lamports) | [`48t9mzs4...`](https://explorer.solana.com/tx/48t9mzs4mAw1uZep35QioChuph6GkzAeMQi4M5CaQjdczgrqJE4J669bSmGuAHco78kgExssFT92ppPhio4uMsyF?cluster=devnet) |
| `new_distributor` | [`217jDv1s...`](https://explorer.solana.com/tx/217jDv1sHFdbineaSoQd5pyB4qyCHwbAXfYg6qrorsnekZg1FEFHtqdxwbrSL2VenFWQeXhX2Z6szdhYiDZH82dZ?cluster=devnet) |
| `new_claim` (1 token, fee deducted) | [`3VvAbFB6...`](https://explorer.solana.com/tx/3VvAbFB6exJ1rV9wdKmXqKznrmvQFEVApLAR2DWhd5buALRZowEroPHiFSk46TwMQxquh5naYMNK1vwEwjjMLf4E?cluster=devnet) |
| `set_fee_admin` (A → B) | [`63zmKcWu...`](https://explorer.solana.com/tx/63zmKcWug15RzVcsphkdDoYXZTCybRzwEdqJAiuWNbr9Qwo5rzUxgZq9b9saTwPuq7PZCSkhShYnDpSxb7cHn8Rv?cluster=devnet) |
| `set_claim_fee` (by new admin B) | [`4HVr2HWo...`](https://explorer.solana.com/tx/4HVr2HWofFQbJWKQuXCaPNEvRNpvgw9SnGuwp42NJZBQWnCurx7pjMFMgjMNoAzVxMQuJRDaowZKakUapYi1go3j?cluster=devnet) |
| `set_fee_admin` (B → A, restored) | [`529LqSdx...`](https://explorer.solana.com/tx/529LqSdxsP8S19bUR6xrb6QqcKuRfPV3z6J3QTgwuTuYgQH1jcq6JtcQUxVGkmj28bwVHv8vDF4rNvRHJxGCanw5?cluster=devnet) |

**Accounts:**
- FeeConfig PDA: `BZA3y7r5EyzEsZ8FfhkCNmEiRKCu2PBGVpg46Q9BUYD2`

The `new_claim` tx shows 5,000,000 lamports transferred from claimant → fee recipient before the token transfer. The claim is atomic — if SOL transfer fails, no tokens move. The `set_fee_admin` txs demonstrate admin authority transfer and restoration.

```bash
npx ts-node --transpile-only scripts/devnet-e2e.ts
```

### Sad path transactions

Each submitted with `skipPreflight: true` — these landed on-chain as confirmed failures, proving constraints hold at the program level, not just in simulation.

| Case | On-chain error | Transaction |
|---|---|---|
| Non-admin calls `set_claim_fee` | `Custom:6005` (Unauthorized) | [`2bodMzTT...`](https://explorer.solana.com/tx/2bodMzTTDVSqSd7gt3xpZ5fG3BWori8pbzytJPyhyEW3Ptx52UQeBAS8qWjNfbyMQUt6dJoCAf9bRisFr61tNSnS?cluster=devnet) |
| Wrong `fee_recipient` on `new_claim` | `Custom:6018` (InvalidFeeRecipient) | [`5pYY3Ecp...`](https://explorer.solana.com/tx/5pYY3EcpcYurmkUrdzz595xEvz9RRjSihQvx8DGzunjSV8E4auH2md9q5EsjEzsCfDcvFYrquqwLJYjkXFjLTsY2?cluster=devnet) |
| Claimant has insufficient SOL for fee | `Custom:1` — 0 tokens moved to claimant | [`5SAD8aTw...`](https://explorer.solana.com/tx/5SAD8aTwD4dxoDUobyb58KJj66qR8X8QrXNWPYH8rvNs3MFBSvQ5FrhEWSHZhxaVFjGiXrRosyit1yucnhZDKbt?cluster=devnet) |
| Re-initialize `fee_config` | `Custom:0` (account already in use) | [`4MKtzJE5...`](https://explorer.solana.com/tx/4MKtzJE5mwsCz7WcU4Gzc24Gif8TRyoVzNDwT8G1Z4aSmcuNEX6C8UMHA7HRtg16LZLWZZYkB84qCAkeFYMqjm13?cluster=devnet) |
| Non-admin calls `set_fee_admin` | `Custom:6005` (Unauthorized) | [`5SNb8uW6...`](https://explorer.solana.com/tx/5SNb8uW6Xmj1W91EHKNQNNtSCwZLbqJXQRDWJP6TiExurbfxVfjuAhci1TnhMvNxiVcG7L5MTuj6UNHzyTTYoGEN?cluster=devnet) |
| Admin transfers to self | `Custom:6019` (SameFeeAdmin) | [`542PTmBe...`](https://explorer.solana.com/tx/542PTmBeiv5q4jNE9U1PpJwvZ1hLWycwURaANJTWNJPzrbqXAogrUji7qUDFmrExVdBrfS96GiQkFqrosxKV7458?cluster=devnet) |
| Fee exceeds MAX_CLAIM_FEE (1 SOL + 1) | `Custom:6020` (FeeExceedsMaximum) | [`sRPHP5UJ...`](https://explorer.solana.com/tx/sRPHP5UJQTboyh1Hv94Z9C1GiZHYV3zDiMSN5KocKx33JYSzXFEhE2w5WHstwo5i9rYfaAEcrQ2hhJpeQJzQ7KE?cluster=devnet) |

The insufficient-SOL case is the most important atomicity proof — vault had tokens, but claimant ATA balance stayed 0 because the fee CPI failed first.

```bash
npx ts-node --transpile-only scripts/devnet-sad-cases.ts
```

---

## Repo layout

```
programs/merkle-distributor-fee-task/   Anchor program
  src/
    instructions/
      initialize_fee_config.rs          new — bootstrap fee config PDA
      set_claim_fee.rs                  new — admin update path
      set_fee_admin.rs                  new — transfer admin authority
      new_claim.rs                      modified — fee collection wired in
      claim_locked.rs                   modified — deferred fee for cliff vesting
      new_distributor.rs                unchanged from Jito
      clawback.rs / set_admin.rs / ...  unchanged from Jito
    state/
      fee_config.rs                     new — FeeConfig account (81 bytes)
      claim_status.rs                   extended — added fee_paid: bool
      merkle_distributor.rs             unchanged
sdk/                                    TypeScript SDK
  src/
    distributor.ts                      MerkleDistributor class
    types.ts                            account + instruction types
    utils.ts                            PDA helpers, validation
  idl/                                  generated IDL
merkle-tree/                            off-chain Merkle tree builder (Rust)
cli/                                    CLI for tree generation and claims
verify/                                 standalone Merkle proof verifier crate
tests/
  merkle-distributor-fee-task.ts        fee config integration tests
  claim-fee-negative.ts                 sad path / auth tests
  sdk-cli-e2e.ts                        SDK end-to-end
  surfpool-e2e.ts                       time-travel vesting tests
  litesvm/                              Rust tests against compiled .so (no validator)
```

---

## Build

```bash
# Prerequisites: Rust, Solana CLI, Anchor CLI, Node 18+, Yarn

anchor build          # compiles program, generates IDL + types
cd sdk && npm run build   # compiles TypeScript SDK
```

---

## Deploy

### With txtx (recommended)

[txtx](https://txtx.sh) manages the deploy transaction — reads your local keypair and outputs the deployed program ID.

```bash
# localnet (starts a local validator first)
solana-test-validator &
txtx run deployment --network-id localnet
```

The `txtx.yml` at the root wires the `deployment` runbook in `runbooks/deployment.tx` to your local Solana keypair (`~/.config/solana/id.json`).

### With Anchor directly

```bash
anchor deploy
```

---

## Initialize fee config (post-deploy, one-time)

After deployment the fee config PDA doesn't exist yet. Call `initialize_fee_config` once:

```typescript
import { MerkleDistributor } from './sdk/src';

const sdk = new MerkleDistributor(connection, wallet, programId);

await sdk.initializeFeeConfig({
  admin: wallet.publicKey,
  claimFee: 5_000_000n,          // 0.005 SOL in lamports
  feeRecipient: treasuryWallet,
});
```

Set `claimFee: 0n` to deploy with fees disabled — you can enable them later with `setClaimFee`.

---

## Update fee (admin only)

```typescript
await sdk.setClaimFee({
  admin: wallet.publicKey,
  claimFee: 10_000_000n,         // bump to 0.01 SOL
  feeRecipient: newTreasury,
});
```

Fee amount and recipient update atomically. The admin field is NOT changed by `set_claim_fee`.

---

## Transfer fee admin

```typescript
await sdk.setFeeAdmin({
  admin: currentAdmin.publicKey,
  newAdmin: newAdminPubkey,
});
```

Only the current admin can transfer authority. The new admin immediately gains full control over `set_claim_fee` and `set_fee_admin`. The old admin is locked out. Fee and recipient values are preserved during transfer.

---

## Claiming (SDK handles fees transparently)

```typescript
// SDK fetches FeeConfig in parallel, passes fee accounts automatically
// Callers don't need to know about FeeConfig

await sdk.claim({ ... });        // new_claim — fee charged if tokens transfer
await sdk.claimLocked({ ... });  // claim_locked — deferred fee for cliff vesting
```

---

## Read fee config

```typescript
const feeConfig = await sdk.getFeeConfig();
console.log(feeConfig.claimFee.toString());     // lamports
console.log(feeConfig.feeRecipient.toBase58());

// Or derive the PDA without fetching
const [pda, bump] = sdk.getFeeConfigPDA();
```

---

## Test

```bash
# Anchor integration tests (spins up local validator)
anchor test

# SDK unit tests
cd sdk && npm test

# LiteSVM Rust tests (no validator, fast)
cd tests/litesvm && cargo test

# Surfpool time-travel tests (vesting scenarios)
# requires surfpool CLI installed
anchor test --skip-build -- --grep "surfpool"
```

---

## Verify crate

`verify/` is a standalone Rust crate that exposes the Merkle proof verification logic independently of Anchor. Direct port of OpenZeppelin's `MerkleProof.sol` using `solana_program::hash::hashv`.

```rust
use jito_merkle_verify::verify;

let valid = verify(proof, root, leaf);
```

Useful for off-chain tooling, indexers, or any context where you need proof verification without pulling in the full program.

---

## Fee collection flow

```
FeeConfig (global singleton)
  claim_fee: 5_000_000 lamports
  fee_recipient: <treasury>

new_claim(amount_unlocked > 0)   → fee charged, fee_paid = true
new_claim(amount_unlocked = 0)   → cliff vesting, fee deferred, fee_paid = false
  └─ claim_locked (first call)   → fee charged, fee_paid = true
     claim_locked (subsequent)   → fee_paid already true, skipped

One fee per claimant per distributor, always before token transfer.
If claimant can't pay → entire tx reverts, no tokens move.
```

---

## Security notes

- `initialize_fee_config` uses Anchor `init` — can only be called once, re-initialization is impossible
- **Deployment note**: `initialize_fee_config` accepts any `Signer` as the first admin (first-caller-wins). Deploy and initialize should happen in the same transaction (or via multisig/governance) to prevent frontrunning by an attacker who calls `initialize_fee_config` before the legitimate admin.
- `set_claim_fee` and `set_fee_admin` enforce `address = fee_config.admin` — non-admin txs fail at constraint validation
- `set_fee_admin` allows admin key rotation — if the admin key is compromised, authority can be transferred to a new key
- `fee_recipient` is validated at runtime (`require!`) rather than as an Anchor constraint — Anchor constraints can't express conditional validation (`if fee > 0, then validate`)
- PDA seeds `["FeeConfig"]` are program-derived — a fabricated account passed in the wrong position will fail Anchor's seeds check
- `MAX_CLAIM_FEE` of 1 SOL caps the fee to prevent accidental or malicious values. Both `initialize_fee_config` and `set_claim_fee` enforce this limit.
- All fee state changes emit events (`FeeConfigInitializedEvent`, `FeeConfigUpdatedEvent`, `FeeAdminUpdatedEvent`, `FeeCollectedEvent`) for indexing and observability.
