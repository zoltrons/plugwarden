use autofill_cpd::{ButtonDetails, FieldDetails};

/// In the field's form, or without any form in the same block of the page.
pub fn belongs_with(button: &ButtonDetails, field: &FieldDetails) -> bool {
    match field.form_id {
        Some(_) => button.form_id == field.form_id,
        None => button.form_id.is_none() && field.shares_block(&button.block_path),
    }
}
