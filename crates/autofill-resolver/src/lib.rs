//! The eight passes that turn collected page details into a type for every field.
pub mod pass;
pub mod pipeline;

pub use pass::pick_best_results::LoginChoice;
pub use pipeline::{AnalyzedFrameResult, Intent, State, analyze, resolve};
