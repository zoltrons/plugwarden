//! Password / passphrase generator. Character sets and option semantics mirror
//! bitwarden-generators (password.rs, passphrase.rs); see upstream-map.yaml.

use bitwarden_crypto::EFF_LONG_WORD_LIST;
use serde_json::{Map, Value};

use crate::api::Result;

const LOWER: &str = "abcdefghijklmnopqrstuvwxyz";
const UPPER: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NUMBER: &str = "0123456789";
const SPECIAL: &str = "!@#$%^&*";
const LOWER_AMBIGUOUS: &str = "l";
const UPPER_AMBIGUOUS: &str = "IO";
const NUMBER_AMBIGUOUS: &str = "01";

/// Uniform integer in `0..n` (rejection sampling, no modulo bias).
fn rand_below(n: u32) -> u32 {
    assert!(n > 0);
    let zone = u32::MAX - (u32::MAX % n);
    loop {
        let mut b = [0u8; 4];
        getrandom::fill(&mut b).expect("CSPRNG available");
        let v = u32::from_le_bytes(b);
        if v < zone {
            return v % n;
        }
    }
}

fn pick(set: &[char]) -> char {
    set[rand_below(set.len() as u32) as usize]
}

fn charset(all: &str, ambiguous: &str, avoid: bool) -> Vec<char> {
    all.chars()
        .filter(|c| !(avoid && ambiguous.contains(*c)))
        .collect()
}

fn opt_bool(o: &Map<String, Value>, k: &str, d: bool) -> bool {
    o.get(k).and_then(Value::as_bool).unwrap_or(d)
}

fn opt_u32(o: &Map<String, Value>, k: &str, d: u32) -> u32 {
    o.get(k)
        .and_then(Value::as_u64)
        .map(|v| v.min(1024) as u32)
        .unwrap_or(d)
}

/// Options (camelCase, all optional): `type` ("password" | "passphrase"),
/// password: `length` (5..=128, default 14), `lowercase`, `uppercase`, `numbers`, `special`,
/// `minLowercase`, `minUppercase`, `minNumber`, `minSpecial`, `avoidAmbiguous`;
/// passphrase: `numWords` (3..=20, default 6), `wordSeparator`, `capitalize`, `includeNumber`.
pub fn generate(options_json: &str) -> Result<String> {
    let v: Value = serde_json::from_str(options_json).map_err(crate::api::err)?;
    let o = v.as_object().cloned().unwrap_or_default();
    match o.get("type").and_then(Value::as_str).unwrap_or("password") {
        "passphrase" => passphrase(&o),
        "password" => password(&o),
        t => Err(format!("unknown generator type {t}")),
    }
}

fn password(o: &Map<String, Value>) -> Result<String> {
    let avoid = opt_bool(o, "avoidAmbiguous", false);
    let sets = [
        (
            opt_bool(o, "lowercase", true),
            charset(LOWER, LOWER_AMBIGUOUS, avoid),
            opt_u32(o, "minLowercase", 1),
        ),
        (
            opt_bool(o, "uppercase", true),
            charset(UPPER, UPPER_AMBIGUOUS, avoid),
            opt_u32(o, "minUppercase", 1),
        ),
        (
            opt_bool(o, "numbers", true),
            charset(NUMBER, NUMBER_AMBIGUOUS, avoid),
            opt_u32(o, "minNumber", 1),
        ),
        (
            opt_bool(o, "special", false),
            charset(SPECIAL, "", avoid),
            opt_u32(o, "minSpecial", 1),
        ),
    ];
    let enabled: Vec<_> = sets.into_iter().filter(|(on, ..)| *on).collect();
    if enabled.is_empty() {
        return Err("at least one character set must be enabled".into());
    }
    let required: u32 = enabled.iter().map(|(_, _, min)| *min).sum();
    let length = opt_u32(o, "length", 14).clamp(5, 128).max(required);

    let all: Vec<char> = enabled
        .iter()
        .flat_map(|(_, set, _)| set.iter().copied())
        .collect();
    let mut out: Vec<char> = enabled
        .iter()
        .flat_map(|(_, set, min)| (0..*min).map(|_| pick(set)))
        .collect();
    out.extend((out.len() as u32..length).map(|_| pick(&all)));
    for i in (1..out.len()).rev() {
        out.swap(i, rand_below(i as u32 + 1) as usize);
    }
    Ok(out.into_iter().collect())
}

fn passphrase(o: &Map<String, Value>) -> Result<String> {
    let n = opt_u32(o, "numWords", 6).clamp(3, 20) as usize;
    let sep = o
        .get("wordSeparator")
        .and_then(Value::as_str)
        .unwrap_or("-");
    let capitalize = opt_bool(o, "capitalize", false);
    let mut words: Vec<String> = (0..n)
        .map(|_| {
            EFF_LONG_WORD_LIST[rand_below(EFF_LONG_WORD_LIST.len() as u32) as usize].to_owned()
        })
        .collect();
    if capitalize {
        for w in &mut words {
            if let Some(f) = w.get_mut(0..1) {
                f.make_ascii_uppercase();
            }
        }
    }
    if opt_bool(o, "includeNumber", false) {
        let i = rand_below(n as u32) as usize;
        words[i].push(char::from(b'0' + rand_below(10) as u8));
    }
    Ok(words.join(sep))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_respects_options() {
        for _ in 0..200 {
            let p = generate(r#"{"length":20,"special":true,"minNumber":3,"minSpecial":2,"avoidAmbiguous":true}"#).unwrap();
            assert_eq!(p.chars().count(), 20);
            assert!(p.chars().filter(char::is_ascii_digit).count() >= 3);
            assert!(p.chars().filter(|c| SPECIAL.contains(*c)).count() >= 2);
            assert!(!p.contains(['l', 'I', 'O', '0', '1']));
        }
    }

    #[test]
    fn password_respects_letter_minimums() {
        for _ in 0..200 {
            let p = generate(r#"{"length":12,"special":false,"minLowercase":5,"minUppercase":4}"#).unwrap();
            assert_eq!(p.chars().count(), 12);
            assert!(p.chars().filter(char::is_ascii_lowercase).count() >= 5);
            assert!(p.chars().filter(char::is_ascii_uppercase).count() >= 4);
        }
    }

    #[test]
    fn passphrase_shape() {
        let p =
            generate(r#"{"type":"passphrase","numWords":4,"wordSeparator":"_","capitalize":true}"#)
                .unwrap();
        let words: Vec<_> = p.split('_').collect();
        assert_eq!(words.len(), 4);
        assert!(
            words
                .iter()
                .all(|w| w.starts_with(|c: char| c.is_ascii_uppercase()))
        );
    }
}
