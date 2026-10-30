//! Bitwarden Send, walked over the raw JSON like ciphers (see `cipher.rs`).
//!
//! Each send has a random 16-byte secret, stored wrapped with the user key in `key`. The content
//! (`name`, `notes`, `text.text`, `file.fileName`, file bytes) is encrypted with
//! `derive_shareable_key(secret, "send", Some("send"))`, and the secret (base64url) is the
//! fragment of the share link. Mirrors sdk-internal `bitwarden-send` (see upstream-map.yaml).

use std::str::FromStr;

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use bitwarden_crypto::{
    EncString, KeyDecryptable, KeyEncryptable, OctetStreamBytes, SymmetricCryptoKey,
    derive_shareable_key, generate_random_bytes, pbkdf2,
};
use serde_json::{Map, Value, json};
use zeroize::Zeroizing;

use crate::api::{Result, Session, err};

/// PBKDF2 rounds for the access password hash (bitwarden-send `SEND_ITERATIONS`).
const SEND_ITERATIONS: u32 = 100_000;

fn get_str<'a>(o: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    o.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .and_then(|(_, v)| v.as_str())
        .filter(|s| !s.is_empty())
}

fn unwrap_secret(s: &Session, wrapped: &str) -> Result<Zeroizing<[u8; 16]>> {
    let bytes: Vec<u8> = EncString::from_str(wrapped)
        .map_err(err)?
        .decrypt_with_key(&s.user)
        .map_err(err)?;
    let secret: [u8; 16] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| "send key is not 16 bytes")?;
    Ok(Zeroizing::new(secret))
}

fn content_key(secret: &Zeroizing<[u8; 16]>) -> SymmetricCryptoKey {
    SymmetricCryptoKey::Aes256CbcHmacKey(derive_shareable_key(secret.clone(), "send", Some("send")))
}

type Leaf<'a> = dyn FnMut(&str) -> Result<String> + 'a;

/// Applies `f` to the encrypted string fields of a send.
fn apply(send: &mut Map<String, Value>, f: &mut Leaf) -> Result<()> {
    for (k, v) in send.iter_mut() {
        let leaf = match (k.to_ascii_lowercase().as_str(), v) {
            ("name" | "notes", v) => Some(v),
            ("text", Value::Object(o)) => o
                .iter_mut()
                .find(|(k, _)| k.eq_ignore_ascii_case("text"))
                .map(|(_, v)| v),
            ("file", Value::Object(o)) => o
                .iter_mut()
                .find(|(k, _)| k.eq_ignore_ascii_case("fileName"))
                .map(|(_, v)| v),
            _ => None,
        };
        if let Some(Value::String(s)) = leaf
            && !s.is_empty()
        {
            *s = f(s)?;
        }
    }
    Ok(())
}

fn decrypt(s: &Session, send: &mut Value) -> Result<()> {
    let obj = send.as_object_mut().ok_or("send is not an object")?;
    let secret = unwrap_secret(s, get_str(obj, "key").ok_or("send has no key")?)?;
    let key = content_key(&secret);
    apply(obj, &mut |v| {
        EncString::from_str(v)
            .map_err(err)?
            .decrypt_with_key(&key)
            .map_err(err)
    })?;
    obj.insert(
        "urlKey".into(),
        URL_SAFE_NO_PAD.encode(secret.as_slice()).into(),
    );
    Ok(())
}

/// Batch decrypt; adds `urlKey` (the link fragment). Failures are reported in `failed`.
pub fn decrypt_list(s: &Session, sends: Vec<Value>) -> Value {
    let mut ok = Vec::with_capacity(sends.len());
    let mut failed = Vec::new();
    for mut send in sends {
        match decrypt(s, &mut send) {
            Ok(()) => ok.push(send),
            Err(e) => failed
                .push(json!({ "id": send.get("id").cloned().unwrap_or(Value::Null), "error": e })),
        }
    }
    json!({ "sends": ok, "failed": failed })
}

