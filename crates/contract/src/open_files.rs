use std::path::PathBuf;

use serde::Serialize;
use serde::ser::SerializeMap;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileTarget {
    pub path: PathBuf,
    pub line: Option<u64>,
    pub column: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenFileError {
    NotFound,
    Directory,
    NotAFile,
    Unreadable,
    OutsideSandbox,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WaitOutcome {
    Closed,
    Gone,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenFileVerdict {
    Admitted { path: String },
    Refused { path: String, error: OpenFileError },
}

impl Serialize for OpenFileVerdict {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Admitted { path } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("ok", &true)?;
                map.serialize_entry("path", path)?;
                map.end()
            }
            Self::Refused { path, error } => {
                let mut map = serializer.serialize_map(Some(3))?;
                map.serialize_entry("ok", &false)?;
                map.serialize_entry("path", path)?;
                map.serialize_entry("error", error)?;
                map.end()
            }
        }
    }
}

pub const OPEN_FILES_COMMAND: &str = "editor.openFiles";
pub const REVEAL_FOLDER_COMMAND: &str = "files.reveal";
pub const OPEN_DIFF_COMMAND: &str = "diff.openFiles";
pub const OPEN_FILES_MAX: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenTargetKind {
    Url,
    Stdin,
    Path,
}

fn position(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_number()?;
    if let Some(whole) = number.as_u64() {
        return (whole > 0).then_some(whole);
    }
    let float = number.as_f64()?;
    (float.fract() == 0.0 && float > 0.0 && float < u64::MAX as f64).then_some(float as u64)
}

pub fn parse_file_targets(raw: &Value) -> Option<Vec<FileTarget>> {
    let items = raw.as_array()?;
    if items.is_empty() || items.len() > OPEN_FILES_MAX {
        return None;
    }
    let mut targets = Vec::with_capacity(items.len());
    for item in items {
        let path = item.get("path").and_then(Value::as_str)?;
        if path.is_empty() {
            return None;
        }
        let line = position(item.get("line"));
        let column = line.and_then(|_| position(item.get("column")));
        targets.push(FileTarget {
            path: PathBuf::from(path),
            line,
            column,
        });
    }
    Some(targets)
}

pub fn opened_pane_ids(result: &Value) -> Vec<String> {
    result
        .get("opened")
        .and_then(Value::as_array)
        .map(|opened| {
            opened
                .iter()
                .filter_map(|entry| entry.get("paneId").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn open_target_kind(word: &str) -> OpenTargetKind {
    if word == "-" {
        return OpenTargetKind::Stdin;
    }
    let lower = word.as_bytes();
    let is_url = ["http://", "https://"].iter().any(|scheme| {
        lower.len() >= scheme.len() && lower[..scheme.len()].eq_ignore_ascii_case(scheme.as_bytes())
    });
    if is_url {
        OpenTargetKind::Url
    } else {
        OpenTargetKind::Path
    }
}
