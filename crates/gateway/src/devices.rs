use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use ostia_base::Result;
use ostia_base::clock::{Clock, system_clock};
use ostia_base::js::non_empty;
use ostia_base::json_store::{SaveOptions, load_json, save_json};
use ostia_base::random::random_bytes;
use ostia_base::same_bytes::same_bytes;
use parking_lot::Mutex;
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

use crate::device_name::clean_device_name;
use crate::iso_time::iso_millis;
use crate::phone_caps::{CAP_ORDER, PHONE_BASE_CAPS, is_grantable_cap};

pub const DEFAULT_PHONE_CAPS: [&str; 2] = PHONE_BASE_CAPS;

const PUSH_HANDLE_MIN: usize = 16;
const PUSH_HANDLE_MAX: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushPlatform {
    Fcm,
    Apns,
}

impl PushPlatform {
    fn as_str(self) -> &'static str {
        match self {
            Self::Fcm => "fcm",
            Self::Apns => "apns",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "fcm" => Some(Self::Fcm),
            "apns" => Some(Self::Apns),
            _ => None,
        }
    }
}

impl Serialize for PushPlatform {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DevicePush {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<PushPlatform>,
}

pub fn is_push_handle(value: &str) -> bool {
    (PUSH_HANDLE_MIN..=PUSH_HANDLE_MAX).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub fn is_push_platform(value: &str) -> bool {
    PushPlatform::parse(value).is_some()
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
    pub name: String,
    pub pubkey: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub caps: Vec<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub push: Option<DevicePush>,
}

impl fmt::Debug for Device {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Device")
            .field("device_id", &self.device_id)
            .field("name", &self.name)
            .field("pubkey", &self.pubkey)
            .field("token", &"<hidden>")
            .field("caps", &self.caps)
            .field("created_at", &self.created_at)
            .field("last_seen_at", &self.last_seen_at)
            .field("install_id", &self.install_id)
            .field("push", &self.push)
            .finish()
    }
}

pub fn push_of(device: &Device) -> DevicePush {
    device.push.clone().unwrap_or(DevicePush {
        enabled: false,
        handle: None,
        platform: None,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegisterDeviceInput {
    pub name: String,
    pub pubkey: String,
    pub install_id: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct RegisteredDevice {
    pub device_id: String,
    pub token: String,
    pub caps: Vec<String>,
    pub replaced: Vec<String>,
    pub replaced_handles: Vec<String>,
}

impl fmt::Debug for RegisteredDevice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegisteredDevice")
            .field("device_id", &self.device_id)
            .field("token", &"<hidden>")
            .field("caps", &self.caps)
            .field("replaced", &self.replaced)
            .field("replaced_handles", &self.replaced_handles)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetCapError {
    NotFound,
    InvalidCap,
    RequiresCommand,
}

impl SetCapError {
    fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "not-found",
            Self::InvalidCap => "invalid-cap",
            Self::RequiresCommand => "requires-command",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GatewaySetCapResult {
    Granted { caps: Vec<String> },
    Refused(SetCapError),
}

impl Serialize for GatewaySetCapResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        match self {
            Self::Granted { caps } => {
                map.serialize_entry("ok", &true)?;
                map.serialize_entry("caps", caps)?;
            }
            Self::Refused(error) => {
                map.serialize_entry("ok", &false)?;
                map.serialize_entry("error", error.as_str())?;
            }
        }
        map.end()
    }
}

type Entries = Map<String, Value>;

fn known_caps(caps: Option<&Value>) -> Vec<Value> {
    let held: &[Value] = caps
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    CAP_ORDER
        .iter()
        .filter(|cap| held.iter().any(|value| value.as_str() == Some(**cap)))
        .map(|cap| Value::String((*cap).to_owned()))
        .collect()
}

fn clean_push(raw: Option<&Value>) -> Option<DevicePush> {
    let fields = raw?.as_object()?;
    if fields.get("enabled") != Some(&Value::Bool(true)) {
        return None;
    }
    let handle = fields
        .get("handle")
        .and_then(Value::as_str)
        .filter(|handle| is_push_handle(handle));
    let platform = fields
        .get("platform")
        .and_then(Value::as_str)
        .and_then(PushPlatform::parse);
    Some(match (handle, platform) {
        (Some(handle), Some(platform)) => DevicePush {
            enabled: true,
            handle: Some(handle.to_owned()),
            platform: Some(platform),
        },
        _ => DevicePush {
            enabled: true,
            handle: None,
            platform: None,
        },
    })
}

fn push_value(push: &DevicePush) -> Value {
    let mut fields = Map::new();
    fields.insert("enabled".to_owned(), Value::Bool(push.enabled));
    if let Some(handle) = &push.handle {
        fields.insert("handle".to_owned(), Value::String(handle.clone()));
    }
    if let Some(platform) = push.platform {
        fields.insert(
            "platform".to_owned(),
            Value::String(platform.as_str().to_owned()),
        );
    }
    Value::Object(fields)
}

fn set_push(entry: &mut Entries, push: Option<&DevicePush>) {
    match push {
        Some(push) => {
            entry.insert("push".to_owned(), push_value(push));
        }
        None => {
            entry.shift_remove("push");
        }
    }
}

fn clean_entry(entry: &mut Entries) {
    let caps = known_caps(entry.get("caps"));
    entry.insert("caps".to_owned(), Value::Array(caps));
    let push = clean_push(entry.get("push"));
    set_push(entry, push.as_ref());
}

fn text_of(entry: &Entries, key: &str) -> Option<String> {
    entry.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn device_from(entry: &Entries) -> Device {
    let caps = entry
        .get("caps")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |caps| {
            caps.iter()
                .filter_map(|cap| cap.as_str().map(str::to_owned))
                .collect()
        });
    Device {
        device_id: text_of(entry, "deviceId").unwrap_or_default(),
        name: text_of(entry, "name").unwrap_or_default(),
        pubkey: text_of(entry, "pubkey").unwrap_or_default(),
        token: text_of(entry, "token"),
        caps,
        created_at: text_of(entry, "createdAt").unwrap_or_default(),
        last_seen_at: text_of(entry, "lastSeenAt"),
        install_id: text_of(entry, "installId"),
        push: clean_push(entry.get("push")),
    }
}

fn devices_of(store: &Entries) -> Vec<Device> {
    store
        .values()
        .filter_map(Value::as_object)
        .map(device_from)
        .collect()
}

fn entry_mut<'a>(store: &'a mut Entries, device_id: &str) -> Option<&'a mut Entries> {
    store.get_mut(device_id).and_then(Value::as_object_mut)
}

#[derive(Clone)]
pub struct DeviceStore {
    file: Arc<PathBuf>,
    now: Clock,
    io: Arc<Mutex<()>>,
}

impl DeviceStore {
    pub fn new(file: PathBuf) -> Self {
        Self::with_clock(file, system_clock())
    }

    pub fn with_clock(file: PathBuf, now: Clock) -> Self {
        Self {
            file: Arc::new(file),
            now,
            io: Arc::new(Mutex::new(())),
        }
    }

    fn load(&self) -> Entries {
        let Some(Value::Object(stored)) = load_json(&self.file) else {
            return Map::new();
        };
        stored
            .into_iter()
            .filter_map(|(id, mut entry)| {
                clean_entry(entry.as_object_mut()?);
                Some((id, entry))
            })
            .collect()
    }

    fn save(&self, store: Entries) -> Result<()> {
        save_json(&self.file, &Value::Object(store), SaveOptions::SECURE)
    }

    pub fn register_device(&self, input: RegisterDeviceInput) -> Result<RegisteredDevice> {
        let _io = self.io.lock();
        let mut store = self.load();
        let install_id = non_empty(input.install_id.as_deref());
        let replaced: Vec<Device> = install_id.map_or_else(Vec::new, |wanted| {
            devices_of(&store)
                .into_iter()
                .filter(|device| device.install_id.as_deref() == Some(wanted))
                .collect()
        });
        for old in &replaced {
            store.shift_remove(&old.device_id);
        }
        let device_id = format!("dev_{}", uuid::Uuid::new_v4());
        let token = hex::encode(random_bytes::<32>());
        let caps: Vec<String> = replaced.first().map_or_else(
            || {
                DEFAULT_PHONE_CAPS
                    .iter()
                    .map(|cap| (*cap).to_owned())
                    .collect()
            },
            |first| first.caps.clone(),
        );
        let mut entry = Map::new();
        entry.insert("deviceId".to_owned(), Value::String(device_id.clone()));
        entry.insert(
            "name".to_owned(),
            Value::String(clean_device_name(&input.name).unwrap_or_else(|| "Phone".to_owned())),
        );
        entry.insert("pubkey".to_owned(), Value::String(input.pubkey));
        entry.insert("token".to_owned(), Value::String(token.clone()));
        entry.insert(
            "caps".to_owned(),
            Value::Array(caps.iter().cloned().map(Value::String).collect()),
        );
        entry.insert(
            "createdAt".to_owned(),
            Value::String(iso_millis((self.now)())),
        );
        if let Some(install_id) = install_id {
            entry.insert("installId".to_owned(), Value::String(install_id.to_owned()));
        }
        store.insert(device_id.clone(), Value::Object(entry));
        self.save(store)?;
        Ok(RegisteredDevice {
            device_id,
            token,
            caps,
            replaced: replaced.iter().map(|old| old.device_id.clone()).collect(),
            replaced_handles: replaced
                .iter()
                .filter_map(|old| push_of(old).handle)
                .collect(),
        })
    }

    pub fn device_by_install_id(&self, install_id: Option<&str>) -> Option<Device> {
        let wanted = non_empty(install_id)?;
        self.list()
            .into_iter()
            .find(|device| device.install_id.as_deref() == Some(wanted))
    }

    pub fn touch_device(&self, device_id: &str) -> Result<()> {
        let _io = self.io.lock();
        let mut store = self.load();
        let stamp = iso_millis((self.now)());
        let Some(entry) = entry_mut(&mut store, device_id) else {
            return Ok(());
        };
        entry.insert("lastSeenAt".to_owned(), Value::String(stamp));
        self.save(store)
    }

    pub fn set_device_name(&self, device_id: &str, name: &Value) -> Result<bool> {
        let clean = name.as_str().and_then(clean_device_name);
        let _io = self.io.lock();
        let mut store = self.load();
        let (Some(clean), Some(entry)) = (clean, entry_mut(&mut store, device_id)) else {
            return Ok(false);
        };
        if entry.get("name").and_then(Value::as_str) == Some(clean.as_str()) {
            return Ok(true);
        }
        entry.insert("name".to_owned(), Value::String(clean));
        self.save(store)?;
        Ok(true)
    }

    pub fn verify_token(&self, token: &str) -> Option<Device> {
        let mut found = None;
        for device in devices_of(&self.load()) {
            let Some(stored) = device.token.as_deref() else {
                continue;
            };
            if same_bytes(stored.as_bytes(), token.as_bytes()) {
                found = Some(device);
            }
        }
        found
    }

    pub fn list(&self) -> Vec<Device> {
        devices_of(&self.load())
    }

    pub fn get(&self, device_id: &str) -> Option<Device> {
        self.load()
            .get(device_id)
            .and_then(Value::as_object)
            .map(device_from)
    }

    pub fn revoke(&self, device_id: &str) -> Result<bool> {
        let _io = self.io.lock();
        let mut store = self.load();
        if store.shift_remove(device_id).is_none() {
            return Ok(false);
        }
        self.save(store)?;
        Ok(true)
    }

    pub fn set_device_push(&self, device_id: &str, push: &Value) -> Result<bool> {
        let _io = self.io.lock();
        let mut store = self.load();
        let Some(entry) = entry_mut(&mut store, device_id) else {
            return Ok(false);
        };
        set_push(entry, clean_push(Some(push)).as_ref());
        self.save(store)?;
        Ok(true)
    }

    pub fn set_device_cap(
        &self,
        device_id: &str,
        cap: &Value,
        granted: bool,
    ) -> Result<GatewaySetCapResult> {
        let Some(cap) = cap.as_str().filter(|cap| is_grantable_cap(cap)) else {
            return Ok(GatewaySetCapResult::Refused(SetCapError::InvalidCap));
        };
        let _io = self.io.lock();
        let mut store = self.load();
        let Some(entry) = entry_mut(&mut store, device_id) else {
            return Ok(GatewaySetCapResult::Refused(SetCapError::NotFound));
        };
        let mut next: Vec<String> = device_from(entry).caps;
        if granted {
            if cap == "destructive" && !next.iter().any(|held| held == "command") {
                return Ok(GatewaySetCapResult::Refused(SetCapError::RequiresCommand));
            }
            next.push(cap.to_owned());
        } else {
            next.retain(|held| held != cap);
            if cap == "command" {
                next.retain(|held| held != "destructive");
            }
        }
        let caps: Vec<String> = CAP_ORDER
            .iter()
            .filter(|ordered| next.iter().any(|held| held == **ordered))
            .map(|ordered| (*ordered).to_owned())
            .collect();
        entry.insert(
            "caps".to_owned(),
            Value::Array(caps.iter().cloned().map(Value::String).collect()),
        );
        self.save(store)?;
        Ok(GatewaySetCapResult::Granted { caps })
    }
}
