//! Banks and enterprise sites set `autocomplete="off"` to keep password managers out; a user who stores
//! a login for the site asked for the opposite. This decides where the attribute is overridden.
pub mod rules;

use autofill_cpd::{CollectedPageDetails, FieldDetails};
use autofill_designation::{AutofillType, FormDesignation};

/// One group of fields that belong together, in page order.
pub struct FieldGroup<'a> {
    pub form_id: Option<u32>,
    pub fields: Vec<&'a FieldDetails>,
}

/// Fields in a form, one group per form.
pub fn field_groups_from_forms(page: &CollectedPageDetails) -> Vec<FieldGroup<'_>> {
    page.forms
        .iter()
        .map(|form| FieldGroup {
            form_id: Some(form.form_id),
            fields: page
                .fields
                .iter()
                .filter(|f| f.form_id == Some(form.form_id))
                .collect(),
        })
        .filter(|group| !group.fields.is_empty())
        .collect()
}

/// Fields outside any form, grouped by the block of the page they share.
pub fn field_groups_not_in_forms(page: &CollectedPageDetails) -> Vec<FieldGroup<'_>> {
    let mut groups: Vec<FieldGroup> = vec![];
    for field in page.fields.iter().filter(|f| f.form_id.is_none()) {
        match groups
            .iter_mut()
            .find(|g| g.fields.iter().any(|o| o.shares_block(&field.block_path)))
        {
            Some(group) => group.fields.push(field),
            None => groups.push(FieldGroup {
                form_id: None,
                fields: vec![field],
            }),
        }
    }
    groups
}

/// The ids of the fields whose `autocomplete="off"` is overridden.
pub fn correct_autocomplete_off(
    page: &CollectedPageDetails,
    form_designation: impl Fn(Option<u32>) -> FormDesignation,
    autofill_type: impl Fn(u32) -> AutofillType,
) -> Vec<u32> {
    let mut out = vec![];
    for group in field_groups_from_forms(page)
        .iter()
        .chain(&field_groups_not_in_forms(page))
    {
        let designation = form_designation(group.form_id);
        for (i, field) in group.fields.iter().enumerate() {
            if field.has_autocomplete("off")
                && rules::login_field_groups::overrides(
                    group,
                    i,
                    designation,
                    autofill_type(field.field_id),
                )
            {
                out.push(field.field_id);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use autofill_cpd::FormDetails;

    fn field(id: u32, form: Option<u32>, ty: &str, ac: &str, block: u32) -> FieldDetails {
        FieldDetails {
            field_id: id,
            form_id: form,
            field_type: ty.into(),
            autocomplete_type: Some(ac.into()),
            block_path: vec![block],
            ..Default::default()
        }
    }

    fn corrected(
        fields: Vec<FieldDetails>,
        designation: FormDesignation,
        otp: Option<u32>,
    ) -> Vec<u32> {
        let page = CollectedPageDetails {
            forms: vec![FormDetails {
                form_id: 1,
                ..Default::default()
            }],
            fields,
            ..Default::default()
        };
        correct_autocomplete_off(
            &page,
            |form| {
                if form.is_some() {
                    designation
                } else {
                    FormDesignation::None
                }
            },
            |id| {
                if Some(id) == otp {
                    AutofillType::OneTimeCode
                } else {
                    AutofillType::None
                }
            },
        )
    }

    #[test]
    fn login_and_change_password_forms() {
        for designation in [FormDesignation::Login, FormDesignation::ChangePassword] {
            assert_eq!(
                corrected(vec![field(1, Some(1), "text", "off", 1)], designation, None),
                [1]
            );
        }
        assert!(
            corrected(
                vec![field(1, Some(1), "text", "off", 1)],
                FormDesignation::Newsletter,
                None
            )
            .is_empty()
        );
    }

    #[test]
    fn a_neighbouring_password_counts_without_a_form() {
        let fields = vec![
            field(1, None, "text", "off", 1),
            field(2, None, "password", "off", 1),
            field(3, None, "text", "off", 9),
        ];
        assert_eq!(corrected(fields, FormDesignation::None, None), [1, 2]);
    }

    #[test]
    fn a_lone_one_time_code_box() {
        assert_eq!(
            corrected(
                vec![field(1, None, "text", "off", 1)],
                FormDesignation::None,
                Some(1)
            ),
            [1]
        );
        // Not alone: the login form it is part of decides, and this one is no login.
        let two = vec![
            field(1, Some(1), "text", "off", 1),
            field(2, Some(1), "text", "on", 1),
        ];
        assert!(corrected(two, FormDesignation::None, Some(1)).is_empty());
    }

    #[test]
    fn other_values_are_left_alone() {
        assert!(
            corrected(
                vec![field(1, Some(1), "text", "on", 1)],
                FormDesignation::Login,
                None
            )
            .is_empty()
        );
    }
}
