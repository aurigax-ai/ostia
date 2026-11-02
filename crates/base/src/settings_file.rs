use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::atomic_write::{AtomicWriteOptions, write_file_atomic};
use crate::clock::Clock;
use crate::js::js_trim;

const SETTINGS_FILE: &str = "settings.json";

#[derive(Clone, Debug)]
pub struct SettingsFiles {
    user_data: PathBuf,
    recovered: Arc<Mutex<Option<PathBuf>>>,
}

impl SettingsFiles {
    pub fn new(user_data: PathBuf) -> Self {
        Self {
            user_data,
            recovered: Arc::default(),
        }
    }

    fn file(&self) -> PathBuf {
        self.user_data.join(SETTINGS_FILE)
    }

    fn parse_file(&self) -> Result<Value, std::io::Error> {
        let bytes = fs::read(self.file())?;
        serde_json::from_str(&String::from_utf8_lossy(&bytes)).map_err(std::io::Error::other)
    }

    pub fn read_settings_file_or_none(&self) -> Option<Value> {
        match fs::read(self.file()) {
            Ok(bytes) => serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes))
                .ok()
                .filter(|parsed| parsed.is_object() || parsed.is_array()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Some(Value::Object(Map::new()))
            }
            Err(_) => None,
        }
    }

    pub fn read_settings_file(&self) -> Value {
        self.parse_file()
            .unwrap_or_else(|_| Value::Object(Map::new()))
    }

    pub fn read_locale(&self) -> Option<String> {
        self.read_settings_file()
            .get("locale")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    pub fn recovered_settings_copy(&self) -> Option<PathBuf> {
        self.recovered.lock().clone()
    }

    pub fn recover_corrupt_settings(&self, clock: &Clock) {
        let file = self.file();
        let Ok(bytes) = fs::read(&file) else { return };
        let text = String::from_utf8_lossy(&bytes);
        if js_trim(&text).is_empty() {
            return;
        }
        if serde_json::from_str::<Value>(&text).is_ok_and(|parsed| parsed.is_object()) {
            return;
        }
        let mut copy = file.clone().into_os_string();
        copy.push(format!(".corrupt-{}", clock()));
        let copy = PathBuf::from(copy);
        let set_aside = fs::rename(&file, &copy)
            .and_then(|()| fs::set_permissions(&copy, fs::Permissions::from_mode(0o600)))
            .map_err(|err| err.to_string())
            .and_then(|()| {
                write_file_atomic(&file, b"{}\n", AtomicWriteOptions::default())
                    .map_err(|err| err.to_string())
            });
        match set_aside {
            Ok(()) => *self.recovered.lock() = Some(copy),
            Err(err) => {
                tracing::error!("[settings] could not set a corrupt settings.json aside: {err}");
            }
        }
    }
}
