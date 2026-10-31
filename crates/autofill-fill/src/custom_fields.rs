//! Custom fields of an item, matched to page fields by name the way the official clients do. A name is
//! compared with the field's id, name, labels and placeholder; `id=`, `name=`, `label=` and `placeholder=`
//! narrow it to one of them, and `regex=` and `csv=` change how it compares.
use autofill_cpd::{CollectedPageDetails, FieldDetails};
use regex_lite::Regex;

const SEARCH_WORDS: [&str; 4] = ["search", "query", "find", "go"];
const NOT_FILLABLE: [&str; 6] = ["file", "submit", "button", "reset", "image", "search"];

enum Compare {
    Text(String),
    Csv(Vec<String>),
    /// `None`: the pattern does not compile, and matches nothing.
    Pattern(Option<Regex>),
}

impl Compare {
    fn parse(name: &str) -> Self {
        let lower = name.to_lowercase();
        if lower.starts_with("regex=") {
            return Self::Pattern(Regex::new(&format!("(?i){}", &name[6..])).ok());
        }
        if let Some(list) = lower.strip_prefix("csv=") {
            return Self::Csv(list.split(',').map(|v| v.trim().to_string()).collect());
        }
        Self::Text(lower)
    }

    fn matches(&self, value: Option<&str>) -> bool {
        let Some(value) = value
            .map(|v| v.trim().replace(['\r', '\n'], ""))
            .filter(|v| !v.is_empty())
        else {
            return false;
        };
        match self {
            Self::Text(text) => value.to_lowercase() == *text,
            Self::Csv(list) => list.contains(&value.to_lowercase()),
            Self::Pattern(re) => re.as_ref().is_some_and(|re| re.is_match(&value)),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Property {
    Id,
    Name,
    Label,
    Placeholder,
}

const ALL: [Property; 4] = [
    Property::Id,
    Property::Name,
    Property::Label,
    Property::Placeholder,
];

struct Rule {
    /// The compare after a `id=`-like prefix, and the property it is limited to.
    narrowed: Option<(Property, Compare)>,
    whole: Compare,
}

impl Rule {
    fn parse(name: &str) -> Self {
        let lower = name.to_lowercase();
        let narrowed = [
            ("id=", Property::Id),
            ("name=", Property::Name),
            ("label=", Property::Label),
            ("placeholder=", Property::Placeholder),
        ]
        .into_iter()
        .find(|(prefix, _)| lower.starts_with(prefix))
        .map(|(prefix, property)| (property, Compare::parse(&name[prefix.len()..])));
        Self {
            narrowed,
            whole: Compare::parse(name),
        }
    }

    fn matches(&self, field: &FieldDetails) -> bool {
        self.narrowed
            .as_ref()
            .is_some_and(|(property, compare)| has(field, *property, compare))
            || ALL
                .iter()
                .any(|property| has(field, *property, &self.whole))
    }
}

fn has(field: &FieldDetails, property: Property, compare: &Compare) -> bool {
    match property {
        Property::Id => compare.matches(field.html_id.as_deref()),
        Property::Name => compare.matches(field.html_name.as_deref()),
        Property::Placeholder => compare.matches(field.placeholder.as_deref()),
        Property::Label => [
            &field.label_before,
            &field.label_after,
            &field.label,
            &field.label_aria,
        ]
        .into_iter()
        .any(|l| compare.matches(l.as_deref())),
    }
}

/// `camelCase_name` -> its lower-case words.
fn words(value: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(value.len() + 4);
    let mut previous_lower = false;
    for c in value.chars() {
        if previous_lower && c.is_ascii_uppercase() {
            spaced.push(' ');
        }
        previous_lower = c.is_ascii_lowercase();
        spaced.push(c.to_ascii_lowercase());
    }
    spaced
        .split(|c: char| !c.is_ascii_lowercase())
        .map(str::to_string)
        .collect()
}

fn is_search_box(field: &FieldDetails) -> bool {
    [
        Some(field.field_type.as_str()),
        field.html_name.as_deref(),
        field.html_id.as_deref(),
        field.placeholder.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|value| {
        words(value)
            .iter()
            .any(|w| SEARCH_WORDS.contains(&w.as_str()))
    })
}

/// For each field a name matches: its id and the index of the first such name. A blank name matches nothing.
pub fn match_custom_fields(page: &CollectedPageDetails, names: &[String]) -> Vec<(u32, usize)> {
    let rules: Vec<Option<Rule>> = names
        .iter()
        .map(|n| (!n.trim().is_empty()).then(|| Rule::parse(n.trim())))
        .collect();
    if rules.iter().all(Option::is_none) {
        return vec![];
    }
    page.fields
        .iter()
        .filter(|f| {
            f.is_fillable() && !NOT_FILLABLE.contains(&f.field_type.as_str()) && !is_search_box(f)
        })
        .filter_map(|f| {
            rules
                .iter()
                .position(|r| r.as_ref().is_some_and(|r| r.matches(f)))
                .map(|i| (f.field_id, i))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(id: u32, name: &str) -> FieldDetails {
        FieldDetails {
            field_id: id,
            field_type: "text".into(),
            html_name: Some(name.into()),
            ..Default::default()
        }
    }

    fn matched(fields: Vec<FieldDetails>, names: &[&str]) -> Vec<(u32, usize)> {
        let page = CollectedPageDetails {
            fields,
            ..Default::default()
        };
        match_custom_fields(
            &page,
            &names.iter().map(|n| n.to_string()).collect::<Vec<_>>(),
        )
    }

    #[test]
    fn names_compare_whole_and_ignore_case() {
        assert_eq!(
            matched(
                vec![field(1, "Customer_PIN"), field(2, "customer_pin_2")],
                &["customer_pin"]
            ),
            [(1, 0)]
        );
    }

    #[test]
    fn every_property_counts() {
        let id = FieldDetails {
            field_id: 1,
            field_type: "text".into(),
            html_id: Some("a".into()),
            ..Default::default()
        };
        let label = FieldDetails {
            field_id: 2,
            field_type: "text".into(),
            label: Some("A\n".into()),
            ..Default::default()
        };
        let before = FieldDetails {
            field_id: 3,
            field_type: "text".into(),
            label_before: Some(" a ".into()),
            ..Default::default()
        };
        let after = FieldDetails {
            field_id: 4,
            field_type: "text".into(),
            label_after: Some("a".into()),
            ..Default::default()
        };
        let aria = FieldDetails {
            field_id: 5,
            field_type: "text".into(),
            label_aria: Some("a".into()),
            ..Default::default()
        };
        let placeholder = FieldDetails {
            field_id: 6,
            field_type: "text".into(),
            placeholder: Some("a".into()),
            ..Default::default()
        };
        assert_eq!(
            matched(vec![id, label, before, after, aria, placeholder], &["a"]).len(),
            6
        );
    }

    #[test]
    fn a_prefix_limits_the_property() {
        let mut both = field(1, "x");
        both.html_id = Some("y".into());
        assert_eq!(matched(vec![both.clone()], &["id=y"]), [(1, 0)]);
        assert!(matched(vec![both.clone()], &["id=x"]).is_empty());
        assert_eq!(matched(vec![both], &["name=x"]), [(1, 0)]);
        // A field can really be called that.
        assert_eq!(matched(vec![field(2, "id=y")], &["id=y"]), [(2, 0)]);
    }

    #[test]
    fn regex_and_csv() {
        assert_eq!(
            matched(
                vec![field(1, "Pin4"), field(2, "pinx")],
                &[r"regex=^PIN\d$"]
            ),
            [(1, 0)]
        );
        assert!(
            matched(vec![field(1, "a")], &["regex=("]).is_empty(),
            "a broken pattern matches nothing"
        );
        assert_eq!(
            matched(vec![field(1, "b"), field(2, "z")], &["csv=a, B ,c"]),
            [(1, 0)]
        );
        assert_eq!(matched(vec![field(1, "x")], &["name=regex=^X$"]), [(1, 0)]);
    }

    #[test]
    fn the_first_name_wins_and_blank_names_keep_their_index() {
        assert_eq!(matched(vec![field(1, "b")], &["", "a", "b", "b"]), [(1, 2)]);
        assert!(matched(vec![field(1, "b")], &[" "]).is_empty());
    }

    #[test]
    fn what_never_takes_a_custom_field() {
        let mut hidden = field(1, "a");
        hidden.is_hidden = true;
        let mut read_only = field(2, "a");
        read_only.is_read_only = true;
        let mut file = field(3, "a");
        file.field_type = "file".into();
        let mut search = field(4, "a");
        search.field_type = "search".into();
        let mut named = field(5, "a");
        named.html_id = Some("siteSearch".into());
        assert!(matched(vec![hidden, read_only, file, search, named], &["a"]).is_empty());
    }
}
