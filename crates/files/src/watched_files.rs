use std::path::{Path, PathBuf};

use globset::{GlobBuilder, GlobMatcher};
use ostia_base::js::utf16_len;
use ostia_base::path_guard::is_inside_path;
use serde::Serialize;
use serde_json::{Map, Value};
use url::Url;

use crate::file_watch::{TreeChange, TreeChangeKind};

pub const WATCHED_FILES_METHOD: &str = "workspace/didChangeWatchedFiles";
const MAX_FILE_WATCHERS: usize = 200;
const MAX_FILE_EVENTS: usize = 500;
const PATTERN_MAX: usize = 1000;
const WATCH_CREATE: u32 = 1;
const WATCH_CHANGE: u32 = 2;
const WATCH_DELETE: u32 = 4;
const WATCH_ALL: u32 = WATCH_CREATE | WATCH_CHANGE | WATCH_DELETE;

fn kind_bit(kind: TreeChangeKind) -> u32 {
    match kind {
        TreeChangeKind::Created => WATCH_CREATE,
        TreeChangeKind::Changed => WATCH_CHANGE,
        TreeChangeKind::Deleted => WATCH_DELETE,
    }
}

fn file_change_type(kind: TreeChangeKind) -> u32 {
    match kind {
        TreeChangeKind::Created => 1,
        TreeChangeKind::Changed => 2,
        TreeChangeKind::Deleted => 3,
    }
}

#[derive(Clone, Debug)]
pub struct FileWatcher {
    pub base: Option<PathBuf>,
    matcher: GlobMatcher,
    pub kinds: u32,
}

impl FileWatcher {
    pub fn matches(&self, path: &str) -> bool {
        self.matcher.is_match(path)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FileEvent {
    pub uri: String,
    #[serde(rename = "type")]
    pub kind: u32,
}

fn file_path(uri: Option<&Value>) -> Option<PathBuf> {
    Url::parse(uri?.as_str()?).ok()?.to_file_path().ok()
}

fn matcher(pattern: Option<&Value>) -> Option<GlobMatcher> {
    let pattern = pattern?.as_str()?;
    if pattern.is_empty() || utf16_len(pattern) > PATTERN_MAX {
        return None;
    }
    GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .ok()
        .map(|glob| glob.compile_matcher())
}

fn int32(number: &serde_json::Number) -> u32 {
    let value = number.as_f64().unwrap_or(0.0);
    if !value.is_finite() {
        return 0;
    }
    value.trunc().rem_euclid(4_294_967_296.0) as u32
}

fn parse_watcher(raw: &Value, root: &Path) -> Option<FileWatcher> {
    let raw = raw.as_object()?;
    let kinds = match raw.get("kind") {
        Some(Value::Number(number)) => int32(number) & WATCH_ALL,
        _ => WATCH_ALL,
    };
    let glob = raw.get("globPattern")?;
    if let Some(pattern) = glob.as_str() {
        let matcher = matcher(Some(glob))?;
        let base = if pattern.starts_with('/') {
            None
        } else {
            Some(root.to_path_buf())
        };
        return Some(FileWatcher {
            base,
            matcher,
            kinds,
        });
    }
    let glob: &Map<String, Value> = glob.as_object()?;
    let base_uri = glob.get("baseUri");
    let base = file_path(match base_uri.and_then(Value::as_object) {
        Some(folder) => folder.get("uri"),
        None => base_uri,
    })?;
    let matcher = matcher(glob.get("pattern"))?;
    if !is_inside_path(root, &base) {
        return None;
    }
    Some(FileWatcher {
        base: Some(base),
        matcher,
        kinds,
    })
}

pub fn parse_file_watchers(register_options: &Value, root: &Path) -> Vec<FileWatcher> {
    register_options
        .get("watchers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(MAX_FILE_WATCHERS)
                .filter_map(|raw| parse_watcher(raw, root))
                .collect()
        })
        .unwrap_or_default()
}

fn watches(watcher: &FileWatcher, change: &TreeChange) -> bool {
    if watcher.kinds & kind_bit(change.kind) == 0 {
        return false;
    }
    let Some(base) = &watcher.base else {
        return watcher.matches(&change.path.to_string_lossy());
    };
    if !is_inside_path(base, &change.path) || change.path == *base {
        return false;
    }
    match change.path.strip_prefix(base) {
        Ok(relative) => watcher.matches(&relative.to_string_lossy()),
        Err(_) => false,
    }
}

pub fn watched_file_events(
    watchers: &[FileWatcher],
    changes: &[TreeChange],
    root: &Path,
) -> Vec<FileEvent> {
    let mut events = Vec::new();
    for change in changes {
        if !is_inside_path(root, &change.path)
            || !watchers.iter().any(|watcher| watches(watcher, change))
        {
            continue;
        }
        let Ok(uri) = Url::from_file_path(&change.path) else {
            continue;
        };
        events.push(FileEvent {
            uri: uri.to_string(),
            kind: file_change_type(change.kind),
        });
        if events.len() >= MAX_FILE_EVENTS {
            break;
        }
    }
    events
}
