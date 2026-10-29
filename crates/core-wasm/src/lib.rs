//! Plugwarden crypto core: a small wasm-bindgen surface over `bitwarden-crypto`.
//!
//! All structured data crosses the boundary as JSON strings, one call per batch, so the JS glue
//! stays tiny and the whole vault is decrypted in a single call.

pub mod api;
mod cipher;
mod generator;
mod totp;

use wasm_bindgen::prelude::*;

fn js(e: String) -> JsError {
    JsError::new(&e)
}

/// `kdfType`: 0 = PBKDF2-SHA256, 1 = Argon2id (`memory` in MiB). Returns an opaque handle.
#[wasm_bindgen(js_name = deriveMasterKey)]
pub fn derive_master_key(
    password: &str,
    email: &str,
    kdf_type: u8,
    iterations: u32,
    memory: u32,
    parallelism: u32,
) -> Result<u32, JsError> {
    let kdf = api::kdf_from_params(kdf_type, iterations, memory, parallelism).map_err(js)?;
    api::derive_master_key(password, email, &kdf).map_err(js)
}

/// Base64 master password hash. `local = false` gives the value sent to the server.
#[wasm_bindgen(js_name = makeAuthHash)]
pub fn make_auth_hash(handle: u32, password: &str, local: bool) -> Result<String, JsError> {
    api::make_auth_hash(handle, password, local).map_err(js)
}

#[wasm_bindgen(js_name = freeMasterKey)]
pub fn free_master_key(handle: u32) {
    api::free_master_key(handle)
}

#[wasm_bindgen(js_name = unlockUserKey)]
pub fn unlock_user_key(
    handle: u32,
    protected_user_key: &str,
    encrypted_private_key: Option<String>,
) -> Result<(), JsError> {
    api::unlock_user_key(handle, protected_user_key, encrypted_private_key.as_deref()).map_err(js)
}

#[wasm_bindgen(js_name = setOrgKeys)]
pub fn set_org_keys(org_keys_json: &str) -> Result<usize, JsError> {
    api::set_org_keys(org_keys_json).map_err(js)
}

#[wasm_bindgen(js_name = isUnlocked)]
pub fn is_unlocked() -> bool {
    api::is_unlocked()
}

#[wasm_bindgen]
pub fn lock() {
    api::lock()
}

/// Input: JSON array of ciphers as returned by `/api/sync`. Output: `{"ciphers": [...], "failed": [...]}`.
#[wasm_bindgen(js_name = decryptCipherList)]
pub fn decrypt_cipher_list(ciphers_json: &str) -> Result<String, JsError> {
    api::decrypt_cipher_list(ciphers_json).map_err(js)
}

#[wasm_bindgen(js_name = decryptCipher)]
pub fn decrypt_cipher(cipher_json: &str) -> Result<String, JsError> {
    api::decrypt_cipher(cipher_json).map_err(js)
}

#[wasm_bindgen(js_name = encryptCipher)]
pub fn encrypt_cipher(cipher_json: &str) -> Result<String, JsError> {
    api::encrypt_cipher(cipher_json).map_err(js)
}

#[wasm_bindgen(js_name = decryptFolders)]
pub fn decrypt_folders(folders_json: &str) -> Result<String, JsError> {
    api::decrypt_folders(folders_json).map_err(js)
}

/// `input`: base32 secret, `otpauth://` or `steam://` URI. Returns `{"code","period","remaining"}`.
#[wasm_bindgen]
pub fn totp(input: &str, unix_ms: f64) -> Result<String, JsError> {
    totp::totp(input, unix_ms).map_err(js)
}

#[wasm_bindgen(js_name = generatePassword)]
pub fn generate_password(options_json: &str) -> Result<String, JsError> {
    generator::generate(options_json).map_err(js)
}

#[cfg(feature = "register")]
#[wasm_bindgen(js_name = makeRegistrationKeys)]
pub fn make_registration_keys(handle: u32) -> Result<String, JsError> {
    api::make_registration_keys(handle).map_err(js)
}
