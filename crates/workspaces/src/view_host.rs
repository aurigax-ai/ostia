use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ostia_base::json_store::{SaveOptions, load_json, save_json};
use ostia_base::{EventHub, Result};
use ostia_contract::view_parse::{ViewParseResult, parse_view_text};
use ostia_contract::views::{
    VIEW_FILE_MAX_BYTES, VIEW_FILES_MAX, ViewDoc, ViewIcon, ViewPlacement, ViewProblem,
    view_name_of,
};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::dir_watch::DirWatch;

const RESCAN_DEBOUNCE: Duration = Duration::from_millis(150);

pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ViewRecord {
    pub enabled: bool,
}

fn sanitize(raw: Option<Value>) -> Vec<(String, ViewRecord)> {
    let Some(Value::Object(entries)) = raw else {
        return Vec::new();
    };
    entries
        .iter()
        .filter(|(name, _)| view_name_of(&format!("{name}.json")).is_some())
        .filter(|(_, value)| matches!(value, Value::Object(_) | Value::Array(_)))
        .map(|(name, value)| {
            let enabled = value.get("enabled") == Some(&Value::Bool(true));
            (name.clone(), ViewRecord { enabled })
        })
        .collect()
}

pub struct ViewStore {
    path: PathBuf,
    records: Mutex<Vec<(String, ViewRecord)>>,
}

impl ViewStore {
    pub fn new(path: PathBuf) -> Self {
        let records = sanitize(load_json(&path));
        Self {
            path,
            records: Mutex::new(records),
        }
    }

    pub fn get(&self, name: &str) -> Option<ViewRecord> {
        self.records
            .lock()
            .iter()
            .find(|(known, _)| known == name)
            .map(|(_, record)| *record)
    }

    pub fn set(&self, name: &str, record: ViewRecord) -> Result<()> {
        let mut records = self.records.lock();
        match records.iter_mut().find(|(known, _)| known == name) {
            Some(entry) => entry.1 = record,
            None => records.push((name.to_owned(), record)),
        }
        let stored: Map<String, Value> = records
            .iter()
            .map(|(known, record)| (known.clone(), json!({"enabled": record.enabled})))
            .collect();
        save_json(&self.path, &stored, SaveOptions::default())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewStatus {
    Pending,
    Enabled,
    Disabled,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ViewInfo {
    pub name: String,
    pub file: PathBuf,
    pub status: ViewStatus,
    pub title: String,
    pub placement: Option<ViewPlacement>,
    pub icon: Option<ViewIcon>,
    pub description: Option<String>,
    pub doc: Option<ViewDoc>,
    pub stale: bool,
    pub problems: Vec<ViewProblem>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ViewListing {
    pub dir: PathBuf,
    pub views: Vec<ViewInfo>,
}

struct LoadedFile {
    name: String,
    file: PathBuf,
    doc: Option<ViewDoc>,
    problems: Vec<ViewProblem>,
}

fn read_view_file(path: &Path) -> std::result::Result<String, String> {
    let stat = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if stat.file_type().is_symlink() {
        return Err("symbolic links are not read".to_owned());
    }
    if !stat.is_file() {
        return Err("not a regular file".to_owned());
    }
    if stat.len() > VIEW_FILE_MAX_BYTES as u64 {
        return Err(format!("larger than {} KiB", VIEW_FILE_MAX_BYTES / 1024));
    }
    fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|error| error.to_string())
}

fn load_file(dir: &Path, file_name: &str, name: String) -> LoadedFile {
    let file = dir.join(file_name);
    let (doc, problems) = match read_view_file(&file) {
        Err(message) => (
            None,
            vec![ViewProblem {
                path: "(file)".to_owned(),
                line: None,
                message,
            }],
        ),
        Ok(text) => match parse_view_text(&text) {
            ViewParseResult::Ok(doc) => (Some(*doc), Vec::new()),
            ViewParseResult::Failed(problems) => (None, problems),
        },
    };
    LoadedFile {
        name,
        file,
        doc,
        problems,
    }
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|stat| stat.is_dir())
}

#[derive(Default)]
struct State {
    files: Vec<LoadedFile>,
    last_good: Vec<(String, ViewDoc)>,
    signature: Vec<ViewInfo>,
}

pub struct ViewHostDeps {
    pub dir: PathBuf,
    pub store: ViewStore,
    pub log: Option<LogFn>,
}

struct Inner {
    dir: PathBuf,
    store: ViewStore,
    log: Option<LogFn>,
    state: Mutex<State>,
    changed: EventHub<ViewListing>,
    watch: Mutex<Option<DirWatch>>,
}

#[derive(Clone)]
pub struct ViewHost {
    inner: Arc<Inner>,
}

impl Inner {
    fn note(&self, line: &str) {
        if let Some(log) = &self.log {
            log(line);
        }
    }

    fn scan_files(&self) -> Vec<LoadedFile> {
        if !is_real_dir(&self.dir) {
            return Vec::new();
        }
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|file_name| view_name_of(file_name).is_some())
            .collect();
        names.sort();
        let mut out = Vec::new();
        for file_name in names {
            let Some(name) = view_name_of(&file_name) else {
                continue;
            };
            if out.len() >= VIEW_FILES_MAX {
                self.note(&format!(
                    "only the first {VIEW_FILES_MAX} view files are read"
                ));
                break;
            }
            out.push(load_file(&self.dir, &file_name, name));
        }
        out
    }

    fn status(&self, name: &str) -> ViewStatus {
        match self.store.get(name) {
            None => ViewStatus::Pending,
            Some(record) if record.enabled => ViewStatus::Enabled,
            Some(_) => ViewStatus::Disabled,
        }
    }

    fn info_of(&self, state: &State, loaded: &LoadedFile) -> ViewInfo {
        let status = self.status(&loaded.name);
        let shown = loaded.doc.as_ref().or_else(|| {
            state
                .last_good
                .iter()
                .find(|(name, _)| *name == loaded.name)
                .map(|(_, doc)| doc)
        });
        ViewInfo {
            name: loaded.name.clone(),
            file: loaded.file.clone(),
            status,
            title: shown.map_or_else(|| loaded.name.clone(), |doc| doc.title.clone()),
            placement: shown.map(|doc| doc.placement),
            icon: shown.and_then(|doc| doc.icon),
            description: shown
                .and_then(|doc| ostia_base::js::non_empty(doc.description.as_deref()))
                .map(str::to_owned),
            doc: if status == ViewStatus::Enabled {
                shown.cloned()
            } else {
                None
            },
            stale: loaded.doc.is_none() && shown.is_some(),
            problems: loaded.problems.clone(),
        }
    }

    fn list_of(&self, state: &State) -> Vec<ViewInfo> {
        state
            .files
            .iter()
            .map(|loaded| self.info_of(state, loaded))
            .collect()
    }

    fn listing_of(&self, state: &State) -> ViewListing {
        ViewListing {
            dir: self.dir.clone(),
            views: self.list_of(state),
        }
    }

    fn scan_locked(&self, state: &mut State) -> bool {
        state.files = self.scan_files();
        for loaded in &state.files {
            if let Some(doc) = &loaded.doc {
                match state
                    .last_good
                    .iter_mut()
                    .find(|(name, _)| *name == loaded.name)
                {
                    Some(entry) => entry.1 = doc.clone(),
                    None => state.last_good.push((loaded.name.clone(), doc.clone())),
                }
            }
        }
        let files = &state.files;
        state
            .last_good
            .retain(|(name, _)| files.iter().any(|loaded| loaded.name == *name));
        let signature = self.list_of(state);
        let changed = signature != state.signature;
        state.signature = signature;
        changed
    }
}

impl ViewHost {
    pub fn new(deps: ViewHostDeps) -> Self {
        let inner = Arc::new(Inner {
            dir: deps.dir,
            store: deps.store,
            log: deps.log,
            state: Mutex::new(State::default()),
            changed: EventHub::default(),
            watch: Mutex::new(None),
        });
        {
            let mut state = inner.state.lock();
            inner.scan_locked(&mut state);
        }
        Self { inner }
    }

