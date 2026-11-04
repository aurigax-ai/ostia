use std::path::PathBuf;
use std::sync::Arc;

use ostia_base::Result;
use ostia_base::js::{locale_compare, utf16_len};
use ostia_base::json_store::{SaveOptions, load_json, save_json};
use ostia_contract::extension_connections::{
    ConnectionInfo, ConnectionValue, EXTENSION_CONNECTION_NAME_PATTERN,
    EXTENSION_CONNECTION_VALUE_MAX, EXTENSION_CONNECTIONS_MAX, ExtensionConnectionEntry,
    ExtensionConnectionFieldType, ExtensionConnectionKind, ExtensionConnectionResult,
};
use ostia_contract::extensions::EXTENSION_SECRET_MAX;
use ostia_contract::proto_guard::is_dangerous_segment;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::extension_host_deps::ExtensionSecretStore;

const SECRET_PREFIX: &str = "@connection/";

type SecretStoreSource = Box<dyn Fn() -> Option<Arc<dyn ExtensionSecretStore>> + Send + Sync>;
type Stored = Map<String, Value>;

struct StoredConnection {
    name: String,
    kind: String,
    fields: Map<String, Value>,
}

pub fn connection_secret_key(name: &str, key: &str) -> String {
    format!("{SECRET_PREFIX}{name}/{key}")
}

fn string_fields(raw: Option<&Value>) -> Option<Map<String, Value>> {
    let record = raw?.as_object()?;
    let mut out = Map::new();
    for (key, value) in record {
        if is_dangerous_segment(key) || !value.is_string() {
            return None;
        }
        out.insert(key.clone(), value.clone());
    }
    Some(out)
}

fn sanitize(raw: Option<Value>) -> Stored {
    let mut out = Stored::new();
    let Some(Value::Object(root)) = raw else {
        return out;
    };
    for (ext_id, entries) in root {
        let Value::Object(entries) = entries else {
            continue;
        };
        if is_dangerous_segment(&ext_id) {
            continue;
        }
        let mut kept = Map::new();
        for (name, value) in entries {
            if !EXTENSION_CONNECTION_NAME_PATTERN.is_match(&name) {
                continue;
            }
            let Value::Object(value) = value else {
                continue;
            };
            let fields = string_fields(value.get("fields"));
            let Some(kind) = value.get("kind").and_then(Value::as_str) else {
                continue;
            };
            let Some(fields) = fields else {
                continue;
            };
            kept.insert(name, json!({"kind": kind, "fields": fields}));
        }
        out.insert(ext_id, Value::Object(kept));
    }
    out
}

fn has_control(value: &str) -> bool {
    value.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
}

fn check_fields(
    kind: &ExtensionConnectionKind,
    raw: Option<&Value>,
) -> std::result::Result<Map<String, Value>, String> {
    let empty = Map::new();
    let given = raw.and_then(Value::as_object).unwrap_or(&empty);
    for key in given.keys() {
        if !kind.fields.iter().any(|field| &field.key == key) {
            return Err(format!("unknown field {key}"));
        }
    }
    let mut fields = Map::new();
    for field in &kind.fields {
        let value = if given.contains_key(&field.key) {
            given.get(&field.key).cloned()
        } else {
            field.default.clone().map(Value::String)
        };
        let value = match value {
            None => None,
            Some(Value::String(text)) if text.is_empty() => None,
            Some(other) => Some(other),
        };
        let Some(value) = value else {
            if field.required {
                return Err(format!("{} is required", field.key));
            }
            continue;
        };
        let text = match &value {
            Value::String(text) if utf16_len(text) <= EXTENSION_CONNECTION_VALUE_MAX => text,
            _ => {
                return Err(format!(
                    "{} must be text of at most {EXTENSION_CONNECTION_VALUE_MAX} characters",
                    field.key
                ));
            }
        };
        if has_control(text) {
            return Err(format!("{} must not hold a control character", field.key));
        }
        if field.field_type == ExtensionConnectionFieldType::Enum {
            let allowed = field.enum_values.as_deref().unwrap_or(&[]);
            if !allowed.iter().any(|option| option == text) {
                return Err(format!(
                    "{} must be one of {}",
                    field.key,
                    allowed.join(", ")
                ));
            }
        }
        fields.insert(field.key.clone(), value);
    }
    Ok(fields)
}

