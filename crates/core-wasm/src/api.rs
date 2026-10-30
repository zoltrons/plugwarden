//! Pure-Rust API behind the wasm-bindgen surface in `lib.rs`. Errors are plain strings so the
//! same functions run in native tests.
//!
//! State model: the master key exists only between `derive_master_key` and `unlock_user_key`
//! (addressed by an opaque handle). After unlock, a single `Session` holds the user key, the RSA
//! private key and organization keys. `lock()` drops everything; bitwarden-crypto's zeroizing
//! global allocator wipes freed memory.

use std::{cell::RefCell, collections::HashMap, num::NonZeroU32, str::FromStr};

use base64::{Engine, engine::general_purpose::STANDARD};
use bitwarden_crypto::{
    BitwardenLegacyKeyBytes, EncString, HashPurpose, Kdf, KeyDecryptable, KeyEncryptable, MasterKey, PinKey,
    Pkcs8PrivateKeyBytes, PrivateKey, SymmetricCryptoKey, UnsignedSharedKey,
    derive_symmetric_key_from_prf,
};
use serde_json::Value;

pub type Result<T> = std::result::Result<T, String>;

pub(crate) fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub struct Session {
    pub user: SymmetricCryptoKey,
    pub private: Option<PrivateKey>,
    pub orgs: HashMap<String, SymmetricCryptoKey>,
}

