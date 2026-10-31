//! Pass 3: the form the user is in beats any other. Passwords only: the username follows its password.
use crate::pipeline::State;
use autofill_clue::{LoginKind, weights};

pub fn run(state: &mut State) {
    let Some(active) = state.active() else { return };
    let (form, block) = (active.form_id, active.block_path.clone());
    for f in &mut state.fields {
        let same = if f.details.form_id.is_some() {
            f.details.form_id == form
        } else {
            form.is_none() && f.details.shares_block(&block)
        };
        if same && matches!(f.kind, LoginKind::Pass | LoginKind::New) {
            f.weight += weights::PREFER_ACTIVE;
        }
    }
}
