//! Clues: text rules and the weights they carry.
pub mod dynamic;
pub mod field_clue;
pub mod weights;

pub use field_clue::{Clue, LoginKind, Op, Rule, classify, weak_word};
