use crate::FieldGroup;
use autofill_designation::{AutofillType, FormDesignation};

/// Whether field `i` of `group` takes a login despite its `autocomplete="off"`.
pub fn overrides(
    group: &FieldGroup,
    i: usize,
    designation: FormDesignation,
    ty: AutofillType,
) -> bool {
    if matches!(
        designation,
        FormDesignation::Login | FormDesignation::ChangePassword
    ) {
        return true;
    }
    let beside = |j: Option<usize>| {
        j.and_then(|j| group.fields.get(j))
            .is_some_and(|f| f.is_password())
    };
    if group.fields[i].is_password() || beside(i.checked_sub(1)) || beside(i.checked_add(1)) {
        return true;
    }
    ty == AutofillType::OneTimeCode && group.fields.len() == 1
}
