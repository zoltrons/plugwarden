//! Runs the passes and reports the result: per field, a type and which inline menu it gets.
use crate::pass::recipes::{EMBEDDED, Recipe};
use crate::pass::{
    clues, eagerly_fill_passwords, field_avoider, form_clues, hidden_connected_fields,
    pick_best_results, prefer_active, recipes,
};
use autofill_autocomplete_off::correct_autocomplete_off;
use autofill_clue::LoginKind;
use autofill_clue::field_clue::{MENU_CARD, MENU_LOGIN, is_avoided};
use autofill_cpd::{CollectedPageDetails, FieldDetails};
use autofill_designation::{AutofillType, FormDesignation};
use serde::Serialize;
use std::collections::BTreeMap;

use crate::LoginChoice;

/// What the fill is about to do; analysis alone uses the default.
#[derive(Debug, Default, Clone, Copy)]
pub struct Intent {
    /// Page load: nobody asked, so no username-only step, no new password, and no focused-field bias.
    pub only_empty: bool,
    /// Only a form that has a password field.
    pub password_only: bool,
}

pub struct Scored<'a> {
    pub details: &'a FieldDetails,
    pub kind: LoginKind,
    pub weight: i32,
    pub neighbour_bonus: i32,
    pub ty: AutofillType,
    pub avoid: bool,
    /// Part of a two-step login with a hidden password.
    pub connected: bool,
    pub correct_off: bool,
}

pub struct State<'a> {
    pub page: &'a CollectedPageDetails,
    pub intent: Intent,
    pub fields: Vec<Scored<'a>>,
    pub forms: BTreeMap<Option<u32>, FormDesignation>,
    pub choice: LoginChoice,
}

impl<'a> State<'a> {
    /// The field the user is in, unless this fill must not care (page load).
    pub fn active(&self) -> Option<&'a FieldDetails> {
        if self.intent.only_empty {
            return None;
        }
        self.page.fields.iter().find(|f| f.is_active)
    }
}

pub fn resolve(page: &CollectedPageDetails, intent: Intent) -> State<'_> {
    resolve_with(page, intent, EMBEDDED)
}

pub fn resolve_with<'a>(
    page: &'a CollectedPageDetails,
    intent: Intent,
    site_recipes: &[Recipe],
) -> State<'a> {
    let mut state = State {
        page,
        intent,
        fields: vec![],
        forms: BTreeMap::new(),
        choice: LoginChoice::default(),
    };
    form_clues::run(&mut state);
    clues::run(&mut state);
    prefer_active::run(&mut state);
    eagerly_fill_passwords::run(&mut state);
    hidden_connected_fields::run(&mut state);
    field_avoider::run(&mut state);
    recipes::run(&mut state, site_recipes);
    pick_best_results::run(&mut state);
    autocomplete_off(&mut state);
    state
}

