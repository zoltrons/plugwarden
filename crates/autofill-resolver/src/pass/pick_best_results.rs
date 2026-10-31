//! Pass 8: the password and username a login goes into, one of each per form.
use crate::pipeline::{Scored, State};
use autofill_clue::field_clue::{CONFIRM, SIGNUP_TEXT};
use autofill_clue::{LoginKind, weights};
use autofill_designation::AutofillType;

/// Indexes into `State::fields`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct LoginChoice {
    pub password: Option<usize>,
    pub username: Option<usize>,
    /// The repeat box of a registration form: left empty, it blocks the submit.
    pub confirm: Option<usize>,
}

const fn is_pass(kind: LoginKind) -> bool {
    matches!(kind, LoginKind::Pass | LoginKind::New)
}

const fn is_candidate(kind: LoginKind) -> bool {
    matches!(kind, LoginKind::User | LoginKind::Text)
}

fn pick_password(state: &State) -> Option<usize> {
    let fields = &state.fields;
    let mut best: Option<(usize, i32)> = None;
    for (i, f) in fields.iter().enumerate().filter(|(_, f)| is_pass(f.kind)) {
        let mut score = f.weight;
        if let Some(id) = f.details.form_id {
            score += weights::FORM_HAS_PASSWORD_FORM;
            let text = state
                .page
                .forms
                .iter()
                .find(|form| form.form_id == id)
                .and_then(|form| form.text.as_deref())
                .unwrap_or("");
            if SIGNUP_TEXT.test(&text.to_lowercase()) {
                score -= weights::SIGNUP_FORM_PENALTY;
            }
        }
        if fields[..i]
            .iter()
            .any(|u| is_candidate(u.kind) && u.details.form_id == f.details.form_id)
        {
            score += weights::USER_BEFORE_PASSWORD;
        }
        // The first of equals: a form earlier on the page.
        if best.is_none_or(|(_, top)| score > top) {
            best = Some((i, score));
        }
    }
    best.map(|(i, _)| i)
}

/// The best-named field; of equals, one before the password, and of those the nearest.
fn pick_username(
    fields: &[Scored],
    password: Option<usize>,
    allowed: impl Fn(&Scored) -> bool,
) -> Option<usize> {
    let mut best: Option<(usize, (i32, bool))> = None;
    for (i, f) in fields
        .iter()
        .enumerate()
        .filter(|(_, f)| is_candidate(f.kind) && allowed(f))
    {
        let rank = (
            f.weight + f.neighbour_bonus,
            password.is_some_and(|p| i < p),
        );
        if best.is_none_or(|(_, top)| rank >= top) {
            best = Some((i, rank));
        }
    }
    best.map(|(i, _)| i)
}

pub fn run(state: &mut State) {
    let password = pick_password(state);
    let fields = &state.fields;
    let username = match password {
        // A form is the boundary: typing a username into another form's field is never right.
        Some(p) if fields[p].details.form_id.is_some() => pick_username(fields, password, |u| {
            u.details.form_id == fields[p].details.form_id
        }),
        // No form at all: only a field in the same block, never a page-wide search or subscribe box.
        Some(p) => pick_username(fields, password, |u| {
            u.details.form_id.is_none() && u.details.shares_block(&fields[p].details.block_path)
        }),
        // Username-first step (the password comes on the next page): only a field that names itself.
        None if !state.intent.only_empty && !state.intent.password_only => {
            pick_username(fields, None, |u| u.kind == LoginKind::User)
        }
        None => None,
    };
    let confirm = password.and_then(|p| {
        let next = (p + 1..fields.len()).find(|&i| {
            is_pass(fields[i].kind) && fields[i].details.form_id == fields[p].details.form_id
        })?;
        ((fields[p].kind == LoginKind::New && fields[next].kind == LoginKind::New)
            || CONFIRM.test(&fields[next].details.hint()))
        .then_some(next)
    });
    state.choice = LoginChoice {
        password,
        username,
        confirm,
    };
    if let Some(u) = username {
        // One account field per form: anything else that looked like one was not it.
        let form = state.fields[u].details.form_id;
        for (i, f) in state.fields.iter_mut().enumerate() {
            if i != u && f.ty == AutofillType::Username && f.details.form_id == form {
                f.ty = AutofillType::None;
            }
        }
        if state.fields[u].ty == AutofillType::None {
            state.fields[u].ty = AutofillType::Username;
        }
    }
}
