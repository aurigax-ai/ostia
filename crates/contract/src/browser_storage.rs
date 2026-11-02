use ostia_base::js::{JsNumber, locale_compare, utf16_len};
use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use serde_json::{Map, Value};

use crate::sandbox_parse::js_to_number;

const STORAGE_KEY_MAX: usize = 4096;
const DOMAIN_MAX: usize = 255;
pub const STORAGE_VALUE_MAX: usize = 5 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageKind {
    Cookies,
    Local,
    Session,
}

impl StorageKind {
    pub fn parse(value: &Value) -> Option<Self> {
        match value.as_str()? {
            "cookies" => Some(Self::Cookies),
            "local" => Some(Self::Local),
            "session" => Some(Self::Session),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cookies => "cookies",
            Self::Local => "local",
            Self::Session => "session",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CookieSameSite {
    Unspecified,
    NoRestriction,
    Lax,
    Strict,
}

impl CookieSameSite {
    fn from_text(text: Option<&str>) -> Self {
        match text {
            Some("no_restriction") => Self::NoRestriction,
            Some("lax") => Self::Lax,
            Some("strict") => Self::Strict,
            _ => Self::Unspecified,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub host_only: bool,
    pub expires: Option<JsNumber>,
    pub http_only: bool,
    pub secure: bool,
    pub same_site: CookieSameSite,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StorageEntry {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BrowserStorageSnapshot {
    pub origin: String,
    pub cookies: Vec<StorageCookie>,
    pub local: Vec<StorageEntry>,
    pub session: Vec<StorageEntry>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BrowserStorageRead {
    Snapshot(BrowserStorageSnapshot),
    Failed(String),
}

impl Serialize for BrowserStorageRead {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        match self {
            Self::Snapshot(snapshot) => {
                map.serialize_entry("ok", &true)?;
                map.serialize_entry("snapshot", snapshot)?;
            }
            Self::Failed(error) => {
                map.serialize_entry("ok", &false)?;
                map.serialize_entry("error", error)?;
            }
        }
        map.end()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StorageWriteResult {
    Written,
    Failed(String),
}

impl Serialize for StorageWriteResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Written => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("ok", &true)?;
                map.end()
            }
            Self::Failed(error) => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("ok", &false)?;
                map.serialize_entry("error", error)?;
                map.end()
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum StorageEdit {
    Cookie(StorageCookie),
    Entry {
        kind: StorageKind,
        key: String,
        value: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageRemovalCookie {
    pub name: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StorageRemoval {
    Cookie(StorageRemovalCookie),
    Entry { kind: StorageKind, key: String },
}

fn text_within(value: Option<&Value>, max: usize) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| utf16_len(text) <= max)
}

fn flag(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool) == Some(true)
}

fn cookie_name(raw: &Value) -> Option<&str> {
    text_within(raw.get("name"), STORAGE_KEY_MAX).filter(|name| !name.is_empty())
}

fn cookie_domain(raw: &Value) -> Option<&str> {
    text_within(raw.get("domain"), DOMAIN_MAX)
        .filter(|domain| !domain.strip_prefix('.').unwrap_or(domain).is_empty())
}

fn cookie_path(raw: &Value) -> Option<&str> {
    text_within(raw.get("path"), STORAGE_KEY_MAX).filter(|path| path.starts_with('/'))
}

fn cookie_expires(raw: &Value) -> Option<Option<JsNumber>> {
    match raw.get("expires")? {
        Value::Null => Some(None),
        value => {
            let expires = js_to_number(value);
            expires.is_finite().then_some(Some(JsNumber(expires)))
        }
    }
}

fn normalize_cookie(raw: &Value) -> Option<StorageCookie> {
    let name = cookie_name(raw)?;
    let value = text_within(raw.get("value"), STORAGE_VALUE_MAX)?;
    let domain = cookie_domain(raw)?;
    let path = cookie_path(raw)?;
    let expires = cookie_expires(raw)?;
    Some(StorageCookie {
        name: name.to_owned(),
        value: value.to_owned(),
        domain: domain.to_owned(),
        path: path.to_owned(),
        host_only: flag(raw.get("hostOnly")),
        expires,
        http_only: flag(raw.get("httpOnly")),
        secure: flag(raw.get("secure")),
        same_site: CookieSameSite::from_text(raw.get("sameSite").and_then(Value::as_str)),
    })
}

fn web_kind(raw: &Value) -> Option<StorageKind> {
    match StorageKind::parse(raw.get("kind")?)? {
        StorageKind::Cookies => None,
        kind => Some(kind),
    }
}

fn web_key(raw: &Value) -> Option<&str> {
    text_within(raw.get("key"), STORAGE_KEY_MAX).filter(|key| !key.is_empty())
}

pub fn normalize_storage_edit(raw: &Value) -> Option<StorageEdit> {
    if raw.get("kind").and_then(Value::as_str) == Some("cookies") {
        return normalize_cookie(raw.get("cookie")?).map(StorageEdit::Cookie);
    }
    let kind = web_kind(raw)?;
    let key = web_key(raw)?;
    let value = text_within(raw.get("value"), STORAGE_VALUE_MAX)?;
    Some(StorageEdit::Entry {
        kind,
        key: key.to_owned(),
        value: value.to_owned(),
    })
}

pub fn normalize_storage_removal(raw: &Value) -> Option<StorageRemoval> {
    if raw.get("kind").and_then(Value::as_str) == Some("cookies") {
        let cookie = raw.get("cookie")?;
        return Some(StorageRemoval::Cookie(StorageRemovalCookie {
            name: cookie_name(cookie)?.to_owned(),
            domain: cookie_domain(cookie)?.to_owned(),
            path: cookie_path(cookie)?.to_owned(),
            secure: flag(cookie.get("secure")),
        }));
    }
    let kind = web_kind(raw)?;
    let key = web_key(raw)?;
    Some(StorageRemoval::Entry {
        kind,
        key: key.to_owned(),
    })
}

pub fn cookie_url(domain: &str, path: &str, secure: bool) -> String {
    let host = domain.strip_prefix('.').unwrap_or(domain);
    let path = if path.is_empty() { "/" } else { path };
    format!("{}://{host}{path}", if secure { "https" } else { "http" })
}

pub fn entries_of(record: &Map<String, Value>) -> Vec<StorageEntry> {
    let mut keys: Vec<&String> = record.keys().collect();
    keys.sort_by(|a, b| locale_compare(a, b));
    keys.into_iter()
        .map(|key| StorageEntry {
            key: key.clone(),
            value: record
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
        .collect()
}
