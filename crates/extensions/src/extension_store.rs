use std::path::PathBuf;
use std::sync::Arc;

use ostia_base::Result;
use ostia_base::js::utf16_len;
use ostia_base::json_store::{SaveOptions, load_json, save_json};
use ostia_contract::capabilities::Capability;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value};

const MAX_SERVERS_OFF: usize = 64;
const MAX_APPROVED_KINDS: usize = 64;
const MAX_CLAIM_LENGTH: usize = 2048;
const MAX_SERVER_NAME_LENGTH: usize = 40;

const ALL_CAPABILITIES: [Capability; 27] = [
    Capability::DriveSelf,
    Capability::ReadBoard,
    Capability::SendOtherPane,
    Capability::TypeOtherPane,
    Capability::ReadOtherPane,
    Capability::KillPane,
    Capability::AllWorkspaces,
    Capability::Shell,
    Capability::Destructive,
    Capability::Phone,
    Capability::Gateway,
    Capability::Notify,
    Capability::Process,
    Capability::VaultRead,
    Capability::VaultWrite,
    Capability::Browse,
    Capability::SettingsRead,
    Capability::SettingsWrite,
    Capability::Assist,
    Capability::Credentials,
    Capability::LanguageServer,
    Capability::AgentPlugin,
    Capability::AgentComplete,
    Capability::Mcp,
    Capability::ReadBus,
    Capability::FileContents,
    Capability::PhoneScreens,
];

