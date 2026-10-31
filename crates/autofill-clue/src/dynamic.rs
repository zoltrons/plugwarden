//! Clues from a field's neighbours.
use autofill_cpd::FieldDetails;

/// Text-like: can hold a typed account name or password.
pub fn is_textlike(f: &FieldDetails) -> bool {
    matches!(
        f.field_type.as_str(),
        "text" | "email" | "tel" | "" | "password"
    )
}

/// The nearest text-like field before index `i` among `fields`.
pub fn prev_textlike_field_type<'a>(fields: &[&'a FieldDetails], i: usize) -> Option<&'a str> {
    fields[..i]
        .iter()
        .rev()
        .find(|f| is_textlike(f))
        .map(|f| f.field_type.as_str())
}

/// The nearest text-like field after index `i` among `fields`.
pub fn next_textlike_field_type<'a>(fields: &[&'a FieldDetails], i: usize) -> Option<&'a str> {
    fields
        .get(i + 1..)?
        .iter()
        .find(|f| is_textlike(f))
        .map(|f| f.field_type.as_str())
}
