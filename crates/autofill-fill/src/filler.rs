use crate::transformers::{Format, card};
use autofill_autosubmit::best_submit_button;
use autofill_clue::field_clue::FORM_RULES;
use autofill_cpd::{CollectedPageDetails, FieldDetails};
use autofill_resolver::pipeline::is_standalone_otp;
use autofill_resolver::{Intent, resolve};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FillIntent {
    #[serde(rename_all = "camelCase")]
    Login {
        #[serde(default)]
        only_empty: bool,
        #[serde(default)]
        password_only: bool,
        /// The item has a code, so a lone one-time-code box can take it.
        #[serde(default)]
        has_totp: bool,
        /// The user's setting, for a fill they asked for. Never on page load.
        #[serde(default)]
        autosubmit: bool,
    },
    Form {
        /// The value names the item has, empty ones left out.
        keys: Vec<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FillOp {
    pub field_id: u32,
    /// `username`, `password`, `totp` or an HTML autocomplete token.
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<Format>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Submit {
    /// Press Enter in `fallback_field_id` if the button is gone by the time of the click.
    #[serde(rename_all = "camelCase")]
    Click {
        field_id: u32,
        fallback_field_id: u32,
    },
    #[serde(rename_all = "camelCase")]
    Enter { field_id: u32 },
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FillPlan {
    pub ops: Vec<FillOp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submit: Option<Submit>,
}

fn op(field: &FieldDetails, source: &str) -> FillOp {
    FillOp {
        field_id: field.field_id,
        source: source.into(),
        format: None,
    }
}

fn plan_login(
    page: &CollectedPageDetails,
    only_empty: bool,
    password_only: bool,
    has_totp: bool,
    autosubmit: bool,
) -> FillPlan {
    let state = resolve(
        page,
        Intent {
            only_empty,
            password_only,
        },
    );
    if has_totp
        && !only_empty
        && let Some(f) = state.fields.iter().find(|f| {
            f.details.is_active && f.details.is_fillable() && is_standalone_otp(&state, f)
        })
    {
        return FillPlan {
            ops: vec![op(f.details, "totp")],
            submit: None,
        };
    }
    let choice = state.choice;
    let password = choice.password.map(|i| &state.fields[i]);
    // Page load never fills a username-only step or a new/confirm password.
    if only_empty && password.is_none_or(|p| p.kind == autofill_clue::LoginKind::New) {
        return FillPlan::default();
    }
    let mut ops: Vec<FillOp> = vec![];
    if let Some(i) = choice.username {
        ops.push(op(state.fields[i].details, "username"));
    }
    if let Some(p) = password {
        ops.push(op(p.details, "password"));
        if let (false, Some(i)) = (only_empty, choice.confirm) {
            ops.push(op(state.fields[i].details, "password"));
        }
    }
    // Only a login with its password: a username-first step has only just begun.
    let submit = password.filter(|_| autosubmit && !only_empty).map(|p| {
        match best_submit_button(&page.buttons, p.details) {
            Some(b) => Submit::Click {
                field_id: b.field_id,
                fallback_field_id: p.details.field_id,
            },
            None => Submit::Enter {
                field_id: p.details.field_id,
            },
        }
    });
    FillPlan { ops, submit }
}

fn plan_form(page: &CollectedPageDetails, keys: &[String]) -> FillPlan {
    let has = |key: &str| keys.iter().any(|k| k == key);
    let mut ops = vec![];
    for f in page.fields.iter().filter(|f| f.is_fillable()) {
        let hint = f.hint();
        let tokens = f.autocomplete_tokens();
        let ac = tokens.last().map_or("", String::as_str);
        let Some(mut key) = (if has(ac) {
            Some(ac)
        } else {
            FORM_RULES
                .iter()
                .find(|(token, re)| has(token) && re.is_match(&hint))
                .map(|(token, _)| *token)
        }) else {
            continue;
        };
        if f.field_type == "textarea" {
            // Only an address fits a free-text box, and it has room for every line.
            if !key.starts_with("street-address") && !key.starts_with("address-line") {
                continue;
            }
            if has("street-address") {
                key = "street-address";
            }
        }
        ops.push(FillOp {
            field_id: f.field_id,
            source: key.into(),
            format: card::format_for(key, f),
        });
    }
    FillPlan { ops, submit: None }
}

pub fn plan_fill(page: &CollectedPageDetails, intent: &FillIntent) -> FillPlan {
    match intent {
        FillIntent::Login {
            only_empty,
            password_only,
            has_totp,
            autosubmit,
        } => plan_login(page, *only_empty, *password_only, *has_totp, *autosubmit),
        FillIntent::Form { keys } => plan_form(page, keys),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use autofill_cpd::{ButtonDetails, FormDetails};

    fn input(id: u32, ty: &str, name: &str) -> FieldDetails {
        FieldDetails {
            field_id: id,
            form_id: Some(1),
            field_type: ty.into(),
            html_name: Some(name.into()),
            block_path: vec![1],
            ..Default::default()
        }
    }

    fn page(fields: Vec<FieldDetails>) -> CollectedPageDetails {
        CollectedPageDetails {
            origin: "https://a.test".into(),
            forms: vec![FormDetails {
                form_id: 1,
                ..Default::default()
            }],
            fields,
            buttons: vec![],
        }
    }

    fn login(only_empty: bool, autosubmit: bool) -> FillIntent {
        FillIntent::Login {
            only_empty,
            password_only: false,
            has_totp: false,
            autosubmit,
        }
    }

    fn sources(plan: &FillPlan) -> Vec<(u32, &str)> {
        plan.ops
            .iter()
            .map(|o| (o.field_id, o.source.as_str()))
            .collect()
    }

    #[test]
    fn a_login() {
        let p = page(vec![
            input(1, "text", "username"),
            input(2, "password", "password"),
        ]);
        assert_eq!(
            sources(&plan_fill(&p, &login(false, false))),
            [(1, "username"), (2, "password")]
        );
    }

    #[test]
    fn page_load_skips_a_username_step_and_a_new_password() {
        let p = page(vec![input(1, "text", "username")]);
        assert!(plan_fill(&p, &login(true, false)).ops.is_empty());
        let mut new = input(2, "password", "password");
        new.autocomplete_type = Some("new-password".into());
        assert!(
            plan_fill(&page(vec![new]), &login(true, false))
                .ops
                .is_empty()
        );
    }

    #[test]
    fn hidden_fields_never_take_a_value() {
        let mut hidden = input(2, "password", "password");
        hidden.is_hidden = true;
        assert_eq!(
            sources(&plan_fill(
                &page(vec![input(1, "text", "username"), hidden]),
                &login(false, false)
            )),
            [(1, "username")]
        );
    }

    #[test]
    fn the_code_goes_in_the_box_the_user_is_in() {
        let mut otp = input(1, "text", "otp");
        otp.is_active = true;
        let totp = FillIntent::Login {
            only_empty: false,
            password_only: false,
            has_totp: true,
            autosubmit: true,
        };
        let plan = plan_fill(&page(vec![otp.clone()]), &totp);
        assert_eq!(sources(&plan), [(1, "totp")]);
        assert!(plan.submit.is_none());
        // No code on the item: an OTP box is not an account field.
        assert!(
            plan_fill(&page(vec![otp]), &login(false, false))
                .ops
                .is_empty()
        );
    }

    #[test]
    fn autosubmit_clicks_the_button_or_presses_enter() {
        let mut p = page(vec![
            input(1, "text", "username"),
            input(2, "password", "password"),
        ]);
        assert!(matches!(
            plan_fill(&p, &login(false, true)).submit,
            Some(Submit::Enter { field_id: 2 })
        ));
        assert!(plan_fill(&p, &login(false, false)).submit.is_none());
        assert!(
            plan_fill(&p, &login(true, true)).submit.is_none(),
            "never on page load"
        );
        p.buttons.push(ButtonDetails {
            field_id: 3,
            form_id: Some(1),
            text: Some("Sign in".into()),
            is_submit: true,
            ..Default::default()
        });
        assert!(matches!(
            plan_fill(&p, &login(false, true)).submit,
            Some(Submit::Click {
                field_id: 3,
                fallback_field_id: 2
            })
        ));
        let step = page(vec![input(1, "text", "username")]);
        assert!(
            plan_fill(&step, &login(false, true)).submit.is_none(),
            "a username step has only begun"
        );
    }

    #[test]
    fn a_form_fill_uses_the_token_then_the_text() {
        let mut number = input(1, "text", "x");
        number.autocomplete_type = Some("billing cc-number".into());
        number.max_length = Some(19);
        let mut name = input(2, "text", "x");
        name.label = Some("Name on card".into());
        let keys = FillIntent::Form {
            keys: vec!["cc-number".into(), "cc-name".into()],
        };
        let plan = plan_fill(&page(vec![number, name, input(3, "text", "other")]), &keys);
        assert_eq!(sources(&plan), [(1, "cc-number"), (2, "cc-name")]);
        assert_eq!(plan.ops[0].format, Some(Format::Digits));
    }

    #[test]
    fn a_textarea_only_takes_an_address() {
        let mut address = input(1, "textarea", "x");
        address.label = Some("Street address".into());
        let mut note = input(2, "textarea", "x");
        note.label = Some("Email us about your name".into());
        let keys = FillIntent::Form {
            keys: vec![
                "street-address".into(),
                "address-line1".into(),
                "email".into(),
                "name".into(),
            ],
        };
        assert_eq!(
            sources(&plan_fill(&page(vec![address, note]), &keys)),
            [(1, "street-address")]
        );
    }

    #[test]
    fn intents_parse_from_json() {
        let intent: FillIntent =
            serde_json::from_str(r#"{"kind":"login","onlyEmpty":true,"hasTotp":false}"#).unwrap();
        assert!(matches!(
            intent,
            FillIntent::Login {
                only_empty: true,
                ..
            }
        ));
        let intent: FillIntent = serde_json::from_str(r#"{"kind":"form","keys":["tel"]}"#).unwrap();
        assert!(matches!(intent, FillIntent::Form { .. }));
    }
}
