//! Rules that read a field's text, and the classification they add up to.
use crate::weights::*;
use autofill_cpd::FieldDetails;
use autofill_designation::AutofillType;
use regex_lite::Regex;
use std::sync::LazyLock;

/// How a clue compares. Text is lower-cased before it gets here.
#[derive(Debug, Clone, Copy)]
pub enum Op {
    Exact,
    Contains,
    StartsWith,
    EndsWith,
    Word,
}

pub struct Clue<'a>(pub Op, pub &'a str);

impl Clue<'_> {
    pub fn matches(&self, text: &str) -> bool {
        let Clue(op, p) = self;
        match op {
            Op::Exact => text == *p,
            Op::Contains => text.contains(p),
            Op::StartsWith => text.starts_with(p),
            Op::EndsWith => text.ends_with(p),
            Op::Word => text.split(|c: char| !c.is_alphanumeric()).any(|w| w == *p),
        }
    }
}

/// A compiled-once regular expression; the sixth operator next to `Op`.
pub struct Rule(LazyLock<Regex>);

impl Rule {
    pub const fn new(init: fn() -> Regex) -> Self {
        Self(LazyLock::new(init))
    }

    pub fn test(&self, text: &str) -> bool {
        self.0.is_match(text)
    }
}

macro_rules! rule {
    ($name:ident, $re:literal) => {
        pub static $name: Rule = Rule::new(|| Regex::new($re).expect("valid pattern"));
    };
}

rule!(
    OTP,
    r"one.?time|otp|totp|2fa|mfa|verification|confirmation.?code|security.?code|captcha"
);
rule!(
    STANDALONE_OTP,
    r"one.?time|otp|totp|2fa|mfa|verification.?code|authenticator|doğrulama.?kodu"
);
rule!(CAPTCHA, r"captcha");
rule!(
    SKIP,
    r"search|(^|\s)q(\s|$)|query|newsletter|subscribe|promo|coupon|discount|voucher|gift.?card|quantity"
);
rule!(
    HONEYPOT,
    r"honeypot|(^|\W)hp_|leave.?(this.?)?(field.?)?(blank|empty)|do.?not.?fill"
);
rule!(
    USER,
    r"user|logon|login|sign.?in|e-?mail|mail|account|acct|identifier|customer|member|client|usr|uname|handle|nick|correo|benutzer|usuario|utilisateur|utente|gebruiker|kullan[iı]c[iı]|e-?posta"
);
rule!(PASS, r"pass|pwd|pin|parola|[sş]ifre");
rule!(
    NEW,
    r"new|confirm|repeat|retype|regis|sign.?up|create|join|yeni|tekrar"
);
rule!(CONFIRM, r"confirm|repeat|retype|again|verify|tekrar");
rule!(
    SIGNUP_TEXT,
    r"sign.?up|register|create.?account|new.?account|join now"
);
rule!(
    SIGNUP_ATTRS,
    r"sign.?up|regist|create.?(an.?|your.?)?account|new.?account|join|kay[iı]t|kaydol|üye ol|hesap oluştur"
);
rule!(NEWSLETTER, r"newsletter|subscribe|bülten");
rule!(
    CHANGE_EMAIL,
    r"change.?e-?mail|new.?e-?mail|update.?e-?mail"
);
rule!(SSH_KEY, r"ssh.?key|public.?key");
rule!(
    MENU_CARD,
    r"card.?num|cc.?num|cvc|cvv|csc|card.?holder|expir"
);
rule!(
    MENU_LOGIN,
    r"user|login|e-?mail|account|kullan[iı]c[iı]|e-?posta"
);

/// The HTML token a field's text points at. First match wins, so the order matters.
pub static FORM_RULES: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    [
        (
            "cc-number",
            r"card.?(num|number)|cc.?(num|number)|cardnumber",
        ),
        ("cc-csc", r"cvc|cvv|csc|security.?code"),
        ("cc-name", r"card.?holder|name.?(on|of).?card|cc.?name"),
        ("cc-exp-month", r"exp.*(month|\bmm\b)|(^|\W)month"),
        ("cc-exp-year", r"exp.*(year|\byy|yyyy)|(^|\W)year"),
        (
            "cc-exp",
            r"expir|exp.?(date|iration)|valid.?thru|\bmm.?(yy|yyyy)\b",
        ),
        ("cc-type", r"card.?type|brand"),
        ("given-name", r"first.?name|fname|given"),
        ("additional-name", r"middle.?name|mname"),
        ("family-name", r"last.?name|lname|surname|family"),
        ("name", r"full.?name|(^|\W)name($|\W)|your.?name"),
        ("email", r"e-?mail"),
        ("tel", r"phone|mobile|tel\b"),
        ("organization", r"company|organi[sz]ation"),
        ("address-line1", r"address.?(1|line.?1)|street"),
        ("street-address", r"street|address"),
        ("address-level2", r"city|town"),
        ("address-level1", r"state|province|region|county"),
        ("postal-code", r"zip|postal|postcode"),
        ("country", r"country"),
    ]
    .into_iter()
    .map(|(token, re)| (token, Regex::new(re).expect("valid pattern")))
    .collect()
});

const WEAK_USER: &[&str] = &["username", "email", "userid", "login"];
const WEAK_AVOID: &[&str] = &[
    "search", "coupon", "promo", "voucher", "discount", "captcha", "honeypot",
];

