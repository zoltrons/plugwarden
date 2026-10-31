//! Pass 7: per-site corrections for pages the rules above get wrong. They are compiled in, so they
//! change only with a release of the extension.
use crate::pipeline::State;
use autofill_clue::{LoginKind, weights};
use autofill_designation::AutofillType;

pub struct Recipe {
    /// Exact host of the frame.
    pub host: &'static str,
    /// The field's `name` or `id`, exactly as the page writes it.
    pub field: &'static str,
    /// What the field really is. `None` keeps it out of every fill.
    pub ty: AutofillType,
}

/// shortcut: no site is listed yet, since each entry needs a page it was verified on. Add entries here.
pub const EMBEDDED: &[Recipe] = &[];

/// The host of an `https://host:port` origin.
fn host(origin: &str) -> &str {
    let rest = origin.split_once("://").map_or(origin, |(_, rest)| rest);
    rest.split([':', '/']).next().unwrap_or(rest)
}

pub fn run(state: &mut State, recipes: &[Recipe]) {
    let site = host(&state.page.origin);
    for recipe in recipes.iter().filter(|r| r.host == site) {
        for f in &mut state.fields {
            let d = f.details;
            if d.html_name.as_deref() != Some(recipe.field)
                && d.html_id.as_deref() != Some(recipe.field)
            {
                continue;
            }
            f.ty = recipe.ty;
            (f.kind, f.weight) = match recipe.ty {
                AutofillType::Username | AutofillType::Email => (LoginKind::User, weights::RECIPE),
                AutofillType::CurrentPassword => (LoginKind::Pass, weights::RECIPE),
                AutofillType::NewPassword => (LoginKind::New, weights::RECIPE),
                _ => (LoginKind::None, 0),
            };
            f.avoid = recipe.ty == AutofillType::None || d.is_hidden;
            // A recipe names a field, it does not make a hidden one safe to fill.
            if !d.is_fillable() {
                f.kind = LoginKind::None;
                f.weight = 0;
            }
        }
    }
}
