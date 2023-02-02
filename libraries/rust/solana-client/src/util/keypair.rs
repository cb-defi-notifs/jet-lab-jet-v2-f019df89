//! missing implementations for keypair

use solana_sdk::signature::Keypair;

/// Clone is not implemented for Keypair
pub fn clone(keypair: &Keypair) -> Keypair {
    Keypair::from_bytes(&keypair.to_bytes()).unwrap()
}

/// Clone is not implemented for Keypair
pub fn clone_vec(vec: &[Keypair]) -> Vec<Keypair> {
    vec.iter().map(clone).collect()
}