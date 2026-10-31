//! Picks what submits a filled login: the best-ranked button, else Enter in the password field.
pub mod field_ext;
pub mod rank;

pub use rank::best_submit_button;