    pub fn subscribe(&self) -> UnboundedReceiver<ViewListing> {
        self.inner.changed.subscribe()
    }

    pub fn scan(&self) -> bool {
        let mut state = self.inner.state.lock();
        self.inner.scan_locked(&mut state)
    }

    pub fn info(&self, name: &str) -> Option<ViewInfo> {
        let state = self.inner.state.lock();
        let loaded = state.files.iter().find(|loaded| loaded.name == name)?;
        Some(self.inner.info_of(&state, loaded))
    }

    pub fn list(&self) -> Vec<ViewInfo> {
        let state = self.inner.state.lock();
        self.inner.list_of(&state)
    }

    pub fn listing(&self) -> ViewListing {
        let state = self.inner.state.lock();
        self.inner.listing_of(&state)
    }

    pub fn set_enabled(&self, name: &str, enabled: bool) -> Result<ViewListing> {
        let mut state = self.inner.state.lock();
        if state.files.iter().any(|loaded| loaded.name == name) {
            self.inner.store.set(name, ViewRecord { enabled })?;
            state.signature = self.inner.list_of(&state);
            self.inner.changed.emit(self.inner.listing_of(&state));
        }
        Ok(self.inner.listing_of(&state))
    }

    pub fn path_of(&self, name: &str) -> Option<PathBuf> {
        self.inner
            .state
            .lock()
            .files
            .iter()
            .find(|loaded| loaded.name == name)
            .map(|loaded| loaded.file.clone())
    }

    pub fn rescan(&self) {
        let mut state = self.inner.state.lock();
        if self.inner.scan_locked(&mut state) {
            self.inner.changed.emit(self.inner.listing_of(&state));
        }
    }

    pub fn watch(&self) {
        let dir = &self.inner.dir;
        if let Err(error) = fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
        {
            self.inner
                .note(&format!("cannot create {}: {error}", dir.display()));
        }
        self.rescan();
        if !is_real_dir(dir) {
            return;
        }
        let weak = Arc::downgrade(&self.inner);
        let started = DirWatch::start(dir, RESCAN_DEBOUNCE, move || {
            if let Some(inner) = weak.upgrade() {
                Self { inner }.rescan();
            }
        });
        match started {
            Ok(watch) => *self.inner.watch.lock() = Some(watch),
            Err(error) => self
                .inner
                .note(&format!("cannot watch {}: {error}", dir.display())),
        }
    }

    pub fn stop(&self) {
        self.inner.watch.lock().take();
    }
}
