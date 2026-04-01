# merkle-distributor-fee-task

Jito's Merkle Distributor, extended with on-chain admin-controlled claim fees. Built as a technical evaluation for [Fractals Finance](https://fractals.finance) — a B2B DePIN distribution platform running [sync.fractals.fun](https://sync.fractals.fun).

**The problem it solves:** Fractals collects a $0.50/claim fee at the app layer today. Anyone calling the program directly bypasses it. This moves fee enforcement on-chain — trustless, impossible to bypass.

---

## What's added over base Jito

Two new instructions and a global `FeeConfig` PDA:

| Instruction | Who | What |
|---|---|---|
| `initialize_fee_config` | Fee admin (once) | Creates the global PDA, sets initial fee + recipient |
| `set_claim_fee` | Fee admin | Updates fee amount and/or recipient atomically |

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

End-to-end run on devnet — fee config initialized, distributor created, claim executed with 0.005 SOL fee collected on-chain.

| Step | Transaction |
|---|---|
| `initialize_fee_config` (5_000_000 lamports) | [`48t9mzs4...`](https://explorer.solana.com/tx/48t9mzs4mAw1uZep35QioChuph6GkzAeMQi4M5CaQjdczgrqJE4J669bSmGuAHco78kgExssFT92ppPhio4uMsyF?cluster=devnet) |
| `new_distributor` | [`v86LVhcg...`](https://explorer.solana.com/tx/v86LVhcgzykuADGfoBfFUgfG15UGZzXvS7GCTnBtngzD573xfRZHrDfdKSLPGYdKbAb1tUTW8Kzu1GiPNJrP1pA?cluster=devnet) |
| `new_claim` (1 token, fee deducted) | [`2U5Fkb9N...`](https://explorer.solana.com/tx/2U5Fkb9NtXkvcyKk46CwiuKSwpne3WH4yivpPykBd3V3vjBmrmMFZQVEMzDjwyxqaZpDWScXm7ShJc8Buuk4oGS5?cluster=devnet) |

**Accounts:**
- FeeConfig PDA: `BZA3y7r5EyzEsZ8FfhkCNmEiRKCu2PBGVpg46Q9BUYD2`
- Distributor PDA: `JBgWRT1jbKAEZByMLdgCqB58B2ckZS2cc3RpHgq6DDBN`

The `new_claim` tx shows 5,000,000 lamports transferred from claimant → fee recipient before the token transfer. The claim is atomic — if SOL transfer fails, no tokens move.

To run it yourself:
```bash
npx ts-node --transpile-only scripts/devnet-e2e.ts
```

---

## Repo layout

```
programs/merkle-distributor-fee-task/   Anchor program
  src/
    instructions/
      initialize_fee_config.rs          new — bootstrap fee config PDA
      set_claim_fee.rs                  new — admin update path
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

Fee amount and recipient update atomically. The admin field is immutable via `set_claim_fee` — it can only be set at initialization.

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
- `set_claim_fee` enforces `address = fee_config.admin` — non-admin txs fail at constraint validation
- `fee_recipient` is validated at runtime (`require!`) rather than as an Anchor constraint — Anchor constraints can't express conditional validation (`if fee > 0, then validate`)
- PDA seeds `["FeeConfig"]` are program-derived — a fabricated account passed in the wrong position will fail Anchor's seeds check
- Fee set to `u64::MAX` is accepted by the program (admin is trusted). A `MAX_CLAIM_FEE` cap is a noted Phase 2 addition.
