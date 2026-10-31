use crate::field_ext::belongs_with;
use autofill_clue::Rule;
use autofill_cpd::{ButtonDetails, FieldDetails};

static SUBMITS: Rule = Rule::new(|| {
    regex_lite::Regex::new(r"log.?in|log.?on|sign.?in|giri[sş]|continue|devam|submit|next")
        .expect("valid pattern")
});
static NEVER: Rule = Rule::new(|| {
    regex_lite::Regex::new(r"sign.?up|regist|create|forgot|reset|cancel|back|google|apple|facebook|microsoft|github|sso|passkey|show|hide|kay[iı]t|unut|iptal|göster").expect("valid pattern")
});

fn score(button: &ButtonDetails) -> i32 {
    let text = button.text.as_deref().unwrap_or("").to_lowercase();
    if NEVER.test(&text) {
        return 0;
    }
    i32::from(button.is_submit) * 2 + i32::from(SUBMITS.test(&text)) * 3
}

/// The button that submits the login `password` is part of. Only an actual submit button or one that
/// says it logs in: a click on anything else may do anything at all.
pub fn best_submit_button<'a>(
    buttons: &'a [ButtonDetails],
    password: &FieldDetails,
) -> Option<&'a ButtonDetails> {
    let mut best: Option<(&ButtonDetails, i32)> = None;
    for b in buttons
        .iter()
        .filter(|b| !b.is_hidden && belongs_with(b, password))
    {
        let s = score(b);
        if s > 0 && best.is_none_or(|(_, top)| s > top) {
            best = Some((b, s));
        }
    }
    best.map(|(b, _)| b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn button(id: u32, form: Option<u32>, text: &str, is_submit: bool) -> ButtonDetails {
        ButtonDetails {
            field_id: id,
            form_id: form,
            text: Some(text.into()),
            is_submit,
            block_path: vec![7],
            ..Default::default()
        }
    }

    fn pass(form: Option<u32>) -> FieldDetails {
        FieldDetails {
            form_id: form,
            block_path: vec![7],
            ..Default::default()
        }
    }

    #[test]
    fn prefers_the_login_button() {
        let buttons = [
            button(1, Some(1), "Show password", false),
            button(2, Some(1), "", true),
            button(3, Some(1), "Sign in", true),
        ];
        assert_eq!(
            best_submit_button(&buttons, &pass(Some(1)))
                .unwrap()
                .field_id,
            3
        );
    }

    #[test]
    fn never_presses_other_buttons() {
        let buttons = [
            button(1, Some(1), "Create account", true),
            button(2, Some(1), "Sign in with Google", true),
            button(3, Some(2), "Sign in", true),
            button(4, Some(1), "Options", false),
        ];
        assert!(best_submit_button(&buttons, &pass(Some(1))).is_none());
    }

    #[test]
    fn formless_logins_look_in_their_block() {
        let mut far = button(2, None, "Sign in", false);
        far.block_path = vec![8];
        assert!(best_submit_button(&[far], &pass(None)).is_none());
        assert_eq!(
            best_submit_button(&[button(1, None, "Log in", false)], &pass(None))
                .unwrap()
                .field_id,
            1
        );
    }

    #[test]
    fn hidden_buttons_do_not_count() {
        let mut b = button(1, Some(1), "Sign in", true);
        b.is_hidden = true;
        assert!(best_submit_button(&[b], &pass(Some(1))).is_none());
    }
}
