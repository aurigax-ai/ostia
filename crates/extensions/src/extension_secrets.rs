use ostia_base::js::utf16_len;
use ostia_contract::proto_guard::is_dangerous_segment;
use serde_json::{Map, Value};

use crate::extension_host_deps::ExtensionSecretStore;

const EXTENSION_SECRET_MAX: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SecretError {
    #[error("invalid-key")]
    InvalidKey,
    #[error("invalid-value")]
    InvalidValue,
    #[error("encryption-unavailable")]
    EncryptionUnavailable,
}

impl SecretError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidKey => "invalid-key",
            Self::InvalidValue => "invalid-value",
            Self::EncryptionUnavailable => "encryption-unavailable",
        }
    }
}

pub type LoadSecrets = Box<dyn Fn() -> Value + Send + Sync>;
pub type SaveSecrets = Box<dyn Fn(&Value) + Send + Sync>;
pub type CanEncrypt = Box<dyn Fn() -> bool + Send + Sync>;
pub type Encrypt = Box<dyn Fn(&str) -> String + Send + Sync>;
pub type Decrypt = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

pub struct SecretStoreDeps {
    pub load: LoadSecrets,
    pub save: SaveSecrets,
    pub can_encrypt: CanEncrypt,
    pub encrypt: Encrypt,
    pub decrypt: Decrypt,
}

type StoredSecrets = Map<String, Value>;

fn string_entries(values: &Value) -> Vec<(String, &str)> {
    let indexed: Vec<(String, &Value)> = match values {
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| (key.clone(), value))
            .collect(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value))
            .collect(),
        _ => return Vec::new(),
    };
    indexed
        .into_iter()
        .filter(|(key, _)| !is_dangerous_segment(key))
        .filter_map(|(key, value)| value.as_str().map(|text| (key, text)))
        .collect()
}

pub fn sanitize_secrets(raw: &Value) -> Value {
    let mut out = StoredSecrets::new();
    let Some(record) = raw.as_object() else {
        return Value::Object(out);
    };
    for (ext_id, values) in record {
        if is_dangerous_segment(ext_id) || !(values.is_object() || values.is_array()) {
            continue;
        }
        let kept: Map<String, Value> = string_entries(values)
            .into_iter()
            .map(|(key, text)| (key, Value::String(text.to_owned())))
            .collect();
        out.insert(ext_id.clone(), Value::Object(kept));
    }
    Value::Object(out)
}

fn stored_values(data: &Value, ext_id: &str) -> Option<Map<String, Value>> {
    data.get(ext_id).and_then(Value::as_object).cloned()
}

struct SecretStore {
    deps: SecretStoreDeps,
}

pub fn create_secret_store(deps: SecretStoreDeps) -> impl ExtensionSecretStore {
    SecretStore { deps }
}

impl SecretStore {
    fn read(&self) -> Value {
        sanitize_secrets(&(self.deps.load)())
    }
}

impl ExtensionSecretStore for SecretStore {
    fn keys(&self, ext_id: &str) -> Vec<String> {
        let mut keys: Vec<String> = stored_values(&self.read(), ext_id)
            .map(|values| values.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        keys
    }

    fn get(&self, ext_id: &str, key: &str) -> Option<String> {
        let stored = self.read();
        let secret = stored.get(ext_id)?.get(key)?.as_str()?.to_owned();
        if !(self.deps.can_encrypt)() {
            return None;
        }
        (self.deps.decrypt)(&secret)
    }

    fn set(&self, ext_id: &str, key: &str, value: Option<&str>) -> Result<(), SecretError> {
        if is_dangerous_segment(ext_id) || is_dangerous_segment(key) {
            return Err(SecretError::InvalidKey);
        }
        let mut data = self.read();
        let mut values = stored_values(&data, ext_id).unwrap_or_default();
        match value {
            None => {
                values.shift_remove(key);
            }
            Some(text) => {
                if text.is_empty() || utf16_len(text) > EXTENSION_SECRET_MAX {
                    return Err(SecretError::InvalidValue);
                }
                if !(self.deps.can_encrypt)() {
                    return Err(SecretError::EncryptionUnavailable);
                }
                values.insert(key.to_owned(), Value::String((self.deps.encrypt)(text)));
            }
        }
        if let Some(map) = data.as_object_mut() {
            if values.is_empty() {
                map.shift_remove(ext_id);
            } else {
                map.insert(ext_id.to_owned(), Value::Object(values));
            }
        }
        (self.deps.save)(&data);
        Ok(())
    }
}
