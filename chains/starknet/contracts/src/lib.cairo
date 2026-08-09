//! Stork oracle contract for Starknet.
//!
//! See `src/stork.cairo` for the contract itself and `src/interface.cairo` for the ABI consumers
//! integrate against.

pub mod errors;
pub mod interface;
pub mod stork;
pub mod temporal_numeric_value;
pub mod verify;
