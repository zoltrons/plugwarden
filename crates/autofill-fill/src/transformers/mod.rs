pub mod card;

use serde::Serialize;

/// How a value must be rewritten to fit its field. Applied by the executor, which holds the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    /// Spaces and dashes removed: a formatted card number does not fit a narrow field and breaks digit masks.
    Digits,
    /// `12/30` -> `1230`
    ExpCompact,
    /// `12/30` -> `12/2030`
    ExpLong,
    /// `2030` -> `30`
    YearShort,
}
