use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use ostia_base::clock::{Clock, system_clock};
use ostia_base::js::{static_regex, utf16_len};
use ostia_base::json_store::{SaveOptions, load_json, save_json};
use ostia_base::random::random_bytes;
use ostia_base::{EventHub, Result, WorkspaceId};
use ostia_contract::agent_resume::{AgentResume, parse_agent_resume};
use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;
use serde_json::{Number, Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::park::{PARK_SUMMARY_MAX, PARKED_PER_WORKSPACE_MAX, single_line};

const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
const TITLE_MAX: usize = 200;
const WORKSPACE_ID_MAX: usize = 200;
const FORMAT: i64 = 1;

static ID_PATTERN: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z2-7]{10}$"));

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkedRecord {
    pub id: String,
    pub workspace_id: WorkspaceId,
    pub resume: AgentResume,
    pub title: String,
    #[serde(skip_serializing_if = "is_false")]
    pub title_pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub parked_at: Number,
}

#[derive(Clone, Debug)]
pub struct ParkInput {
    pub workspace_id: WorkspaceId,
    pub resume: Value,
    pub title: String,
    pub title_pinned: bool,
    pub summary: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ParkResult {
    Parked {
        record: Box<ParkedRecord>,
        updated: bool,
    },
    TooMany,
    Invalid,
}

fn new_id() -> String {
    random_bytes::<10>()
        .iter()
        .map(|byte| BASE32[usize::from(*byte) % 32] as char)
        .collect()
}

fn optional_line(raw: Option<&str>, max: usize) -> Option<String> {
    raw.map(|text| single_line(text, max))
        .filter(|line| !line.is_empty())
}

fn parse_record(raw: &Value) -> Option<ParkedRecord> {
    let record = raw.as_object()?;
    let id = record
        .get("id")?
        .as_str()
        .filter(|id| ID_PATTERN.is_match(id))?;
    let workspace_id = record
        .get("workspaceId")?
        .as_str()
        .filter(|id| !id.is_empty() && utf16_len(id) <= WORKSPACE_ID_MAX)?;
    let mut resume = parse_agent_resume(record.get("resume")?)?;
    resume.typed = None;
    let title = record
        .get("title")?
        .as_str()
        .filter(|title| !title.is_empty())?;
    let parked_at = record.get("parkedAt")?.as_number()?.clone();
    let summary = match record.get("summary") {
        None => None,
        Some(summary) => optional_line(Some(summary.as_str()?), PARK_SUMMARY_MAX),
    };
    Some(ParkedRecord {
        id: id.to_owned(),
        workspace_id: WorkspaceId::new(workspace_id),
        resume,
        title: single_line(title, TITLE_MAX),
        title_pinned: record.get("titlePinned") == Some(&Value::Bool(true)),
        summary,
        parked_at,
    })
}

fn newest_first(a: &ParkedRecord, b: &ParkedRecord) -> Ordering {
    let time = |record: &ParkedRecord| record.parked_at.as_f64().unwrap_or(0.0);
    time(b).partial_cmp(&time(a)).unwrap_or(Ordering::Equal)
}

fn read_items(file: &Path) -> Vec<ParkedRecord> {
    let Some(stored) = load_json(file) else {
        return Vec::new();
    };
    if stored.get("v").and_then(Value::as_i64) != Some(FORMAT) {
        return Vec::new();
    }
    stored
        .get("items")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |items| {
            items.iter().filter_map(parse_record).collect()
        })
}

#[derive(Clone)]
pub struct ParkedStore {
    file: Arc<PathBuf>,
    now: Clock,
    items: Arc<Mutex<Vec<ParkedRecord>>>,
    changed: EventHub<WorkspaceId>,
}

impl ParkedStore {
    pub fn new(file: PathBuf) -> Self {
        Self::with_clock(file, system_clock())
    }

    pub fn with_clock(file: PathBuf, now: Clock) -> Self {
        let items = read_items(&file);
        Self {
            file: Arc::new(file),
            now,
            items: Arc::new(Mutex::new(items)),
            changed: EventHub::default(),
        }
    }

    pub fn subscribe(&self) -> UnboundedReceiver<WorkspaceId> {
        self.changed.subscribe()
    }

    pub fn list(&self, workspace_id: &WorkspaceId) -> Vec<ParkedRecord> {
        let mut found: Vec<ParkedRecord> = self
            .items
            .lock()
            .iter()
            .filter(|item| item.workspace_id == *workspace_id)
            .cloned()
            .collect();
        found.sort_by(newest_first);
        found
    }

    pub fn count(&self, workspace_id: &WorkspaceId) -> usize {
        self.items
            .lock()
            .iter()
            .filter(|item| item.workspace_id == *workspace_id)
            .count()
    }

    pub fn get(&self, id: &str) -> Option<ParkedRecord> {
        self.items.lock().iter().find(|item| item.id == id).cloned()
    }

    pub fn park(&self, input: ParkInput) -> Result<ParkResult> {
        let title = single_line(&input.title, TITLE_MAX);
        let Some(mut resume) = parse_agent_resume(&input.resume) else {
            return Ok(ParkResult::Invalid);
        };
        resume.typed = None;
        if title.is_empty() || input.workspace_id.is_empty() {
            return Ok(ParkResult::Invalid);
        }
        let summary = optional_line(input.summary.as_deref(), PARK_SUMMARY_MAX);
        let mut items = self.items.lock();
        let known = items.iter().position(|item| {
            item.workspace_id == input.workspace_id
                && item.resume.agent == resume.agent
                && item.resume.id == resume.id
        });
        let in_workspace = items
            .iter()
            .filter(|item| item.workspace_id == input.workspace_id)
            .count();
        if known.is_none() && in_workspace >= PARKED_PER_WORKSPACE_MAX {
            return Ok(ParkResult::TooMany);
        }
        let record = ParkedRecord {
            id: known.map_or_else(new_id, |at| items[at].id.clone()),
            workspace_id: input.workspace_id,
            resume,
            title,
            title_pinned: input.title_pinned,
            summary,
            parked_at: Number::from((self.now)()),
        };
        match known {
            Some(at) => items[at] = record.clone(),
            None => items.push(record.clone()),
        }
        self.save(&items)?;
        drop(items);
        self.changed.emit(record.workspace_id.clone());
        Ok(ParkResult::Parked {
            record: Box::new(record),
            updated: known.is_some(),
        })
    }

    pub fn remove(&self, id: &str) -> Result<bool> {
        let mut items = self.items.lock();
        let Some(at) = items.iter().position(|item| item.id == id) else {
            return Ok(false);
        };
        let gone = items.remove(at);
        self.save(&items)?;
        drop(items);
        self.changed.emit(gone.workspace_id);
        Ok(true)
    }

    pub fn settle(
        &self,
        workspace_id: &WorkspaceId,
        agent: &str,
        session_id: &str,
    ) -> Result<usize> {
        let mut items = self.items.lock();
        let before = items.len();
        items.retain(|item| {
            !(item.workspace_id == *workspace_id
                && item.resume.agent.name() == agent
                && item.resume.id == session_id)
        });
        let gone = before - items.len();
        if gone == 0 {
            return Ok(0);
        }
        self.save(&items)?;
        drop(items);
        self.changed.emit(workspace_id.clone());
        Ok(gone)
    }

    fn save(&self, items: &[ParkedRecord]) -> Result<()> {
        save_json(
            &self.file,
            &json!({ "v": FORMAT, "items": items }),
            SaveOptions::SECURE,
        )
    }
}
