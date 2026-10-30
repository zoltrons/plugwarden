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
//!
//! Attachment bodies are encrypted with their own key (`attachments[].key`, wrapped like the fields).

use std::str::FromStr;

use base64::{Engine, engine::general_purpose::STANDARD};
use bitwarden_crypto::{
    EncString, KeyDecryptable, KeyEncryptable, OctetStreamBytes, SymmetricCryptoKey,
    SymmetricKeyAlgorithm,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

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
        } else if k == "attachments"
            && let Value::Array(items) = v
        {
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
    Ok(())
}

fn decrypt_str(key: &SymmetricCryptoKey, s: &str) -> Result<Option<String>> {
    // An empty value holds nothing to protect. Anything else must decrypt and authenticate: accepting
    // plain text here would let a compromised server forge vault items.
    if s.is_empty() {
        return Ok(None);
    }
    let enc = EncString::from_str(s).map_err(err)?;
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

/// Sets every login URI's `uriChecksum` (base64 SHA-256 of the URI, bitwarden-vault `generate_checksum`).
/// The official clients drop a URI whose checksum is missing or stale when the cipher has its own key.
fn set_uri_checksums(cipher: &mut Map<String, Value>) {
    let uris = cipher
        .iter_mut()
        .find(|(k, _)| k.eq_ignore_ascii_case("login"))
        .and_then(|(_, login)| login.as_object_mut())
        .and_then(|login| {
            login
                .iter_mut()
                .find(|(k, _)| k.eq_ignore_ascii_case("uris"))
        })
        .and_then(|(_, uris)| uris.as_array_mut());
    for uri in uris.into_iter().flatten().filter_map(Value::as_object_mut) {
        let checksum = str_ci(uri, "uri").map(|u| STANDARD.encode(Sha256::digest(u.as_bytes())));
        uri.retain(|k, _| !k.eq_ignore_ascii_case("uriChecksum"));
        if let Some(checksum) = checksum {
            uri.insert("uriChecksum".into(), checksum.into());
        }
    }
}

pub fn encrypt(s: &Session, cipher: &mut Value) -> Result<()> {
    let obj = cipher.as_object_mut().ok_or("cipher is not an object")?;
    let (base, item) = cipher_keys(s, obj)?;
    let key = item.as_ref().unwrap_or(base);
    set_uri_checksums(obj);
    apply(obj, &mut |v| {
        let enc: EncString = v.encrypt_with_key(key).map_err(err)?;
        Ok(Some(enc.to_string()))
    })
}

/// Decrypts a downloaded attachment body (EncArrayBuffer). `cipher` may be the decrypted or the
/// encrypted cipher JSON: only `organizationId` and the wrapped keys are read.
pub fn decrypt_attachment(s: &Session, cipher: &Value, id: &str, data: &[u8]) -> Result<Vec<u8>> {
    let obj = cipher.as_object().ok_or("cipher is not an object")?;
    let (base, item) = cipher_keys(s, obj)?;
    let att = get_ci(obj, "attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .find(|a| str_ci(a, "id") == Some(id))
        .ok_or("attachment not found")?;
    // shortcut: attachments from before per-attachment keys (no `key`) are not supported; add if a vault has them.
    let wrapped = str_ci(att, "key").ok_or("attachment has no key")?;
    let key = decrypt_symmetric_key(item.as_ref().unwrap_or(base), wrapped)?;
    EncString::from_buffer(data)
        .map_err(err)?
        .decrypt_with_key(&key)
        .map_err(err)
}

/// A new attachment for `cipher`: a fresh key wrapped like the fields, the encrypted file name,
/// and the encrypted body (base64) for POST /api/ciphers/<id>/attachment/v2.
pub fn encrypt_attachment(
    s: &Session,
    cipher: &Value,
    file_name: &str,
    data: &[u8],
) -> Result<Value> {
    let obj = cipher.as_object().ok_or("cipher is not an object")?;
    let (base, item) = cipher_keys(s, obj)?;
    let wrapping = item.as_ref().unwrap_or(base);
    let key = SymmetricCryptoKey::make(SymmetricKeyAlgorithm::Aes256CbcHmac);
    let wrapped = (&OctetStreamBytes::from(key.to_encoded().to_vec()))
        .encrypt_with_key(wrapping)
        .map_err(err)?;
    let name: EncString = file_name
        .to_owned()
        .encrypt_with_key(wrapping)
        .map_err(err)?;
    let body = (&OctetStreamBytes::from(data.to_vec()))
        .encrypt_with_key(&key)
        .map_err(err)?
        .to_buffer()
        .map_err(err)?;
    Ok(
        json!({ "key": wrapped.to_string(), "fileName": name.to_string(), "data": STANDARD.encode(body) }),
    )
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

/// Folders, and collections (whose names use their organization's key).
pub fn decrypt_folders(s: &Session, folders: Vec<Value>) -> Value {
    let mut ok = Vec::with_capacity(folders.len());
    let mut failed = Vec::new();
    for mut f in folders {
        let r = match f.as_object_mut() {
            Some(obj) => {
                let key = match str_ci(obj, "organizationId") {
                    Some(org) => s
                        .orgs
                        .get(&org.to_ascii_lowercase())
                        .ok_or("missing organization key"),
                    None => Ok(&s.user),
                };
                match (
                    key,
                    obj.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case("name")),
                ) {
                    (Ok(key), Some((_, name))) => walk(name, &mut |v| decrypt_str(key, v)),
                    (Err(e), _) => Err(e.into()),
                    (Ok(_), None) => Ok(()),
                }
            }
            None => Err("folder is not an object".into()),
        };
        match r {
            Ok(()) => ok.push(f),
            Err(e) => failed.push(json!({ "id": id_of(&f), "error": e })),
        }
    }
    json!({ "folders": ok, "failed": failed })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use bitwarden_crypto::SymmetricKeyAlgorithm;

    use super::*;

    fn session(orgs: HashMap<String, SymmetricCryptoKey>) -> Session {
        Session {
            user: SymmetricCryptoKey::make(SymmetricKeyAlgorithm::Aes256CbcHmac),
            private: None,
            orgs,
        }
    }

    #[test]
    fn edited_uri_gets_a_fresh_checksum() {
        let s = session(HashMap::new());
        let mut cipher = json!({ "type": 1, "name": "n", "login": { "uris": [
            { "uri": "https://example.com", "uriChecksum": "stale", "match": null },
            { "uri": "https://no-checksum.example" },
        ] } });
        encrypt(&s, &mut cipher).unwrap();
        decrypt(&s, &mut cipher).unwrap();
        // The vector from bitwarden-vault's test_valid_checksum.
        let uris = &cipher["login"]["uris"];
        assert_eq!(
            uris[0]["uriChecksum"],
            "EAaArVRs5qV39C9S3zO0z9ynVoWeZkuNfeMpsVDQnOk="
        );
        assert_eq!(uris[0]["uri"], "https://example.com");
        assert!(uris[1]["uriChecksum"].is_string());
    }

    #[test]
    fn empty_values_pass_and_plain_text_is_refused() {
        let s = session(HashMap::new());
        let mut real = json!({ "type": 1, "name": "n" });
        encrypt(&s, &mut real).unwrap();
        let name = real["name"].clone();

        let mut empty =
            json!({ "type": 1, "name": name, "notes": "", "login": { "username": "" } });
        decrypt(&s, &mut empty).unwrap();
        assert_eq!(empty["name"], "n");
        assert_eq!(empty["login"]["username"], "");

        // A compromised server cannot plant an item it could not encrypt.
        for mut forged in [
            json!({ "type": 1, "name": "forged" }),
            json!({ "type": 1, "name": name, "login": { "password": "forged" } }),
        ] {
            assert!(decrypt(&s, &mut forged).is_err());
        }
    }

    #[test]
    fn organization_cipher_is_encrypted_with_the_organization_key() {
        let org = SymmetricCryptoKey::make(SymmetricKeyAlgorithm::Aes256CbcHmac);
        let editor = session(HashMap::from([("org-1".to_string(), org.clone())]));
        // The id arrives in the server's casing, the key map is lowercase.
        let mut cipher = json!({ "organizationId": "ORG-1", "type": 2, "name": "shared" });
        encrypt(&editor, &mut cipher).unwrap();
        assert_ne!(cipher["name"], "shared");

        // Another member holds the same organization key but a different user key: it decrypts.
        let member = session(HashMap::from([("org-1".to_string(), org)]));
        let mut seen = cipher.clone();
        decrypt(&member, &mut seen).unwrap();
        assert_eq!(seen["name"], "shared");

        // Without the organization key the user key is never used as a fallback.
        let mut orphan = cipher.clone();
        assert!(decrypt(&session(HashMap::new()), &mut orphan).is_err());
        let mut unsaved = json!({ "organizationId": "ORG-1", "type": 2, "name": "shared" });
        assert!(encrypt(&session(HashMap::new()), &mut unsaved).is_err());
    }
}