type SecretWrites = Vec<(String, Option<String>)>;

fn check_secrets(
    kind: &ExtensionConnectionKind,
    raw: Option<&Value>,
) -> std::result::Result<SecretWrites, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let Some(record) = raw.as_object() else {
        return Err("secrets must be an object".to_owned());
    };
    let mut out = Vec::new();
    for (key, value) in record {
        if !kind.secrets.iter().any(|secret| &secret.key == key) {
            return Err(format!("unknown secret {key}"));
        }
        match value {
            Value::Null => out.push((key.clone(), None)),
            Value::String(text) if !text.is_empty() && utf16_len(text) <= EXTENSION_SECRET_MAX => {
                if has_control(text) {
                    return Err(format!(
                        "{key} must not hold a control character such as a line break"
                    ));
                }
                out.push((key.clone(), Some(text.clone())));
            }
            _ => return Err(format!("{key} must be 1-{EXTENSION_SECRET_MAX} characters")),
        }
    }
    Ok(out)
}

fn refused(error: impl Into<String>) -> ExtensionConnectionResult {
    ExtensionConnectionResult::Refused(error.into())
}

pub struct ExtensionConnections {
    path: PathBuf,
    secrets: SecretStoreSource,
    write_lock: Mutex<()>,
}

impl ExtensionConnections {
    pub fn new(
        path: PathBuf,
        secrets: impl Fn() -> Option<Arc<dyn ExtensionSecretStore>> + Send + Sync + 'static,
    ) -> Self {
        Self {
            path,
            secrets: Box::new(secrets),
            write_lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Stored {
        sanitize(load_json(&self.path))
    }

    fn write(&self, data: Stored) -> Result<()> {
        save_json(&self.path, &Value::Object(data), SaveOptions::default())
    }

    fn stored(&self, ext_id: &str, kinds: &[ExtensionConnectionKind]) -> Vec<StoredConnection> {
        let data = self.read();
        let Some(Value::Object(entries)) = data.get(ext_id) else {
            return Vec::new();
        };
        let mut found: Vec<StoredConnection> = entries
            .iter()
            .filter_map(|(name, value)| {
                let kind = value.get("kind")?.as_str()?;
                let fields = value.get("fields")?.as_object()?;
                kinds
                    .iter()
                    .any(|candidate| candidate.kind == kind)
                    .then(|| StoredConnection {
                        name: name.clone(),
                        kind: kind.to_owned(),
                        fields: fields.clone(),
                    })
            })
            .collect();
        found.sort_by(|a, b| locale_compare(&a.name, &b.name));
        found
    }

    pub fn list(
        &self,
        ext_id: &str,
        kinds: &[ExtensionConnectionKind],
    ) -> Vec<ExtensionConnectionEntry> {
        let keys = (self.secrets)()
            .map(|store| store.keys(ext_id))
            .unwrap_or_default();
        self.stored(ext_id, kinds)
            .into_iter()
            .map(|connection| {
                let secrets_set = kinds
                    .iter()
                    .find(|kind| kind.kind == connection.kind)
                    .map(|kind| {
                        kind.secrets
                            .iter()
                            .map(|secret| secret.key.clone())
                            .filter(|key| {
                                keys.contains(&connection_secret_key(&connection.name, key))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                ExtensionConnectionEntry {
                    name: connection.name,
                    kind: connection.kind,
                    fields: connection.fields,
                    secrets_set,
                }
            })
            .collect()
    }

    pub fn names(&self, ext_id: &str, kinds: &[ExtensionConnectionKind]) -> Vec<ConnectionInfo> {
        self.stored(ext_id, kinds)
            .into_iter()
            .map(|connection| ConnectionInfo {
                name: connection.name,
                kind: connection.kind,
            })
            .collect()
    }

    pub fn value(
        &self,
        ext_id: &str,
        kinds: &[ExtensionConnectionKind],
        name: &Value,
    ) -> Option<ConnectionValue> {
        let name = name.as_str()?;
        let connection = self
            .stored(ext_id, kinds)
            .into_iter()
            .find(|connection| connection.name == name)?;
        let kind = kinds.iter().find(|kind| kind.kind == connection.kind);
        let store = (self.secrets)();
        let mut secrets = Map::new();
        for secret in kind.map(|kind| kind.secrets.as_slice()).unwrap_or(&[]) {
            let value = store
                .as_ref()
                .and_then(|store| store.get(ext_id, &connection_secret_key(name, &secret.key)))
                .filter(|value| !value.is_empty());
            if let Some(value) = value {
                secrets.insert(secret.key.clone(), Value::String(value));
            }
        }
        Some(ConnectionValue {
            name: connection.name,
            kind: connection.kind,
            fields: connection.fields,
            secrets,
        })
    }

    pub fn save(
        &self,
        ext_id: &str,
        kinds: &[ExtensionConnectionKind],
        req: &Value,
    ) -> Result<ExtensionConnectionResult> {
        let Some(req) = req.as_object().filter(|_| !is_dangerous_segment(ext_id)) else {
            return Ok(refused("invalid-request"));
        };
        let Some(name) = req
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| EXTENSION_CONNECTION_NAME_PATTERN.is_match(name))
        else {
            return Ok(refused("invalid-name"));
        };
        let wanted = req.get("kind").and_then(Value::as_str);
        let Some(kind) = kinds.iter().find(|kind| Some(kind.kind.as_str()) == wanted) else {
            return Ok(refused("unknown-kind"));
        };
        let fields = match check_fields(kind, req.get("fields")) {
            Ok(fields) => fields,
            Err(error) => return Ok(refused(format!("invalid-field: {error}"))),
        };
        let writes = match check_secrets(kind, req.get("secrets")) {
            Ok(writes) => writes,
            Err(error) => return Ok(refused(format!("invalid-secret: {error}"))),
        };
        let _guard = self.write_lock.lock();
        let mut data = self.read();
        let mut entries = match data.get(ext_id) {
            Some(Value::Object(entries)) => entries.clone(),
            _ => Map::new(),
        };
        let existing = entries.get(name);
        if let Some(existing) = existing
            && existing.get("kind").and_then(Value::as_str) != Some(kind.kind.as_str())
        {
            return Ok(refused("kind-changed"));
        }
        if existing.is_none() && entries.len() >= EXTENSION_CONNECTIONS_MAX {
            return Ok(refused("too-many-connections"));
        }
        let store = (self.secrets)();
        if store.is_none() && writes.iter().any(|(_, value)| value.is_some()) {
            return Ok(refused("encryption-unavailable"));
        }
        if let Some(store) = &store {
            for (key, value) in &writes {
                if let Err(error) =
                    store.set(ext_id, &connection_secret_key(name, key), value.as_deref())
                {
                    return Ok(refused(error.code()));
                }
            }
        }
        entries.insert(
            name.to_owned(),
            json!({"kind": kind.kind, "fields": fields}),
        );
        data.insert(ext_id.to_owned(), Value::Object(entries));
        self.write(data)?;
        Ok(ExtensionConnectionResult::Saved)
    }

    pub fn remove(&self, ext_id: &str, name: &Value) -> Result<ExtensionConnectionResult> {
        let Some(name) = name.as_str().filter(|_| !is_dangerous_segment(ext_id)) else {
            return Ok(refused("invalid-name"));
        };
        let _guard = self.write_lock.lock();
        let mut data = self.read();
        let mut entries = match data.get(ext_id) {
            Some(Value::Object(entries)) => entries.clone(),
            _ => Map::new(),
        };
        if entries.shift_remove(name).is_none() {
            return Ok(refused("unknown-connection"));
        }
        if let Some(store) = (self.secrets)() {
            let prefix = connection_secret_key(name, "");
            for key in store.keys(ext_id) {
                if key.starts_with(&prefix) {
                    let _ = store.set(ext_id, &key, None);
                }
            }
        }
        if entries.is_empty() {
            data.shift_remove(ext_id);
        } else {
            data.insert(ext_id.to_owned(), Value::Object(entries));
        }
        self.write(data)?;
        Ok(ExtensionConnectionResult::Saved)
    }

    pub fn forget(&self, ext_id: &str) -> Result<()> {
        let _guard = self.write_lock.lock();
        let mut data = self.read();
        if data.shift_remove(ext_id).is_none() {
            return Ok(());
        }
        self.write(data)
    }
}
