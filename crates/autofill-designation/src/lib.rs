//! What the autofill engine decides a field or a form is.
mod autofill_type;
mod form_designation;

pub use autofill_type::AutofillType;
pub use form_designation::FormDesignation;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_round_trip_through_json() {
        for ty in [
            AutofillType::None,
            AutofillType::Username,
            AutofillType::CcExpMonth,
            AutofillType::SshKey,
            AutofillType::CryptoRecoverySeed,
        ] {
            let json = serde_json::to_string(&ty).unwrap();
            assert_eq!(serde_json::from_str::<AutofillType>(&json).unwrap(), ty);
        }
        assert_eq!(
            serde_json::to_string(&AutofillType::CcCsc).unwrap(),
            "\"CcCsc\""
        );
        assert!(serde_json::from_str::<AutofillType>("\"Nope\"").is_err());
    }

    #[test]
    fn forms_round_trip_through_json() {
        for form in [
            FormDesignation::None,
            FormDesignation::Login,
            FormDesignation::Registration,
            FormDesignation::Newsletter,
            FormDesignation::ChangePassword,
            FormDesignation::ChangeEmail,
            FormDesignation::Payment,
            FormDesignation::SshKey,
        ] {
            let json = serde_json::to_string(&form).unwrap();
            assert_eq!(
                serde_json::from_str::<FormDesignation>(&json).unwrap(),
                form
            );
        }
    }

    #[test]
    fn tokens_name_types() {
        assert_eq!(
            AutofillType::from_token("cc-number"),
            AutofillType::CcNumber
        );
        assert_eq!(AutofillType::from_token("off"), AutofillType::None);
    }
}
