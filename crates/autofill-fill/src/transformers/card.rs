use super::Format;
use autofill_cpd::FieldDetails;

/// The format field `f` expects for the card value `key`.
pub fn format_for(key: &str, f: &FieldDetails) -> Option<Format> {
    if !matches!(
        f.field_type.as_str(),
        "text" | "tel" | "number" | "password" | ""
    ) {
        return None;
    }
    let max = f.max_length.unwrap_or(0);
    let shape = format!(
        "{} {}",
        f.placeholder.as_deref().unwrap_or(""),
        f.title.as_deref().unwrap_or("")
    )
    .to_lowercase();
    match key {
        "cc-number" if (12..25).contains(&max) => Some(Format::Digits),
        "cc-exp" if max == 4 || shape.contains("mmyy") => Some(Format::ExpCompact),
        "cc-exp" if max == 7 || shape.contains("yyyy") => Some(Format::ExpLong),
        "cc-exp-year" if max == 2 || (shape.contains("yy") && !shape.contains("yyyy")) => {
            Some(Format::YearShort)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(max: Option<u32>, placeholder: &str) -> FieldDetails {
        FieldDetails {
            field_type: "text".into(),
            max_length: max,
            placeholder: Some(placeholder.into()),
            ..Default::default()
        }
    }

    #[test]
    fn formats() {
        assert_eq!(
            format_for("cc-number", &field(Some(19), "")),
            Some(Format::Digits)
        );
        assert_eq!(format_for("cc-number", &field(None, "")), None);
        assert_eq!(format_for("cc-number", &field(Some(30), "")), None);
        assert_eq!(
            format_for("cc-exp", &field(Some(4), "")),
            Some(Format::ExpCompact)
        );
        assert_eq!(
            format_for("cc-exp", &field(None, "MM/YYYY")),
            Some(Format::ExpLong)
        );
        assert_eq!(format_for("cc-exp", &field(None, "MM/YY")), None);
        assert_eq!(
            format_for("cc-exp-year", &field(Some(2), "")),
            Some(Format::YearShort)
        );
        assert_eq!(format_for("cc-exp-year", &field(None, "YYYY")), None);
    }
}