/// Whole-word match in class and data-* text: `user-select-none` must not make a username.
pub fn weak_word(field: &FieldDetails, words: &[&str]) -> bool {
    let weak = field.weak_code_text();
    words.iter().any(|w| Clue(Op::Word, w).matches(&weak))
}

/// A box no account value belongs in (Pass 6): search, coupon, captcha, honeypot or a one-time code.
pub fn is_avoided(field: &FieldDetails) -> bool {
    let hint = field.hint();
    field.field_type == "search"
        || SKIP.test(&hint)
        || OTP.test(&hint)
        || HONEYPOT.test(&hint)
        || weak_word(field, WEAK_AVOID)
}

pub fn is_textish(field: &FieldDetails) -> bool {
    matches!(field.field_type.as_str(), "text" | "email" | "tel" | "")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginKind {
    None,
    /// Names itself as an account field.
    User,
    /// Plain text: an account field only by its place next to a password.
    Text,
    Pass,
    New,
}

/// Pass 2 for one field: its role in a login, how strongly it claims that, and its type.
pub fn classify(field: &FieldDetails) -> (LoginKind, i32, AutofillType) {
    let hint = field.hint();
    if field.is_password() {
        let current = field.has_autocomplete("current-password");
        let fresh = field.has_autocomplete("new-password") || (!current && NEW.test(&hint));
        let weight = if fresh { 0 } else { PASS_NOT_NEW }
            + if current { AC_CURRENT_PASSWORD } else { 0 }
            + if PASS.test(&hint) { PASS_NAMED } else { 0 };
        return if fresh {
            (LoginKind::New, weight, AutofillType::NewPassword)
        } else {
            (LoginKind::Pass, weight, AutofillType::CurrentPassword)
        };
    }
    let ty = declared_type(field, &hint);
    if !is_textish(field) {
        return (LoginKind::None, 0, ty);
    }
    let display = field.display_text();
    let code = field.code_text();
    let named = if USER.test(&display) {
        USER_DISPLAY
    } else if USER.test(&code) {
        USER_CODE
    } else if weak_word(field, WEAK_USER) {
        USER_WEAK
    } else {
        0
    };
    let weight = if field.has_autocomplete("username") {
        AC_USERNAME
    } else {
        0
    } + if field.has_autocomplete("email") {
        AC_EMAIL
    } else {
        0
    } + if field.field_type == "email" {
        TYPE_EMAIL
    } else {
        0
    } + named
        + if field.field_type == "tel" {
            TYPE_TEL
        } else {
            0
        };
    if weight >= THRESHOLD {
        let ty = if ty == AutofillType::None {
            AutofillType::Username
        } else {
            ty
        };
        (LoginKind::User, weight, ty)
    } else {
        (LoginKind::Text, 0, ty)
    }
}

/// The type a field declares or its text suggests, ignoring its role in a login.
fn declared_type(field: &FieldDetails, hint: &str) -> AutofillType {
    if let Some(token) = field.autocomplete_tokens().last() {
        let ty = AutofillType::from_token(token);
        if ty != AutofillType::None {
            return ty;
        }
    }
    if STANDALONE_OTP.test(hint) && !CAPTCHA.test(hint) {
        return AutofillType::OneTimeCode;
    }
    FORM_RULES
        .iter()
        .find(|(_, re)| re.is_match(hint))
        .map_or(AutofillType::None, |(token, _)| {
            AutofillType::from_token(token)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(ty: &str, name: &str) -> FieldDetails {
        FieldDetails {
            field_type: ty.into(),
            html_name: Some(name.into()),
            ..Default::default()
        }
    }

    #[test]
    fn operators() {
        assert!(Clue(Op::Exact, "a").matches("a") && !Clue(Op::Exact, "a").matches("ab"));
        assert!(Clue(Op::Contains, "b").matches("abc"));
        assert!(
            Clue(Op::StartsWith, "a").matches("abc") && !Clue(Op::StartsWith, "b").matches("abc")
        );
        assert!(Clue(Op::EndsWith, "c").matches("abc"));
        assert!(
            Clue(Op::Word, "user").matches("the user-name")
                && !Clue(Op::Word, "user").matches("username")
        );
        assert!(SKIP.test(" q ") && !SKIP.test("faq"));
    }

    #[test]
    fn display_text_outweighs_code_text() {
        let display = FieldDetails {
            field_type: "text".into(),
            label: Some("Username".into()),
            ..Default::default()
        };
        let (_, by_display, _) = classify(&display);
        let (_, by_code, _) = classify(&field("text", "username"));
        assert!(by_display > by_code && by_code > 0);
    }

    #[test]
    fn class_only_counts_as_a_whole_word() {
        let mut f = field("text", "x");
        f.html_class = Some("user-select-none login-box".into());
        assert_eq!(classify(&f).0, LoginKind::User);
        f.html_class = Some("user-select-none".into());
        assert_eq!(classify(&f).0, LoginKind::Text);
    }

    #[test]
    fn passwords() {
        let mut f = field("password", "password");
        assert_eq!(classify(&f).2, AutofillType::CurrentPassword);
        f.autocomplete_type = Some("new-password".into());
        assert_eq!(classify(&f).0, LoginKind::New);
    }

    #[test]
    fn avoided_boxes() {
        for name in ["q", "search", "discount_code", "voucher", "g-captcha"] {
            assert!(is_avoided(&field("text", name)), "{name}");
        }
        assert!(!is_avoided(&field("text", "faq-author")));
        assert!(is_avoided(&FieldDetails {
            field_type: "search".into(),
            ..Default::default()
        }));
    }
}
