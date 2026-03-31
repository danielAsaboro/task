use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufReader, Write},
    path::PathBuf,
    result,
};

use indexmap::IndexMap;
use jito_merkle_verify::verify;
use serde::{Deserialize, Serialize};
use solana_program::{hash::hashv, pubkey::Pubkey};

use crate::{
    csv_entry::CsvEntry,
    error::{MerkleTreeError, MerkleTreeError::MerkleValidationError},
    merkle_tree::MerkleTree,
    tree_node::TreeNode,
    utils::{get_max_total_claim, get_proof},
};

const LEAF_PREFIX: &[u8] = &[0];

/// Merkle Tree which will be used to distribute tokens to claimants.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AirdropMerkleTree {
    pub merkle_root: [u8; 32],
    pub max_num_nodes: u64,
    pub max_total_claim: u64,
    pub tree_nodes: Vec<TreeNode>,
}

pub type Result<T> = result::Result<T, MerkleTreeError>;

impl AirdropMerkleTree {
    pub fn new(tree_nodes: Vec<TreeNode>) -> Result<Self> {
        // Combine tree nodes with the same claimant, while retaining original order
        let mut tree_nodes_map: IndexMap<Pubkey, TreeNode> = IndexMap::new();
        for tree_node in tree_nodes {
            let claimant = tree_node.claimant;
            tree_nodes_map
                .entry(claimant)
                .and_modify(|n| {
                    println!("duplicate claimant {} found, combining", n.claimant);
                    n.total_unlocked_staker = n
                        .total_unlocked_staker
                        .checked_add(tree_node.total_unlocked_staker)
                        .unwrap();
                    n.total_locked_staker = n
                        .total_locked_staker
                        .checked_add(tree_node.total_locked_staker)
                        .unwrap();
                    n.total_unlocked_searcher = n
                        .total_unlocked_searcher
                        .checked_add(tree_node.total_unlocked_searcher)
                        .unwrap();
                    n.total_locked_searcher = n
                        .total_locked_searcher
                        .checked_add(tree_node.total_locked_searcher)
                        .unwrap();
                    n.total_unlocked_validator = n
                        .total_unlocked_validator
                        .checked_add(tree_node.total_unlocked_validator)
                        .unwrap();
                    n.total_locked_validator = n
                        .total_locked_validator
                        .checked_add(tree_node.total_locked_validator)
                        .unwrap();
                })
                .or_insert_with(|| tree_node);
        }

        let mut tree_nodes: Vec<TreeNode> = tree_nodes_map.values().cloned().collect();

        let hashed_nodes = tree_nodes
            .iter()
            .map(|claim_info| claim_info.hash().to_bytes())
            .collect::<Vec<_>>();

        let tree = MerkleTree::new(&hashed_nodes[..], true);

        for (i, tree_node) in tree_nodes.iter_mut().enumerate() {
            tree_node.proof = Some(get_proof(&tree, i));
        }

        let max_total_claim = get_max_total_claim(tree_nodes.as_ref());
        let tree = AirdropMerkleTree {
            merkle_root: tree
                .get_root()
                .ok_or(MerkleTreeError::MerkleRootError)?
                .to_bytes(),
            max_num_nodes: tree_nodes.len() as u64,
            max_total_claim,
            tree_nodes,
        };

        println!(
            "created merkle tree with {} nodes and max total claim of {}",
            tree.max_num_nodes, tree.max_total_claim
        );
        tree.validate()?;
        Ok(tree)
    }

    pub fn new_from_csv(path: &PathBuf) -> Result<Self> {
        let csv_entries = CsvEntry::new_from_file(path)?;
        let tree_nodes: Vec<TreeNode> = csv_entries.into_iter().map(TreeNode::from).collect();
        let tree = Self::new(tree_nodes)?;
        Ok(tree)
    }

