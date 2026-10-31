//! Turns a classified page into a fill plan: field ids and the *name* of the value each one takes.
//! The values themselves stay in the service worker and never enter this module.
pub mod filler;
pub mod transformers;

pub use filler::{FillIntent, FillPlan, plan_fill};
