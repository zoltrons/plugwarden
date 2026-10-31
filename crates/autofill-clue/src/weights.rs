//! Scores. Display text always outweighs code text: a label is written for the user, a name for a build tool.
pub const AC_USERNAME: i32 = 8;
pub const AC_EMAIL: i32 = 6;
pub const TYPE_EMAIL: i32 = 4;
pub const USER_DISPLAY: i32 = 3;
pub const USER_CODE: i32 = 2;
pub const USER_WEAK: i32 = 1;
pub const TYPE_TEL: i32 = 1;

pub const PASS_NOT_NEW: i32 = 10;
pub const AC_CURRENT_PASSWORD: i32 = 20;
pub const PASS_NAMED: i32 = 2;

pub const FORM_HAS_PASSWORD_FORM: i32 = 2;
pub const SIGNUP_FORM_PENALTY: i32 = 12;
pub const USER_BEFORE_PASSWORD: i32 = 6;
pub const ACTIVE_FORM_BONUS: i32 = 1;
pub const PREFER_ACTIVE: i32 = 100;
pub const NEIGHBOUR_BONUS: i32 = 1;
pub const RECIPE: i32 = 1000;

/// Below this a field has not named itself as anything.
pub const THRESHOLD: i32 = 1;