fn autocomplete_off(state: &mut State) {
    let types: BTreeMap<u32, AutofillType> = state
        .fields
        .iter()
        .map(|f| (f.details.field_id, f.ty))
        .collect();
    let corrected = correct_autocomplete_off(
        state.page,
        |form| {
            state
                .forms
                .get(&form)
                .copied()
                .unwrap_or(FormDesignation::None)
        },
        |id| types.get(&id).copied().unwrap_or(AutofillType::None),
    );
    for f in &mut state.fields {
        f.correct_off = corrected.contains(&f.details.field_id);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MenuKind {
    Login,
    Card,
    Identity,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Designation {
    pub autofill_type: AutofillType,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzedField {
    pub field_id: u32,
    pub designation: Designation,
    pub avoid: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub correct_autocomplete_off: bool,
    /// The menu opens only when the user is in the field, never by itself.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub requires_interaction_for_menu: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub menu: Option<MenuKind>,
    /// A login field of a registration form: the menu may offer to create an account.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub signup: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzedForm {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub form_id: Option<u32>,
    pub designation: FormDesignation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzedFrameResult {
    pub forms: Vec<AnalyzedForm>,
    pub fields: Vec<AnalyzedField>,
}

/// A one-time-code box with no password to go with it: the second step of a login.
pub fn is_standalone_otp(state: &State, f: &Scored) -> bool {
    f.ty == AutofillType::OneTimeCode
        && !state.fields.iter().any(|o| {
            o.details.is_password()
                && !o.details.is_hidden
                && (f.details.form_id.is_none() || o.details.form_id == f.details.form_id)
        })
        && matches!(
            f.details.field_type.as_str(),
            "text" | "tel" | "number" | ""
        )
}

fn menu_kind(state: &State, f: &Scored) -> Option<MenuKind> {
    let d = f.details;
    if d.is_disabled || d.is_read_only {
        return None;
    }
    if d.is_password() {
        return Some(MenuKind::Login);
    }
    if !matches!(
        d.field_type.as_str(),
        "text" | "email" | "tel" | "" | "search" | "number"
    ) {
        return None;
    }
    let hint = d.hint();
    let tokens = d.autocomplete_tokens();
    let ac = tokens.last().map_or("", String::as_str);
    let has_password = state
        .page
        .fields
        .iter()
        .any(|o| o.is_password() && (d.form_id.is_none() || o.form_id == d.form_id));
    if ac.starts_with("cc-") || MENU_CARD.test(&hint) {
        return Some(MenuKind::Card);
    }
    if ac == "username" || ac == "webauthn" {
        return Some(MenuKind::Login);
    }
    let identity = !ac.starts_with("cc-")
        && !matches!(
            ac,
            "" | "off"
                | "on"
                | "current-password"
                | "new-password"
                | "one-time-code"
                | "language"
                | "bday"
                | "sex"
                | "url"
                | "photo"
                | "impp"
        )
        && AutofillType::from_token(ac) != AutofillType::None;
    if identity && !(ac == "email" && has_password) {
        return Some(MenuKind::Identity);
    }
    let avoid = d.field_type == "search" || is_avoided(d);
    if (d.field_type == "email" || MENU_LOGIN.test(&hint)) && !avoid && has_password {
        return Some(MenuKind::Login);
    }
    if is_standalone_otp(state, f) || (f.correct_off && !avoid && f.kind != LoginKind::None) {
        return Some(MenuKind::Login);
    }
    None
}

pub fn analyze(page: &CollectedPageDetails) -> AnalyzedFrameResult {
    let state = resolve(page, Intent::default());
    let forms = state
        .forms
        .iter()
        .map(|(&form_id, &designation)| AnalyzedForm {
            form_id,
            designation,
        })
        .collect();
    let fields = state
        .fields
        .iter()
        .map(|f| {
            let menu = menu_kind(&state, f);
            let signup =
                menu == Some(MenuKind::Login) && form_clues::is_signup(page, f.details.form_id);
            AnalyzedField {
                field_id: f.details.field_id,
                designation: Designation {
                    autofill_type: f.ty,
                },
                avoid: f.avoid,
                correct_autocomplete_off: f.correct_off,
                requires_interaction_for_menu: f.correct_off,
                connected: f.connected,
                menu,
                signup,
            }
        })
        .collect();
    AnalyzedFrameResult { forms, fields }
}

#[cfg(test)]
mod tests {
    use super::*;
    use autofill_cpd::{ButtonDetails, FormDetails};

    fn input(id: u32, form: Option<u32>, ty: &str, name: &str) -> FieldDetails {
        FieldDetails {
            field_id: id,
            form_id: form,
            field_type: ty.into(),
            html_name: Some(name.into()),
            block_path: vec![form.unwrap_or(99)],
            ..Default::default()
        }
    }

    fn page(forms: &[u32], fields: Vec<FieldDetails>) -> CollectedPageDetails {
        CollectedPageDetails {
            origin: "https://a.test".into(),
            forms: forms
                .iter()
                .map(|&form_id| FormDetails {
                    form_id,
                    ..Default::default()
                })
                .collect(),
            fields,
            buttons: vec![],
        }
    }

    fn id_of(state: &State, i: Option<usize>) -> Option<u32> {
        i.map(|i| state.fields[i].details.field_id)
    }

    #[test]
    fn a_login_form() {
        let p = page(
            &[1],
            vec![
                input(1, Some(1), "text", "username"),
                input(2, Some(1), "password", "password"),
            ],
        );
        let state = resolve(&p, Intent::default());
        assert_eq!(state.forms[&Some(1)], FormDesignation::Login);
        assert_eq!(
            (
                id_of(&state, state.choice.username),
                id_of(&state, state.choice.password)
            ),
            (Some(1), Some(2))
        );
        assert_eq!(state.fields[0].ty, AutofillType::Username);
        assert_eq!(state.fields[1].ty, AutofillType::CurrentPassword);
    }

    #[test]
    fn registration_and_change_password_forms() {
        let mut new = input(2, Some(1), "password", "password");
        new.autocomplete_type = Some("new-password".into());
        let p = page(&[1], vec![input(1, Some(1), "email", "email"), new.clone()]);
        assert_eq!(
            resolve(&p, Intent::default()).forms[&Some(1)],
            FormDesignation::Registration
        );
        let mut current = input(3, Some(1), "password", "old");
        current.autocomplete_type = Some("current-password".into());
        let p = page(&[1], vec![current, new]);
        assert_eq!(
            resolve(&p, Intent::default()).forms[&Some(1)],
            FormDesignation::ChangePassword
        );
    }

    #[test]
    fn a_submit_button_names_a_registration_form() {
        let mut p = page(
            &[1],
            vec![
                input(1, Some(1), "email", "email"),
                input(2, Some(1), "password", "password"),
            ],
        );
        p.buttons.push(ButtonDetails {
            field_id: 3,
            form_id: Some(1),
            text: Some("Kayıt ol".into()),
            is_submit: true,
            ..Default::default()
        });
        assert_eq!(
            resolve(&p, Intent::default()).forms[&Some(1)],
            FormDesignation::Registration
        );
    }

    #[test]
    fn payment_and_newsletter_forms() {
        let p = page(&[1], vec![input(1, Some(1), "text", "cardnumber")]);
        assert_eq!(
            resolve(&p, Intent::default()).forms[&Some(1)],
            FormDesignation::Payment
        );
        let mut news = page(&[1], vec![input(1, Some(1), "email", "x")]);
        news.forms[0].text = Some("Subscribe to our newsletter".into());
        assert_eq!(
            resolve(&news, Intent::default()).forms[&Some(1)],
            FormDesignation::Newsletter
        );
    }

    #[test]
    fn search_and_coupon_boxes_are_avoided() {
        let p = page(
            &[1],
            vec![
                input(1, Some(1), "text", "q"),
                input(2, Some(1), "text", "coupon"),
                input(3, Some(1), "search", "x"),
                input(4, Some(1), "password", "password"),
            ],
        );
        let state = resolve(&p, Intent::default());
        assert!(state.fields[..3].iter().all(|f| f.avoid));
        assert_eq!(state.choice.username, None);
        assert_eq!(id_of(&state, state.choice.password), Some(4));
    }

    #[test]
    fn a_hidden_password_is_connected_but_never_chosen() {
        let mut hidden = input(2, Some(1), "password", "password");
        hidden.is_hidden = true;
        let p = page(&[1], vec![input(1, Some(1), "text", "username"), hidden]);
        let state = resolve(&p, Intent::default());
        assert_eq!(state.forms[&Some(1)], FormDesignation::Login);
        assert!(state.fields[0].connected && state.fields[1].connected);
        assert_eq!(
            (id_of(&state, state.choice.username), state.choice.password),
            (Some(1), None)
        );
    }

    #[test]
    fn a_number_is_an_account_field_only_right_before_the_password() {
        let mut id = input(1, Some(1), "number", "tridField");
        id.autocomplete_type = Some("off".into());
        let p = page(&[1], vec![id, input(2, Some(1), "password", "egpField")]);
        let state = resolve(&p, Intent::default());
        assert_eq!(id_of(&state, state.choice.username), Some(1));
        assert_eq!(analyze(&p).fields[0].menu, Some(MenuKind::Login));
        let p = page(
            &[1],
            vec![
                input(1, Some(1), "password", "password"),
                input(2, Some(1), "number", "amount"),
            ],
        );
        let state = resolve(&p, Intent::default());
        assert_eq!(state.choice.username, None);
        let p = page(&[1], vec![input(1, Some(1), "number", "amount")]);
        assert_eq!(resolve(&p, Intent::default()).choice.username, None);
    }

    #[test]
    fn one_username_per_form() {
        let p = page(
            &[1],
            vec![
                input(1, Some(1), "text", "username"),
                input(2, Some(1), "text", "user_alias"),
                input(3, Some(1), "password", "password"),
            ],
        );
        let state = resolve(&p, Intent::default());
        let usernames = state
            .fields
            .iter()
            .filter(|f| f.ty == AutofillType::Username)
            .count();
        assert_eq!(
            (usernames, id_of(&state, state.choice.username)),
            (1, Some(2))
        );
    }

    #[test]
    fn the_active_form_wins_except_on_page_load() {
        let mut p = page(
            &[1, 2],
            vec![
                input(1, Some(1), "password", "password"),
                input(2, Some(2), "password", "password"),
            ],
        );
        p.fields[1].is_active = true;
        assert_eq!(
            id_of(
                &resolve(&p, Intent::default()),
                resolve(&p, Intent::default()).choice.password
            ),
            Some(2)
        );
        let quiet = resolve(
            &p,
            Intent {
                only_empty: true,
                password_only: false,
            },
        );
        assert_eq!(id_of(&quiet, quiet.choice.password), Some(1));
    }

    #[test]
    fn recipes_override_and_stay_on_their_site() {
        let p = page(
            &[1],
            vec![
                input(1, Some(1), "text", "x"),
                input(2, Some(1), "text", "acct"),
                input(3, Some(1), "password", "y"),
            ],
        );
        let recipe = [Recipe {
            host: "a.test",
            field: "x",
            ty: AutofillType::Username,
        }];
        let state = resolve_with(&p, Intent::default(), &recipe);
        assert_eq!(id_of(&state, state.choice.username), Some(1));
        let other = [Recipe {
            host: "b.test",
            field: "x",
            ty: AutofillType::Username,
        }];
        let state = resolve_with(&p, Intent::default(), &other);
        assert_eq!(id_of(&state, state.choice.username), Some(2));
    }

    #[test]
    fn a_recipe_cannot_fill_a_hidden_field() {
        let mut hidden = input(1, Some(1), "text", "x");
        hidden.is_hidden = true;
        let p = page(&[1], vec![hidden]);
        let state = resolve_with(
            &p,
            Intent::default(),
            &[Recipe {
                host: "a.test",
                field: "x",
                ty: AutofillType::Username,
            }],
        );
        assert_eq!(state.choice.username, None);
    }

    #[test]
    fn autocomplete_off_is_reported_and_opens_the_menu() {
        let mut user = input(1, Some(1), "text", "x");
        user.autocomplete_type = Some("off".into());
        let mut pass = input(2, Some(1), "password", "y");
        pass.autocomplete_type = Some("off".into());
        let result = analyze(&page(&[1], vec![user, pass]));
        let f = &result.fields[0];
        assert!(f.correct_autocomplete_off && f.requires_interaction_for_menu);
        assert_eq!(f.menu, Some(MenuKind::Login));
    }

    #[test]
    fn a_lone_one_time_code_box_gets_the_login_menu() {
        let mut otp = input(1, Some(1), "text", "otp");
        otp.autocomplete_type = Some("off".into());
        let result = analyze(&page(&[1], vec![otp]));
        assert_eq!(
            result.fields[0].designation.autofill_type,
            AutofillType::OneTimeCode
        );
        assert_eq!(result.fields[0].menu, Some(MenuKind::Login));
        // Next to a password it is the same login's second box, and no account field.
        let result = analyze(&page(
            &[1],
            vec![
                input(1, Some(1), "text", "otp"),
                input(2, Some(1), "password", "password"),
            ],
        ));
        assert_eq!(result.fields[0].menu, None);
    }

    #[test]
    fn menu_kinds() {
        let mut card = input(1, Some(1), "text", "cvc");
        let mut identity = input(2, Some(2), "text", "x");
        identity.autocomplete_type = Some("given-name".into());
        let result = analyze(&page(&[1, 2], vec![card.clone(), identity]));
        assert_eq!(result.fields[0].menu, Some(MenuKind::Card));
        assert_eq!(result.fields[1].menu, Some(MenuKind::Identity));
        card.is_read_only = true;
        assert_eq!(analyze(&page(&[1], vec![card])).fields[0].menu, None);
    }

    #[test]
    fn output_shape() {
        let json = serde_json::to_value(analyze(&page(
            &[1],
            vec![input(1, Some(1), "password", "password")],
        )))
        .unwrap();
        assert_eq!(json["forms"][1]["designation"], "Login");
        assert_eq!(
            json["fields"][0]["designation"]["autofillType"],
            "CurrentPassword"
        );
        assert_eq!(json["fields"][0]["menu"], "login");
    }
}
