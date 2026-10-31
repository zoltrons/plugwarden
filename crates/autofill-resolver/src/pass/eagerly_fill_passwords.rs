//! Pass 4: in a two-step login the password waits hidden next to the visible username. It counts as
//! part of that form's login, and is never filled while hidden: a hidden field is also what a page
//! would use to collect a password without showing it.
use crate::pipeline::State;
use autofill_clue::LoginKind;

pub fn run(state: &mut State) {
    let hidden: Vec<Option<u32>> = state
        .fields
        .iter()
        .filter(|f| f.details.is_password() && f.details.is_hidden && f.details.form_id.is_some())
        .map(|f| f.details.form_id)
        .collect();
    for f in &mut state.fields {
        if !f.details.is_hidden
            && matches!(f.kind, LoginKind::User)
            && hidden.contains(&f.details.form_id)
        {
            f.connected = true;
        }
    }
}
