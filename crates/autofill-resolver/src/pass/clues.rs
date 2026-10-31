//! Pass 2: scores every field from its own text, then from its neighbours and the active form.
use crate::pipeline::{Scored, State};
use autofill_clue::dynamic::next_textlike_field_type;
use autofill_clue::{LoginKind, classify, weights};
use autofill_cpd::FieldDetails;

pub fn run(state: &mut State) {
    let page = state.page;
    let active = state.active();
    let in_active_form =
        |f: &FieldDetails| active.is_some_and(|a| a.form_id.is_some() && a.form_id == f.form_id);
    let visible: Vec<&FieldDetails> = page.fields.iter().filter(|f| !f.is_hidden).collect();
    for field in &page.fields {
        let (kind, mut weight, ty) = classify(field);
        if weight > 0 && in_active_form(field) {
            weight += weights::ACTIVE_FORM_BONUS;
        }
        // A text field right before a password is its username, unless another field names itself.
        let neighbour = visible
            .iter()
            .position(|f| f.field_id == field.field_id)
            .and_then(|i| next_textlike_field_type(&visible, i))
            == Some("password");
        let neighbour_bonus = if neighbour && matches!(kind, LoginKind::User | LoginKind::Text) {
            weights::NEIGHBOUR_BONUS
        } else {
            0
        };
        state.fields.push(Scored {
            details: field,
            kind,
            weight,
            neighbour_bonus,
            ty,
            avoid: false,
            connected: false,
            correct_off: false,
        });
    }
}
