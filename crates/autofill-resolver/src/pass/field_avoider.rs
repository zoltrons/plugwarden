//! Pass 6: search boxes, coupons, captchas, honeypots and one-time codes never take an account value.
use crate::pipeline::State;
use autofill_clue::LoginKind;
use autofill_clue::field_clue::{HONEYPOT, is_avoided};

pub fn run(state: &mut State) {
    for f in &mut state.fields {
        // A password box is only ruled out as a trap: "Confirm with your one-time password" is still one.
        f.avoid = f.details.is_hidden
            || if f.details.is_password() {
                HONEYPOT.test(&f.details.hint())
            } else {
                is_avoided(f.details)
            };
        if f.avoid {
            f.kind = LoginKind::None;
            f.weight = 0;
        }
    }
}
