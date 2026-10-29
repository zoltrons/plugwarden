//! TOTP (RFC 6238) with Bitwarden's input formats: raw base32 secret, `otpauth://totp/...`
//! and `steam://<secret>`. Behaviour mirrors bitwarden-vault/src/totp.rs (see upstream-map.yaml).

use hmac::{Hmac, KeyInit, Mac};
use serde_json::json;

use crate::api::Result;

const STEAM_CHARS: &[u8] = b"23456789BCDFGHJKMNPQRTVWXY";
const DEFAULT_DIGITS: u32 = 6;
const DEFAULT_PERIOD: u32 = 30;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Algorithm {
    Sha1,
    Sha256,
    Sha512,
    Steam,
}

#[derive(Debug, PartialEq)]
struct Params {
    secret: Vec<u8>,
    algorithm: Algorithm,
    digits: u32,
    period: u32,
}

fn decode_b32(s: &str) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.bytes().filter(|c| !matches!(c, b' ' | b'-' | b'=')) {
        let v = match c.to_ascii_uppercase() {
            c @ b'A'..=b'Z' => c - b'A',
            c @ b'2'..=b'7' => c - b'2' + 26,
            _ => return Err("invalid base32 secret".into()),
        };
        buf = (buf << 5) | u32::from(v);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    if out.is_empty() {
        return Err("empty secret".into());
    }
    Ok(out)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        match (
            b[i],
            b.get(i + 1).copied().and_then(hex),
            b.get(i + 2).copied().and_then(hex),
        ) {
            (b'%', Some(h), Some(l)) => {
                out.push((h * 16 + l) as u8);
                i += 3;
            }
            (b'+', ..) => {
                out.push(b' ');
                i += 1;
            }
            (c, ..) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse(input: &str) -> Result<Params> {
    let input = input.trim();
    let lower = input.to_ascii_lowercase();
    if lower.starts_with("otpauth://") {
        let query = input.split_once('?').map(|(_, q)| q).unwrap_or("");
        let mut p = Params {
            secret: Vec::new(),
            algorithm: Algorithm::Sha1,
            digits: DEFAULT_DIGITS,
            period: DEFAULT_PERIOD,
        };
        let mut secret = None;
        for pair in query.split('&') {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let v = percent_decode(v);
            match k.to_ascii_lowercase().as_str() {
                "secret" => secret = Some(v),
                "algorithm" => {
                    p.algorithm = match v.to_ascii_lowercase().as_str() {
                        "sha256" => Algorithm::Sha256,
                        "sha512" => Algorithm::Sha512,
                        _ => Algorithm::Sha1,
                    }
                }
                // Same clamping as upstream: digits 1..=10, period >= 1.
                "digits" => {
                    p.digits = v
                        .parse::<u32>()
                        .map(|d| d.clamp(1, 10))
                        .unwrap_or(DEFAULT_DIGITS)
                }
                "period" => {
                    p.period = v
                        .parse::<u32>()
                        .ok()
                        .filter(|&n| n > 0)
                        .unwrap_or(DEFAULT_PERIOD)
                }
                _ => {}
            }
        }
        p.secret = decode_b32(&secret.ok_or("otpauth URI has no secret")?)?;
        Ok(p)
    } else if lower.starts_with("steam://") {
        Ok(Params {
            secret: decode_b32(&input[8..])?,
            algorithm: Algorithm::Steam,
            digits: 5,
            period: DEFAULT_PERIOD,
        })
    } else {
        Ok(Params {
            secret: decode_b32(input)?,
            algorithm: Algorithm::Sha1,
            digits: DEFAULT_DIGITS,
            period: DEFAULT_PERIOD,
        })
    }
}

macro_rules! hmac {
    ($digest:ty, $key:expr, $msg:expr) => {{
        let mut mac = Hmac::<$digest>::new_from_slice($key).expect("HMAC accepts any key length");
        mac.update($msg);
        mac.finalize().into_bytes().to_vec()
    }};
}

fn code_at(p: &Params, unix_secs: u64) -> String {
    let counter = (unix_secs / u64::from(p.period)).to_be_bytes();
    let h = match p.algorithm {
        Algorithm::Sha1 | Algorithm::Steam => hmac!(sha1::Sha1, &p.secret, &counter),
        Algorithm::Sha256 => hmac!(sha2::Sha256, &p.secret, &counter),
        Algorithm::Sha512 => hmac!(sha2::Sha512, &p.secret, &counter),
    };
    let off = (h[h.len() - 1] & 0x0f) as usize;
    let bin = u32::from_be_bytes([h[off] & 0x7f, h[off + 1], h[off + 2], h[off + 3]]);
    if p.algorithm == Algorithm::Steam {
        let mut v = bin;
        (0..p.digits)
            .map(|_| {
                let c = STEAM_CHARS[(v as usize) % STEAM_CHARS.len()] as char;
                v /= STEAM_CHARS.len() as u32;
                c
            })
            .collect()
    } else {
        let code = u64::from(bin) % 10u64.pow(p.digits);
        format!("{code:0width$}", width = p.digits as usize)
    }
}

/// Returns `{"code": "...", "period": 30, "remaining": n}`.
pub fn totp(input: &str, unix_ms: f64) -> Result<String> {
    let p = parse(input)?;
    let secs = (unix_ms.max(0.0) / 1000.0) as u64;
    let remaining = u64::from(p.period) - secs % u64::from(p.period);
    Ok(
        json!({ "code": code_at(&p, secs), "period": p.period, "remaining": remaining })
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 Appendix B secrets ("12345678901234567890" repeated to the hash length).
    const S1: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const S256: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
    const S512: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA";

    fn rfc(secret: &str, alg: &str, t: u64) -> String {
        let p = parse(&format!(
            "otpauth://totp/x?secret={secret}&algorithm={alg}&digits=8"
        ))
        .unwrap();
        code_at(&p, t)
    }

    #[test]
    fn rfc6238_vectors() {
        assert_eq!(rfc(S1, "SHA1", 59), "94287082");
        assert_eq!(rfc(S256, "SHA256", 59), "46119246");
        assert_eq!(rfc(S512, "SHA512", 59), "90693936");
        assert_eq!(rfc(S1, "SHA1", 1111111109), "07081804");
        assert_eq!(rfc(S256, "SHA256", 20000000000), "77737706");
        assert_eq!(rfc(S512, "SHA512", 2000000000), "38618901");
    }

    #[test]
    fn raw_secret_defaults() {
        let p = parse("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").unwrap();
        assert_eq!((p.digits, p.period, p.algorithm), (6, 30, Algorithm::Sha1));
        assert_eq!(code_at(&p, 59), "287082");
    }

    #[test]
    fn steam_is_five_chars_from_alphabet() {
        let p = parse(&format!("steam://{S1}")).unwrap();
        let c = code_at(&p, 59);
        assert_eq!(c.len(), 5);
        assert!(c.bytes().all(|b| STEAM_CHARS.contains(&b)));
    }
}
