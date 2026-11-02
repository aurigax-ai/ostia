use std::path::Path;

use ostia_base::json_store::{SaveOptions, load_json, save_json};
use ostia_base::random::random_bytes;
use serde_json::{Value, json};

const SALT_BYTES: usize = 32;

fn stored_salt(path: &Path) -> Option<Vec<u8>> {
    let stored = load_json(path)?;
    let text = stored.get("salt").and_then(Value::as_str)?;
    if text.len() != SALT_BYTES * 2
        || !text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    hex::decode(text).ok()
}

pub fn load_pane_id_salt(path: &Path) -> Vec<u8> {
    if let Some(salt) = stored_salt(path) {
        return salt;
    }
    let salt = random_bytes::<SALT_BYTES>();
    if let Err(error) = save_json(
        path,
        &json!({ "salt": hex::encode(salt) }),
        SaveOptions::SECURE,
    ) {
        tracing::error!(%error, "could not save the pane id salt; ids will change on restart");
    }
    salt.to_vec()
}