/// Encrypts a plaintext send for POST/PUT /api/sends. A new send (no `key`) gets a fresh secret.
/// A plaintext `password` is replaced by its PBKDF2 hash salted with the secret. An edit that keeps the
/// current access password sends none at all: the server keeps the stored one and would hash anything we send.
pub fn encrypt(s: &Session, send: &mut Value) -> Result<()> {
    let obj = send.as_object_mut().ok_or("send is not an object")?;
    obj.retain(|k, _| !k.eq_ignore_ascii_case("urlKey"));
    let secret = match get_str(obj, "key") {
        Some(wrapped) => unwrap_secret(s, wrapped)?,
        None => {
            let secret = generate_random_bytes::<[u8; 16]>();
            let wrapped = (&OctetStreamBytes::from(secret.to_vec()))
                .encrypt_with_key(&s.user)
                .map_err(err)?;
            obj.insert("key".into(), wrapped.to_string().into());
            secret
        }
    };
    let key = content_key(&secret);
    apply(obj, &mut |v| {
        Ok(v.encrypt_with_key(&key).map_err(err)?.to_string())
    })?;
    let typed = get_str(obj, "password").map(str::to_owned);
    obj.retain(|k, _| !k.eq_ignore_ascii_case("password"));
    if let Some(password) = typed {
        let hash = pbkdf2(password.as_bytes(), secret.as_slice(), SEND_ITERATIONS);
        obj.insert("password".into(), STANDARD.encode(hash).into());
    }
    Ok(())
}

/// Encrypts file content for upload (EncArrayBuffer layout) with the send's content key.
pub fn encrypt_file(s: &Session, wrapped_key: &str, data: &[u8]) -> Result<Vec<u8>> {
    let key = content_key(&unwrap_secret(s, wrapped_key)?);
    (&OctetStreamBytes::from(data.to_vec()))
        .encrypt_with_key(&key)
        .map_err(err)?
        .to_buffer()
        .map_err(err)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use bitwarden_crypto::{EncString, KeyDecryptable, SymmetricKeyAlgorithm};

    use super::*;

    #[test]
    fn roundtrip_text_and_file_send() {
        let s = Session {
            user: SymmetricCryptoKey::make(SymmetricKeyAlgorithm::Aes256CbcHmac),
            private: None,
            orgs: HashMap::new(),
        };
        let mut send = json!({ "type": 0, "name": "hello", "text": { "text": "secret", "hidden": true }, "password": "pw" });
        encrypt(&s, &mut send).unwrap();
        assert_ne!(send["name"], "hello");
        assert_ne!(send["text"]["text"], "secret");
        assert_eq!(send["password"].as_str().unwrap().len(), 44); // base64 of 32 bytes
        let wrapped = send["key"].as_str().unwrap().to_owned();

        let out = decrypt_list(&s, vec![send]);
        let d = &out["sends"][0];
        assert_eq!(
            (d["name"].as_str(), d["text"]["text"].as_str()),
            (Some("hello"), Some("secret"))
        );
        let secret = URL_SAFE_NO_PAD
            .decode(d["urlKey"].as_str().unwrap())
            .unwrap();
        assert_eq!(secret.len(), 16);

        let buf = encrypt_file(&s, &wrapped, b"file bytes").unwrap();
        let key = content_key(&Zeroizing::new(secret.try_into().unwrap()));
        let plain: Vec<u8> = EncString::from_buffer(&buf)
            .unwrap()
            .decrypt_with_key(&key)
            .unwrap();
        assert_eq!(plain, b"file bytes");
    }

    #[test]
    fn edit_without_a_new_password_sends_none() {
        let s = Session {
            user: SymmetricCryptoKey::make(SymmetricKeyAlgorithm::Aes256CbcHmac),
            private: None,
            orgs: HashMap::new(),
        };
        let mut send = json!({ "type": 0, "name": "n", "text": { "text": "t" }, "password": "pw" });
        encrypt(&s, &mut send).unwrap();
        let hash = send["password"].as_str().unwrap().to_owned();
        // An edit that does not retype the password carries none: the server keeps the stored one.
        let mut edit = json!({ "type": 0, "name": "n2", "text": { "text": "t" } });
        encrypt(&s, &mut edit).unwrap();
        assert!(edit.get("password").is_none());
        assert_ne!(edit["name"], "n2", "content is still encrypted");
        // A newly typed password is hashed once, never passed through.
        let mut retyped =
            json!({ "type": 0, "name": "n3", "text": { "text": "t" }, "password": "pw2" });
        encrypt(&s, &mut retyped).unwrap();
        let new = retyped["password"].as_str().unwrap();
        assert_ne!(new, "pw2");
        assert_ne!(new, hash.as_str());
        assert_eq!(new.len(), 44);
    }
}