    pub fn new_from_file(path: &PathBuf) -> Result<Self> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        let tree: AirdropMerkleTree = serde_json::from_reader(reader)?;
        Ok(tree)
    }

    pub fn write_to_file(&self, path: &PathBuf) {
        let serialized = serde_json::to_string_pretty(&self).unwrap();
        let mut file = File::create(path).unwrap();
        file.write_all(serialized.as_bytes()).unwrap();
    }

    pub fn get_node(&self, claimant: &Pubkey) -> TreeNode {
        for i in self.tree_nodes.iter() {
            if i.claimant == *claimant {
                return i.clone();
            }
        }
        panic!("Claimant not found in tree");
    }

    fn validate(&self) -> Result<()> {
        if self.max_num_nodes > 2u64.pow(32) - 1 {
            return Err(MerkleValidationError(format!(
                "Max num nodes {} is greater than 2^32 - 1",
                self.max_num_nodes
            )));
        }

        if self.tree_nodes.len() != self.max_num_nodes as usize {
            return Err(MerkleValidationError(format!(
                "Tree nodes length {} does not match max_num_nodes {}",
                self.tree_nodes.len(),
                self.max_num_nodes
            )));
        }

        let unique_nodes: HashSet<_> = self.tree_nodes.iter().map(|n| n.claimant).collect();
        if unique_nodes.len() != self.tree_nodes.len() {
            return Err(MerkleValidationError(
                "Duplicate claimants found".to_string(),
            ));
        }

        let sum = get_max_total_claim(&self.tree_nodes);
        if sum != self.max_total_claim {
            return Err(MerkleValidationError(format!(
                "Tree nodes sum {} does not match max_total_claim {}",
                sum, self.max_total_claim
            )));
        }

        if self.verify_proof().is_err() {
            return Err(MerkleValidationError(
                "Merkle root is invalid given nodes".to_string(),
            ));
        }

        Ok(())
    }

    pub fn verify_proof(&self) -> Result<()> {
        let root = self.merkle_root;

        let hashed_nodes: Vec<[u8; 32]> = self
            .tree_nodes
            .iter()
            .map(|n| n.hash().to_bytes())
            .collect();
        let mk = MerkleTree::new(&hashed_nodes[..], true);

        assert_eq!(
            mk.get_root()
                .ok_or(MerkleValidationError("invalid merkle proof".to_string()))?
                .to_bytes(),
            root
        );

        for (i, _node) in hashed_nodes.iter().enumerate() {
            let node = hashv(&[LEAF_PREFIX, &hashed_nodes[i]]);
            let proof = get_proof(&mk, i);

            if !verify(proof, root, node.to_bytes()) {
                return Err(MerkleValidationError("invalid merkle proof".to_string()));
            }
        }

        Ok(())
    }

    pub fn convert_to_hashmap(&self) -> HashMap<Pubkey, TreeNode> {
        self.tree_nodes
            .iter()
            .map(|n| (n.claimant, n.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use solana_program::pubkey::Pubkey;

    use super::*;

    #[test]
    fn test_verify_new_merkle_tree() {
        let tree_nodes = vec![TreeNode {
            claimant: Pubkey::default(),
            proof: None,
            total_unlocked_staker: 2,
            total_locked_staker: 3,
            total_unlocked_searcher: 4,
            total_locked_searcher: 5,
            total_unlocked_validator: 6,
            total_locked_validator: 7,
        }];
        let merkle_tree = AirdropMerkleTree::new(tree_nodes).unwrap();
        assert!(merkle_tree.verify_proof().is_ok(), "verify failed");
    }

    #[test]
    fn test_new_merkle_tree_duplicate_claimants() {
        let duplicate_pubkey = Pubkey::new_unique();
        let tree_nodes = vec![
            TreeNode {
                claimant: duplicate_pubkey,
                proof: None,
                total_unlocked_staker: 10,
                total_locked_staker: 20,
                total_unlocked_searcher: 30,
                total_locked_searcher: 40,
                total_unlocked_validator: 50,
                total_locked_validator: 60,
            },
            TreeNode {
                claimant: duplicate_pubkey,
                proof: None,
                total_unlocked_staker: 1,
                total_locked_staker: 2,
                total_unlocked_searcher: 3,
                total_locked_searcher: 4,
                total_unlocked_validator: 5,
                total_locked_validator: 6,
            },
            TreeNode {
                claimant: Pubkey::new_unique(),
                proof: None,
                total_unlocked_staker: 0,
                total_locked_staker: 0,
                total_unlocked_searcher: 0,
                total_locked_searcher: 0,
                total_unlocked_validator: 0,
                total_locked_validator: 0,
            },
        ];

        let tree = AirdropMerkleTree::new(tree_nodes).unwrap();
        assert_eq!(tree.tree_nodes.len(), 2);
        assert_eq!(tree.tree_nodes[0].total_unlocked_staker, 11);
        assert_eq!(tree.tree_nodes[0].total_locked_staker, 22);
        assert_eq!(tree.tree_nodes[0].total_unlocked_searcher, 33);
        assert_eq!(tree.tree_nodes[0].total_locked_searcher, 44);
        assert_eq!(tree.tree_nodes[0].total_unlocked_validator, 55);
        assert_eq!(tree.tree_nodes[0].total_locked_validator, 66);
    }
}
