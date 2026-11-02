use std::path::PathBuf;

use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileTarget {
    pub path: PathBuf,
    pub line: Option<u64>,
    pub column: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenFileError {
    NotFound,
    Directory,
    NotAFile,
    Unreadable,
    OutsideSandbox,
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
