use solana_program::hash::hashv;

/// Verifies a Merkle proof against a root and leaf.
/// Direct port of OpenZeppelin's MerkleProof.sol.
pub fn verify(proof: Vec<[u8; 32]>, root: [u8; 32], leaf: [u8; 32]) -> bool {
    let mut computed_hash = leaf;
    for proof_element in proof.into_iter() {
        if computed_hash <= proof_element {
            computed_hash =
                hashv(&[&[1u8], computed_hash.as_ref(), proof_element.as_ref()]).to_bytes();
        } else {
            computed_hash =
                hashv(&[&[1u8], proof_element.as_ref(), computed_hash.as_ref()]).to_bytes();
        }
    }
    computed_hash == root
}