const HUMAN_GRANTED_CAPABILITIES: [Capability; 4] = [
    Capability::Mcp,
    Capability::ReadBus,
    Capability::FileContents,
    Capability::PhoneScreens,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewPriority {
    Default,
    Option,
}

impl ViewPriority {
    fn name(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Option => "option",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KindRoles {
    pub id: String,
    pub filename_patterns: Vec<String>,
    pub view: Option<ViewPriority>,
    pub browse: bool,
}

fn kind_claim(kind: &KindRoles) -> String {
    let mut patterns: Vec<String> = kind
        .filename_patterns
        .iter()
        .map(|pattern| pattern.to_lowercase())
        .collect();
    patterns.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    patterns.dedup();
    let mut roles = Vec::new();
    if let Some(priority) = kind.view {
        roles.push(format!("view:{}", priority.name()));
    }
    if kind.browse {
        roles.push("browse".to_owned());
    }
    format!("{}:{}:{}", kind.id, roles.join("+"), patterns.join(","))
}

fn is_empty_list(list: &[String]) -> bool {
    list.is_empty()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRecord {
    pub enabled: bool,
    pub approved: Option<Vec<Capability>>,
    #[serde(skip_serializing_if = "is_empty_list")]
    pub approved_kinds: Vec<String>,
    #[serde(skip_serializing_if = "is_empty_list")]
    pub servers_off: Vec<String>,
}

pub fn granted_caps(requested: &[Capability], approved: Option<&[Capability]>) -> Vec<Capability> {
    let Some(approved) = approved else {
        return Vec::new();
    };
    requested
        .iter()
        .filter(|cap| approved.contains(cap))
        .copied()
        .collect()
}

pub fn kind_approved(builtin: bool, record: Option<&ExtensionRecord>, kind: &KindRoles) -> bool {
    builtin || record.is_some_and(|record| record.approved_kinds.contains(&kind_claim(kind)))
}

pub fn effective_record(
    builtin: bool,
    record: Option<&ExtensionRecord>,
    declared: &[Capability],
) -> ExtensionRecord {
    if let Some(record) = record {
        let missing: Vec<Capability> = if builtin {
            let approved = record.approved.as_deref().unwrap_or_default();
            declared
                .iter()
                .filter(|cap| !approved.contains(cap))
                .copied()
                .collect()
        } else {
            Vec::new()
        };
        if missing.is_empty() {
            return record.clone();
        }
        let mut approved = record.approved.clone().unwrap_or_default();
        approved.extend(missing);
        return ExtensionRecord {
            approved: Some(approved),
            ..record.clone()
        };
    }
    if builtin {
        let mut approved: Vec<Capability> = ALL_CAPABILITIES
            .iter()
            .filter(|cap| !HUMAN_GRANTED_CAPABILITIES.contains(cap))
            .copied()
            .collect();
        approved.extend_from_slice(declared);
        ExtensionRecord {
            enabled: true,
            approved: Some(approved),
            approved_kinds: Vec::new(),
            servers_off: Vec::new(),
        }
    } else {
        ExtensionRecord {
            enabled: false,
            approved: None,
            approved_kinds: Vec::new(),
            servers_off: Vec::new(),
        }
    }
}

pub fn needs_approval(builtin: bool, record: Option<&ExtensionRecord>) -> bool {
    !builtin && record.is_none_or(|record| record.approved.is_none())
}

fn capability_named(name: &Value) -> Option<Capability> {
    ALL_CAPABILITIES
        .iter()
        .find(|cap| name.as_str() == Some(cap.name()))
        .copied()
}

fn short_strings(raw: Option<&Value>, max_units: usize, max_count: usize) -> Vec<String> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(Value::as_str)
        .filter(|text| utf16_len(text) <= max_units)
        .take(max_count)
        .map(str::to_owned)
        .collect()
}

fn parse_record(value: &Value) -> Option<ExtensionRecord> {
    if !(value.is_object() || value.is_array()) {
        return None;
    }
    let approved = match value.get("approved") {
        Some(Value::Array(items)) => Some(items.iter().filter_map(capability_named).collect()),
        _ => None,
    };
    Some(ExtensionRecord {
        enabled: value.get("enabled") == Some(&Value::Bool(true)),
        approved,
        approved_kinds: short_strings(
            value.get("approvedKinds"),
            MAX_CLAIM_LENGTH,
            MAX_APPROVED_KINDS,
        ),
        servers_off: short_strings(
            value.get("serversOff"),
            MAX_SERVER_NAME_LENGTH,
            MAX_SERVERS_OFF,
        ),
    })
}

type Records = Vec<(String, ExtensionRecord)>;

fn sanitize(raw: Option<&Value>) -> Records {
    let Some(Value::Object(map)) = raw else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(id, value)| Some((id.clone(), parse_record(value)?)))
        .collect()
}

fn to_file(records: &Records) -> Map<String, Value> {
    records
        .iter()
        .map(|(id, record)| {
            (
                id.clone(),
                serde_json::to_value(record).unwrap_or(Value::Null),
            )
        })
        .collect()
}

#[derive(Clone)]
pub struct ExtensionStore {
    path: Arc<PathBuf>,
    records: Arc<Mutex<Records>>,
}

impl ExtensionStore {
    pub fn new(path: PathBuf) -> Self {
        let records = sanitize(load_json(&path).as_ref());
        Self {
            path: Arc::new(path),
            records: Arc::new(Mutex::new(records)),
        }
    }

    pub fn get(&self, id: &str) -> Option<ExtensionRecord> {
        self.records
            .lock()
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, record)| record.clone())
    }

    pub fn reload(&self) {
        *self.records.lock() = sanitize(load_json(&self.path).as_ref());
    }

    pub fn set(&self, id: &str, record: ExtensionRecord) -> Result<()> {
        let mut records = self.records.lock();
        match records.iter_mut().find(|(key, _)| key == id) {
            Some(entry) => entry.1 = record,
            None => records.push((id.to_owned(), record)),
        }
        self.save(&records)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let mut records = self.records.lock();
        let Some(index) = records.iter().position(|(key, _)| key == id) else {
            return Ok(());
        };
        records.remove(index);
        self.save(&records)
    }

    fn save(&self, records: &Records) -> Result<()> {
        save_json(&self.path, &to_file(records), SaveOptions::default())
    }
}
