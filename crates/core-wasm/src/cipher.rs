//! Cipher field walking over the raw sync JSON.
//!
//! We do not model ciphers as Rust structs (that is what pulled bitwarden-vault and
//! bitwarden-core in). Instead we walk `serde_json::Value`, which keeps unknown fields intact
//! and is case-insensitive on keys (Vaultwarden mixes camelCase/PascalCase in places).
//!
//! Encrypted fields, mirrored from bitwarden-vault's cipher models (see upstream-map.yaml):
//! - top level: `name`, `notes`
//! - containers whose string leaves are all encrypted, except `PLAIN_KEYS`:
//!   `login` (incl. `uris[]`, `fido2Credentials[]`), `card`, `identity`, `secureNote`, `sshKey`,
//!   `bankAccount`, `driversLicense`, `passport`, `fields[]`, `passwordHistory[]`
//! - `attachments[].fileName`
//! - `key` (cipher key): an EncString wrapping a symmetric key, used for all of the above.

use std::str::FromStr;

use bitwarden_crypto::{EncString, KeyDecryptable, KeyEncryptable, SymmetricCryptoKey};
use serde_json::{Map, Value, json};

use crate::api::{Result, Session, decrypt_symmetric_key, err};

const CONTAINERS: &[&str] = &[
    "login",
    "card",
    "identity",
    "securenote",
    "sshkey",
    "bankaccount",
    "driverslicense",
    "passport",
    "fields",
    "passwordhistory",
];

/// Keys inside encrypted containers whose values are never encrypted.
const PLAIN_KEYS: &[&str] = &[
    "type",
    "match",
    "linkedid",
    "passwordrevisiondate",
    "lastuseddate",
    "creationdate",
    "autofillonpageload",
    "response",
    "key",
];

fn get_ci<'a>(obj: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    obj.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v)
}

fn str_ci<'a>(obj: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    get_ci(obj, name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// The keys a cipher's fields are encrypted with: (org or user key, decrypted cipher key).
/// Fields use the cipher key when present, otherwise the org/user key.
fn cipher_keys<'a>(
    s: &'a Session,
    obj: &Map<String, Value>,
) -> Result<(&'a SymmetricCryptoKey, Option<SymmetricCryptoKey>)> {
    let base = match str_ci(obj, "organizationId") {
        Some(org) => s
            .orgs
            .get(&org.to_ascii_lowercase())
            .ok_or("missing organization key")?,
        None => &s.user,
    };
    let item = str_ci(obj, "key")
        .map(|k| decrypt_symmetric_key(base, k))
        .transpose()?;
    Ok((base, item))
}

type Leaf<'a> = dyn FnMut(&str) -> Result<Option<String>> + 'a;

/// Applies `f` to every string leaf of an encrypted container.
fn walk(v: &mut Value, f: &mut Leaf) -> Result<()> {
    match v {
        Value::String(s) => {
            if let Some(out) = f(s)? {
                *s = out;
            }
        }
        Value::Array(items) => items.iter_mut().try_for_each(|i| walk(i, f))?,
        Value::Object(obj) => {
            for (k, child) in obj.iter_mut() {
                if !PLAIN_KEYS.iter().any(|p| k.eq_ignore_ascii_case(p)) {
                    walk(child, f)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn apply(obj: &mut Map<String, Value>, f: &mut Leaf) -> Result<()> {
    for (k, v) in obj.iter_mut() {
        let k = k.to_ascii_lowercase();
        if k == "name" || k == "notes" || CONTAINERS.contains(&k.as_str()) {
            walk(v, f)?;
        } else if k == "attachments" {
            if let Value::Array(items) = v {
                for a in items.iter_mut().filter_map(Value::as_object_mut) {
                    if let Some((_, name)) = a
                        .iter_mut()
                        .find(|(k, _)| k.eq_ignore_ascii_case("fileName"))
                    {
                        walk(name, f)?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn decrypt_str(key: &SymmetricCryptoKey, s: &str) -> Result<Option<String>> {
    // Leaves that are not EncStrings (e.g. dates in new item types) are left untouched.
    let Ok(enc) = EncString::from_str(s) else {
        return Ok(None);
    };
    let plain: String = enc.decrypt_with_key(key).map_err(err)?;
    Ok(Some(plain))
}

pub fn decrypt(s: &Session, cipher: &mut Value) -> Result<()> {
    let obj = cipher.as_object_mut().ok_or("cipher is not an object")?;
    let (base, item) = cipher_keys(s, obj)?;
    let key = item.as_ref().unwrap_or(base);
    // `data` is Vaultwarden's legacy duplicate of the typed fields; drop it from the plaintext view.
    obj.retain(|k, _| !k.eq_ignore_ascii_case("data"));
    apply(obj, &mut |v| decrypt_str(key, v))
}

pub fn encrypt(s: &Session, cipher: &mut Value) -> Result<()> {
    let obj = cipher.as_object_mut().ok_or("cipher is not an object")?;
    let (base, item) = cipher_keys(s, obj)?;
    let key = item.as_ref().unwrap_or(base);
    apply(obj, &mut |v| {
        let enc: EncString = v.encrypt_with_key(key).map_err(err)?;
        Ok(Some(enc.to_string()))
    })
}

fn id_of(v: &Value) -> Value {
    v.as_object()
        .and_then(|o| get_ci(o, "id"))
        .cloned()
        .unwrap_or(Value::Null)
}

/// Batch decrypt. One bad cipher does not fail the batch; it is reported in `failed`.
pub fn decrypt_list(s: &Session, ciphers: Vec<Value>) -> Value {
    let mut ok = Vec::with_capacity(ciphers.len());
    let mut failed = Vec::new();
    for mut c in ciphers {
        match decrypt(s, &mut c) {
            Ok(()) => ok.push(c),
            Err(e) => failed.push(json!({ "id": id_of(&c), "error": e })),
        }
    }
    json!({ "ciphers": ok, "failed": failed })
}

pub fn decrypt_folders(s: &Session, folders: Vec<Value>) -> Value {
    let mut ok = Vec::with_capacity(folders.len());
    let mut failed = Vec::new();
    for mut f in folders {
        let r = match f.as_object_mut() {
            Some(obj) => match obj.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case("name")) {
                Some((_, name)) => walk(name, &mut |v| decrypt_str(&s.user, v)),
                None => Ok(()),
            },
            None => Err("folder is not an object".into()),
        };
        match r {
            Ok(()) => ok.push(f),
            Err(e) => failed.push(json!({ "id": id_of(&f), "error": e })),
        }
    }
    json!({ "folders": ok, "failed": failed })
}
