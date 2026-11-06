use std::collections::HashMap;

use indexmap::IndexMap;
use ostia_base::js::utf16_len;
use serde::{Deserialize, Serialize};

pub const ARTIFACTS_ENV: &str = "ARTIFACTS";
pub const PAD_ENV: &str = "PAD";
pub const PAD_FILE: &str = "PAD.md";
pub const PAD_MAX_BYTES: usize = 256 * 1024;
pub const PAD_SAVE_DELAY_MS: u64 = 1000;
pub const PAD_COMMAND: &str = "workspace.openPad";
pub const ARTIFACT_LIST_MAX: usize = 200;
pub const ARTIFACT_FILE_MAX_BYTES: u64 = 16 * 1024 * 1024;
pub const ARTIFACT_KEEP_CLOSED_MS: u64 = 14 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactListing {
    pub dir: String,
    pub pad: String,
    pub pad_modified: Option<i64>,
    pub entries: Vec<ArtifactEntry>,
}

pub fn is_inside(dir: Option<&str>, path: Option<&str>) -> bool {
    match (dir, path) {
        (Some(dir), Some(path)) if !dir.is_empty() => path
            .strip_prefix(dir)
            .is_some_and(|rest| rest.starts_with('/')),
        _ => false,
    }
}

pub fn is_pad_path(pad: Option<&str>, path: Option<&str>) -> bool {
    matches!((pad, path), (Some(pad), Some(path)) if pad == path)
}

pub fn changed_artifacts(before: &[ArtifactEntry], after: &[ArtifactEntry]) -> Vec<String> {
    let known: HashMap<&str, i64> = before
        .iter()
        .map(|entry| (entry.path.as_str(), entry.modified))
        .collect();
    after
        .iter()
        .filter(|entry| {
            known
                .get(entry.path.as_str())
                .is_none_or(|seen| entry.modified > *seen)
        })
        .map(|entry| entry.path.clone())
        .collect()
}

pub fn exceeds_pad(text: &str) -> bool {
    let units = utf16_len(text);
    if units > PAD_MAX_BYTES {
        return true;
    }
    if units * 3 <= PAD_MAX_BYTES {
        return false;
    }
    text.len() > PAD_MAX_BYTES
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactChangeKind {
    Added,
    Changed,
    Removed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactChange {
    pub path: String,
    pub change: ArtifactChangeKind,
}

pub fn artifact_changes(
    before: &IndexMap<String, i64>,
    after: &IndexMap<String, i64>,
) -> Vec<ArtifactChange> {
    let mut changes = Vec::new();
    for (path, modified) in after {
        match before.get(path) {
            None => changes.push(ArtifactChange {
                path: path.clone(),
                change: ArtifactChangeKind::Added,
            }),
            Some(seen) if modified > seen => changes.push(ArtifactChange {
                path: path.clone(),
                change: ArtifactChangeKind::Changed,
            }),
            Some(_) => {}
        }
    }
    for path in before.keys() {
        if !after.contains_key(path) {
            changes.push(ArtifactChange {
                path: path.clone(),
                change: ArtifactChangeKind::Removed,
            });
        }
    }
    changes
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactVersion {
    pub id: String,
    pub time: i64,
    pub size: u64,
    pub current: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactVersionContent {
    pub file: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub sources: IndexMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactRestore {
    pub restored: Vec<String>,
    pub refused: Vec<String>,
}
