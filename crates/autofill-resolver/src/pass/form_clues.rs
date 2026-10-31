//! Pass 1: what each form is for. Formless fields form one virtual form, `None`.
use crate::pipeline::State;
use autofill_clue::field_clue::{CHANGE_EMAIL, MENU_CARD, NEWSLETTER, SIGNUP_ATTRS, SSH_KEY};
use autofill_cpd::{CollectedPageDetails, FieldDetails};
use autofill_designation::FormDesignation;

/// The fields a form owns; without a form, the whole frame (a component may wrap each input on its own).
fn members(page: &CollectedPageDetails, form: Option<u32>) -> impl Iterator<Item = &FieldDetails> {
    page.fields
        .iter()
        .filter(move |f| form.is_none() || f.form_id == form)
}

/// True for a registration form. A password field is required: a lone "Sign up" is as often a newsletter
/// box. Attributes and submit buttons only, since login forms often link to "Sign up".
/// shortcut: email-first signups (password on the next step) are not recognised, add a signal if they matter.
pub fn is_signup(page: &CollectedPageDetails, form: Option<u32>) -> bool {
    let passwords: Vec<&FieldDetails> = members(page, form).filter(|f| f.is_password()).collect();
    if passwords.is_empty()
        || passwords
            .iter()
            .any(|p| p.has_autocomplete("current-password"))
    {
        return false;
    }
    if passwords.len() > 1 || passwords.iter().any(|p| p.has_autocomplete("new-password")) {
        return true;
    }
    let Some(id) = form else { return false };
    let Some(details) = page.forms.iter().find(|f| f.form_id == id) else {
        return false;
    };
    let mut parts = vec![
        details.html_id.as_deref().unwrap_or(""),
        details.html_name.as_deref().unwrap_or(""),
        details.action.as_deref().unwrap_or(""),
    ];
    parts.extend(
        page.buttons
            .iter()
            .filter(|b| b.is_submit && b.form_id == form)
            .filter_map(|b| b.text.as_deref()),
    );
    SIGNUP_ATTRS.test(&parts.join(" ").to_lowercase())
}

fn designate(page: &CollectedPageDetails, form: Option<u32>) -> FormDesignation {
    let passwords: Vec<&FieldDetails> = members(page, form).filter(|f| f.is_password()).collect();
    let current = passwords
        .iter()
        .any(|p| p.has_autocomplete("current-password"));
    let fresh = passwords.iter().any(|p| p.has_autocomplete("new-password"));
    if current && (fresh || passwords.len() > 1) {
        return FormDesignation::ChangePassword;
    }
    if is_signup(page, form) {
        return FormDesignation::Registration;
    }
    if !passwords.is_empty() {
        return FormDesignation::Login;
    }
    let text = |f: &FieldDetails| f.hint();
    if members(page, form).any(|f| f.has_autocomplete("cc-number") || MENU_CARD.test(&text(f))) {
        return FormDesignation::Payment;
    }
    let details = form.and_then(|id| page.forms.iter().find(|f| f.form_id == id));
    let form_text = details.map_or(String::new(), |d| {
        format!(
            "{} {}",
            d.action.as_deref().unwrap_or(""),
            d.text.as_deref().unwrap_or("")
        )
        .to_lowercase()
    });
    if members(page, form).any(|f| SSH_KEY.test(&text(f))) {
        return FormDesignation::SshKey;
    }
    if CHANGE_EMAIL.test(&form_text) {
        return FormDesignation::ChangeEmail;
    }
    if NEWSLETTER.test(&form_text) || members(page, form).any(|f| NEWSLETTER.test(&text(f))) {
        return FormDesignation::Newsletter;
    }
    FormDesignation::None
}

pub fn run(state: &mut State) {
    let page = state.page;
    state.forms.insert(None, designate(page, None));
    for form in &page.forms {
        state
            .forms
            .insert(Some(form.form_id), designate(page, Some(form.form_id)));
    }
}
