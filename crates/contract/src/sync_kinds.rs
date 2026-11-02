use serde::Serialize;
use serde_json::{Map, Value};

pub const SYNC_KINDS: [SyncKind; 5] = [
    SyncKind::Settings,
    SyncKind::Snippets,
    SyncKind::Completions,
    SyncKind::Views,
    SyncKind::Extensions,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncKind {
    Settings,
    Snippets,
    Completions,
    Views,
    Extensions,
}

impl SyncKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::Snippets => "snippets",
            Self::Completions => "completions",
            Self::Views => "views",
            Self::Extensions => "extensions",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct SyncKinds {
    pub settings: bool,
    pub snippets: bool,
    pub completions: bool,
    pub views: bool,
    pub extensions: bool,
}

impl SyncKinds {
    pub fn get(&self, kind: SyncKind) -> bool {
        match kind {
            SyncKind::Settings => self.settings,
            SyncKind::Snippets => self.snippets,
            SyncKind::Completions => self.completions,
            SyncKind::Views => self.views,
            SyncKind::Extensions => self.extensions,
        }
    }
}

fn is_off(raw: &Value, kind: SyncKind) -> bool {
    raw.get(kind.as_str()) == Some(&Value::Bool(false))
}

pub fn parse_sync_kinds(raw: &Value) -> SyncKinds {
    SyncKinds {
        settings: !is_off(raw, SyncKind::Settings),
        snippets: !is_off(raw, SyncKind::Snippets),
        completions: !is_off(raw, SyncKind::Completions),
        views: !is_off(raw, SyncKind::Views),
        extensions: !is_off(raw, SyncKind::Extensions),
    }
}

pub fn off_kinds(raw: &Value) -> Option<Value> {
    let off: Map<String, Value> = SYNC_KINDS
        .into_iter()
        .filter(|kind| is_off(raw, *kind))
        .map(|kind| (kind.as_str().to_owned(), Value::Bool(false)))
        .collect();
    (!off.is_empty()).then_some(Value::Object(off))
}
