//! `CollectedPageDetails`: what `src/autofill/collector` reports about a frame. Every string here is
//! page-controlled; `src/shared/messages.ts` caps the sizes before it gets this far.
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CollectedPageDetails {
    pub origin: String,
    pub forms: Vec<FormDetails>,
    pub fields: Vec<FieldDetails>,
    pub buttons: Vec<ButtonDetails>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FormDetails {
    pub form_id: u32,
    pub html_id: Option<String>,
    pub html_name: Option<String>,
    pub action: Option<String>,
    /// The form's visible text, as the page writes it.
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ButtonDetails {
    pub field_id: u32,
    pub form_id: Option<u32>,
    pub text: Option<String>,
    /// Submits its form: a `<button>` without a type, or `input[type=submit]`.
    pub is_submit: bool,
    pub is_hidden: bool,
    pub block_path: Vec<u32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FieldDetails {
    pub field_id: u32,
    pub form_id: Option<u32>,
    /// An input's own type; "select" or "textarea" for those elements.
    #[serde(rename = "type")]
    pub field_type: String,
    pub html_id: Option<String>,
    pub html_name: Option<String>,
    pub html_class: Option<String>,
    pub autocomplete_type: Option<String>,
    pub placeholder: Option<String>,
    pub max_length: Option<u32>,
    pub min_length: Option<u32>,
    pub tab_index: Option<i32>,
    pub title: Option<String>,
    pub password_rules: Option<String>,
    pub data_attributes: BTreeMap<String, String>,
    pub is_active: bool,
    pub is_checked: bool,
    /// Nobody can see it: a decoy, or a step that has not opened yet. Never filled.
    pub is_hidden: bool,
    pub is_read_only: bool,
    pub is_disabled: bool,
    pub is_aria_disabled: bool,
    pub is_aria_has_popup: bool,
    pub is_aria_hidden: bool,
    pub label: Option<String>,
    pub label_aria: Option<String>,
    pub label_data: Option<String>,
    pub label_before: Option<String>,
    pub label_after: Option<String>,
    /// Ids of the ancestors below `<body>`, nearest first, across shadow roots. Two fields that share
    /// one are in one block of the page.
    pub block_path: Vec<u32>,
}

fn nonblank(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.trim().is_empty())
}

impl FieldDetails {
    /// The autocomplete attribute's tokens, lower-cased.
    pub fn autocomplete_tokens(&self) -> Vec<String> {
        self.autocomplete_type
            .as_deref()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_lowercase)
            .collect()
    }

    pub fn has_autocomplete(&self, token: &str) -> bool {
        self.autocomplete_tokens().iter().any(|t| t == token)
    }

    pub fn is_password(&self) -> bool {
        self.field_type == "password"
    }

    /// Shown and not a read-only copy the page only displays.
    pub fn is_fillable(&self) -> bool {
        !self.is_hidden && !self.is_read_only && !self.is_disabled
    }

    pub fn shares_block(&self, block_path: &[u32]) -> bool {
        self.block_path.iter().any(|id| block_path.contains(id))
    }

    /// What a user reads as the field's name, lower-cased. The text around the field only counts when
    /// the field names itself in no other way: that text may belong to something else.
    pub fn display_text(&self) -> String {
        let own: Vec<&str> = [
            &self.placeholder,
            &self.label_aria,
            &self.label_data,
            &self.label,
        ]
        .into_iter()
        .filter_map(nonblank)
        .collect();
        if own.is_empty() {
            nonblank(&self.label_before)
                .or(nonblank(&self.label_after))
                .unwrap_or("")
                .to_lowercase()
        } else {
            own.join(" ").to_lowercase()
        }
    }

    /// The names the page's code gives the field, lower-cased.
    pub fn code_text(&self) -> String {
        [
            self.html_name.as_deref().unwrap_or(""),
            self.html_id.as_deref().unwrap_or(""),
        ]
        .join(" ")
        .to_lowercase()
    }

    /// Class and data-* values: names too, but often about styling, so only ever a weak signal.
    pub fn weak_code_text(&self) -> String {
        let mut all = vec![self.html_class.as_deref().unwrap_or("")];
        all.extend(self.data_attributes.values().map(String::as_str));
        all.join(" ").to_lowercase()
    }

    /// Everything that names the field.
    pub fn hint(&self) -> String {
        format!("{} {}", self.code_text(), self.display_text())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_collectors_json_and_ignores_unknown_keys() {
        let page: CollectedPageDetails = serde_json::from_str(
            r#"{"origin":"https://a.test","forms":[{"formId":1,"action":"/x"}],"future":1,
                "fields":[{"fieldId":2,"formId":1,"type":"password","htmlName":"Pw","isHidden":true,"dataAttributes":{"a":"B"},"blockPath":[3,4]}]}"#,
        )
        .unwrap();
        let f = &page.fields[0];
        assert!(f.is_password() && f.is_hidden && !f.is_fillable());
        assert_eq!(f.code_text().trim(), "pw");
        assert_eq!(f.weak_code_text().trim(), "b");
        assert!(f.shares_block(&[9, 4]) && !f.shares_block(&[9]));
    }

    #[test]
    fn surrounding_text_only_counts_without_a_label() {
        let mut f = FieldDetails {
            label_before: Some("Email".into()),
            label_after: Some("After".into()),
            ..Default::default()
        };
        assert_eq!(f.display_text(), "email");
        f.label_before = None;
        assert_eq!(f.display_text(), "after");
        f.placeholder = Some("Phone".into());
        assert_eq!(f.display_text(), "phone");
    }
}