thread_local! {
    static MASTER_KEYS: RefCell<(u32, HashMap<u32, MasterKey>)> = RefCell::new((0, HashMap::new()));
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

/// Bitwarden KdfType: 0 = PBKDF2-SHA256, 1 = Argon2id (memory in MiB).
///
/// The server supplies these numbers, so they are range-checked like the official clients do: a server
/// that answers `iterations: 1` would get a master-password hash that is cheap to brute-force, and a
/// huge value would hang or exhaust the worker.
pub fn kdf_from_params(kind: u8, iterations: u32, memory: u32, parallelism: u32) -> Result<Kdf> {
    let in_range = |v: u32, min: u32, max: u32, what: &str| {
        if !(min..=max).contains(&v) {
            return Err(format!("KDF {what} must be between {min} and {max}, the server sent {v}"));
        }
        Ok(NonZeroU32::new(v).expect("min is at least 1"))
    };
    match kind {
        0 => Ok(Kdf::PBKDF2 {
            iterations: in_range(iterations, 5_000, 2_000_000, "iterations")?,
        }),
        1 => Ok(Kdf::Argon2id {
            iterations: in_range(iterations, 2, 10, "iterations")?,
            memory: in_range(memory, 15, 1024, "memory")?,
            parallelism: in_range(parallelism, 1, 16, "parallelism")?,
        }),
        k => Err(format!("unsupported kdf type {k}")),
    }
}

pub fn derive_master_key(password: &str, email: &str, kdf: &Kdf) -> Result<u32> {
    let key = MasterKey::derive(password, email, kdf).map_err(err)?;
    Ok(MASTER_KEYS.with_borrow_mut(|(next, keys)| {
        *next = next.wrapping_add(1);
        keys.insert(*next, key);
        *next
    }))
}

fn with_master<T>(handle: u32, f: impl FnOnce(&MasterKey) -> Result<T>) -> Result<T> {
    MASTER_KEYS.with_borrow(|(_, keys)| f(keys.get(&handle).ok_or("unknown master key handle")?))
}

pub fn free_master_key(handle: u32) {
    MASTER_KEYS.with_borrow_mut(|(_, keys)| keys.remove(&handle));
}

pub fn make_auth_hash(handle: u32, password: &str, local: bool) -> Result<String> {
    let purpose = if local {
        HashPurpose::LocalAuthorization
    } else {
        HashPurpose::ServerAuthorization
    };
    with_master(handle, |mk| {
        Ok(mk
            .derive_master_key_hash(password.as_bytes(), purpose)
            .to_string())
    })
}

/// Decrypts the protected user key (and optional RSA private key) and opens the session.
/// Consumes the master key handle on success.
pub fn unlock_user_key(
    handle: u32,
    protected_user_key: &str,
    encrypted_private_key: Option<&str>,
) -> Result<()> {
    let user = with_master(handle, |mk| {
        mk.decrypt_user_key(EncString::from_str(protected_user_key).map_err(err)?)
            .map_err(err)
    })?;
    open_session(user, encrypted_private_key)?;
    free_master_key(handle);
    Ok(())
}

/// Bitwarden PIN unlock: the user key wrapped with a `PinKey` (the PIN through the account KDF,
/// salted with the email). Needs an unlocked session.
pub fn pin_protect_user_key(pin: &str, email: &str, kdf: &Kdf) -> Result<String> {
    let pin_key = PinKey::derive(pin.as_bytes(), email.as_bytes(), kdf).map_err(err)?;
    with_session(|s| Ok(pin_key.encrypt_user_key(&s.user).map_err(err)?.to_string()))
}

/// Opens the session from a user key wrapped by `pin_protect_user_key`. A wrong PIN fails the MAC.
pub fn unlock_with_pin(
    pin: &str,
    email: &str,
    kdf: &Kdf,
    pin_protected_user_key: &str,
    encrypted_private_key: Option<&str>,
) -> Result<()> {
    let pin_key = PinKey::derive(pin.as_bytes(), email.as_bytes(), kdf).map_err(err)?;
    let user = pin_key
        .decrypt_user_key(EncString::from_str(pin_protected_user_key).map_err(err)?)
        .map_err(err)?;
    open_session(user, encrypted_private_key)
}

/// Wraps the unlocked user key with a key derived from a WebAuthn PRF output.
/// The PRF secret never leaves the authenticator; only its stable 32-byte output is used
/// (bitwarden-crypto `derive_symmetric_key_from_prf`, the same primitive the SDK uses for
/// passkey-based key sets). The wrapped key is safe to keep in local storage.
pub fn prf_protect_user_key(prf_b64: &str) -> Result<String> {
    let prf = STANDARD.decode(prf_b64).map_err(err)?;
    let key = derive_symmetric_key_from_prf(&prf).map_err(|_| "invalid PRF output")?;
    with_session(|s| {
        // The legacy key encoding as text, encrypted under the PRF-derived key. (bitwarden-crypto
        // has a key-typed encoder for this; going through String keeps the wrapper minimal.)
        let encoded = STANDARD.encode(s.user.to_encoded().to_vec());
        encoded
            .encrypt_with_key(&key)
            .map_err(err)
            .map(|wrapped| wrapped.to_string())
    })
}

/// Opens the session from a user key wrapped by `prf_protect_user_key`. A different or zero PRF
/// fails the MAC (or is refused before that).
pub fn unlock_with_prf(
    prf_b64: &str,
    protected_user_key: &str,
    encrypted_private_key: Option<&str>,
) -> Result<()> {
    let prf = STANDARD.decode(prf_b64).map_err(err)?;
    let key = derive_symmetric_key_from_prf(&prf).map_err(|_| "invalid PRF output")?;
    let encoded: String = EncString::from_str(protected_user_key)
        .map_err(err)?
        .decrypt_with_key(&key)
        .map_err(err)?;
    let bytes = STANDARD.decode(encoded).map_err(err)?;
    let user = SymmetricCryptoKey::try_from(&BitwardenLegacyKeyBytes::from(bytes)).map_err(err)?;
    open_session(user, encrypted_private_key)
}

fn open_session(user: SymmetricCryptoKey, encrypted_private_key: Option<&str>) -> Result<()> {
    let private = match encrypted_private_key {
        Some(s) if !s.is_empty() => {
            let der: Vec<u8> = EncString::from_str(s)
                .map_err(err)?
                .decrypt_with_key(&user)
                .map_err(err)?;
            Some(PrivateKey::from_der(&Pkcs8PrivateKeyBytes::from(der)).map_err(err)?)
        }
        _ => None,
    };
    SESSION.with_borrow_mut(|s| {
        *s = Some(Session {
            user,
            private,
            orgs: HashMap::new(),
        })
    });
    Ok(())
}

/// `org_keys`: JSON object `{ "<orgId>": "<type-4 UnsignedSharedKey>" }` from sync profile.organizations.
///
/// A key that cannot be opened is skipped, never fatal: organization keys are an extra on top of the
/// personal vault, and one bad entry (an unknown key format, an account without its RSA private key)
/// must not make the whole vault unloadable. Items under a skipped key are reported as undecryptable
/// by `cipher_keys`. Returns the number of keys that loaded.
pub fn set_org_keys(org_keys: &str) -> Result<usize> {
    let map: HashMap<String, String> = serde_json::from_str(org_keys).map_err(err)?;
    with_session_mut(|s| {
        let mut orgs = HashMap::with_capacity(map.len());
        if let Some(private) = s.private.as_ref() {
            for (id, enc) in map {
                let Ok(shared) = UnsignedSharedKey::from_str(&enc) else {
                    continue;
                };
                #[allow(deprecated)] // Vaultwarden still hands out unsigned (type 4) org keys.
                let Ok(key) = shared.decapsulate_key_unsigned(private) else {
                    continue;
                };
                orgs.insert(id.to_ascii_lowercase(), key);
            }
        }
        let n = orgs.len();
        s.orgs = orgs;
        Ok(n)
    })
}

pub fn is_unlocked() -> bool {
    SESSION.with_borrow(Option::is_some)
}

pub fn lock() {
    SESSION.with_borrow_mut(|s| *s = None);
    MASTER_KEYS.with_borrow_mut(|(_, keys)| keys.clear());
}

pub(crate) fn with_session<T>(f: impl FnOnce(&Session) -> Result<T>) -> Result<T> {
    SESSION.with_borrow(|s| f(s.as_ref().ok_or("locked")?))
}

fn with_session_mut<T>(f: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
    SESSION.with_borrow_mut(|s| f(s.as_mut().ok_or("locked")?))
}

/// Decrypts an EncString that wraps a raw symmetric key (cipher key, attachment key).
pub(crate) fn decrypt_symmetric_key(
    wrapping: &SymmetricCryptoKey,
    enc: &str,
) -> Result<SymmetricCryptoKey> {
    let bytes: Vec<u8> = EncString::from_str(enc)
        .map_err(err)?
        .decrypt_with_key(wrapping)
        .map_err(err)?;
    SymmetricCryptoKey::try_from(&BitwardenLegacyKeyBytes::from(bytes)).map_err(err)
}

pub fn decrypt_cipher_list(ciphers_json: &str) -> Result<String> {
    let ciphers: Vec<Value> = serde_json::from_str(ciphers_json).map_err(err)?;
    with_session(|s| Ok(crate::cipher::decrypt_list(s, ciphers).to_string()))
}

pub fn decrypt_cipher(cipher_json: &str) -> Result<String> {
    let mut cipher: Value = serde_json::from_str(cipher_json).map_err(err)?;
    with_session(|s| crate::cipher::decrypt(s, &mut cipher))?;
    Ok(cipher.to_string())
}

pub fn encrypt_cipher(cipher_json: &str) -> Result<String> {
    let mut cipher: Value = serde_json::from_str(cipher_json).map_err(err)?;
    with_session(|s| crate::cipher::encrypt(s, &mut cipher))?;
    Ok(cipher.to_string())
}

pub fn decrypt_folders(folders_json: &str) -> Result<String> {
    let folders: Vec<Value> = serde_json::from_str(folders_json).map_err(err)?;
    with_session(|s| Ok(crate::cipher::decrypt_folders(s, folders).to_string()))
}

pub fn decrypt_send_list(sends_json: &str) -> Result<String> {
    let sends: Vec<Value> = serde_json::from_str(sends_json).map_err(err)?;
    with_session(|s| Ok(crate::send::decrypt_list(s, sends).to_string()))
}

pub fn encrypt_send(send_json: &str) -> Result<String> {
    let mut send: Value = serde_json::from_str(send_json).map_err(err)?;
    with_session(|s| crate::send::encrypt(s, &mut send))?;
    Ok(send.to_string())
}

pub fn decrypt_attachment(cipher_json: &str, id: &str, data: &[u8]) -> Result<Vec<u8>> {
    let cipher: Value = serde_json::from_str(cipher_json).map_err(err)?;
    with_session(|s| crate::cipher::decrypt_attachment(s, &cipher, id, data))
}

pub fn encrypt_attachment(cipher_json: &str, file_name: &str, data: &[u8]) -> Result<String> {
    let cipher: Value = serde_json::from_str(cipher_json).map_err(err)?;
    with_session(|s| {
        Ok(crate::cipher::encrypt_attachment(s, &cipher, file_name, data)?.to_string())
    })
}

pub fn encrypt_send_file(wrapped_key: &str, data: &[u8]) -> Result<Vec<u8>> {
    with_session(|s| crate::send::encrypt_file(s, wrapped_key, data))
}

/// Registration material for a new account: protected user key + RSA key pair.
#[cfg(feature = "register")]
pub fn make_registration_keys(handle: u32) -> Result<String> {
    with_master(handle, |mk| {
        let (user_key, protected) = mk.make_user_key().map_err(err)?;
        let pair = user_key.make_key_pair().map_err(err)?;
        Ok(serde_json::json!({
            "key": protected.to_string(),
            "publicKey": pair.public.to_string(),
            "encryptedPrivateKey": pair.private.to_string(),
        })
        .to_string())
    })
}

#[cfg(test)]
mod tests {
    use base64::{Engine, engine::general_purpose::STANDARD};
use bitwarden_crypto::SymmetricKeyAlgorithm;

    use super::*;

    #[test]
    fn kdf_params_are_range_checked() {
        assert!(kdf_from_params(0, 600_000, 0, 0).is_ok());
        assert!(kdf_from_params(1, 3, 64, 4).is_ok());
        // A downgrade (cheap to brute-force) and an exhaustion attempt, for both KDFs.
        assert!(kdf_from_params(0, 1, 0, 0).is_err());
        assert!(kdf_from_params(0, u32::MAX, 0, 0).is_err());
        assert!(kdf_from_params(1, 1, 64, 4).is_err());
        assert!(kdf_from_params(1, 3, 1, 4).is_err());
        assert!(kdf_from_params(1, 3, 1_000_000, 4).is_err());
        assert!(kdf_from_params(1, 3, 64, 0).is_err());
        assert!(kdf_from_params(2, 600_000, 0, 0).is_err());
    }

    #[test]
    fn pin_unlock_roundtrip() {
        let kdf = kdf_from_params(0, 5000, 0, 0).unwrap();
        let user = SymmetricCryptoKey::make(SymmetricKeyAlgorithm::Aes256CbcHmac);
        let expected = user.to_base64();
        open_session(user, None).unwrap();
        let wrapped = pin_protect_user_key("1234", "a@example.test", &kdf).unwrap();
        lock();
        assert!(unlock_with_pin("1235", "a@example.test", &kdf, &wrapped, None).is_err());
        assert!(!is_unlocked());
        unlock_with_pin("1234", "a@example.test", &kdf, &wrapped, None).unwrap();
        assert_eq!(with_session(|s| Ok(s.user.to_base64())).unwrap(), expected);
    }

    // Needs the `register` feature for `UserKey::make_key_pair`; CI builds the e2e harness with it.
    #[cfg(feature = "register")]
    #[test]
    fn org_keys_fail_soft() {
        let user = SymmetricCryptoKey::make(SymmetricKeyAlgorithm::Aes256CbcHmac);
        let pair = bitwarden_crypto::UserKey::new(user.clone()).make_key_pair().unwrap();
        open_session(user, Some(&pair.private.to_string())).unwrap();
        // A key the server got wrong is skipped; the session and the personal vault stay usable.
        assert_eq!(set_org_keys(r#"{"org":"2.bogus|bogus|bogus"}"#).unwrap(), 0);
        assert!(is_unlocked());
        assert!(with_session(|s| Ok(s.orgs.is_empty())).unwrap());
    }

    #[test]
    fn org_keys_need_no_private_key() {
        open_session(SymmetricCryptoKey::make(SymmetricKeyAlgorithm::Aes256CbcHmac), None).unwrap();
        // No RSA private key at all (not every account has one): nothing loads, nothing fails.
        assert_eq!(set_org_keys(r#"{"org":"2.x|y|z"}"#).unwrap(), 0);
        assert!(is_unlocked());
    }

    #[test]
    fn attachment_roundtrip() {
        open_session(
            SymmetricCryptoKey::make(SymmetricKeyAlgorithm::Aes256CbcHmac),
            None,
        )
        .unwrap();
        let cipher = r#"{"id":"c1","type":2,"name":"n"}"#;
        let enc: Value =
            serde_json::from_str(&encrypt_attachment(cipher, "a.txt", b"hello").unwrap()).unwrap();
        let with_att = serde_json::json!({ "id": "c1", "attachments": [{ "id": "a1", "key": enc["key"], "fileName": enc["fileName"] }] });
        let body = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            enc["data"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(
            decrypt_attachment(&with_att.to_string(), "a1", &body).unwrap(),
            b"hello"
        );
        let dec = decrypt_cipher(&with_att.to_string()).unwrap();
        assert!(dec.contains(r#""fileName":"a.txt""#), "{dec}");
        assert!(decrypt_attachment(&with_att.to_string(), "nope", &body).is_err());
    }
}
