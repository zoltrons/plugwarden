//! Pass 5: the hidden side of Pass 4. A hidden field in a form with a connected field stays in that form's
//! context, so the form is still recognised, but it never takes part in a login until it is shown.
use crate::pipeline::State;
use autofill_clue::LoginKind;

pub fn run(state: &mut State) {
    let connected: Vec<Option<u32>> = state
        .fields
        .iter()
        .filter(|f| f.connected)
        .map(|f| f.details.form_id)
        .collect();
    for f in &mut state.fields {
        if f.details.is_hidden {
            f.connected = connected.contains(&f.details.form_id);
            f.kind = LoginKind::None;
            f.weight = 0;
        } else if !f.details.is_fillable() {
            f.kind = LoginKind::None;
            f.weight = 0;
        }
    }
}
