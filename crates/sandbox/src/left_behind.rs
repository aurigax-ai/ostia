use std::collections::BTreeMap;
use std::fs::{self, Metadata};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use tokio::runtime::Handle;
use tokio::sync::watch;
use tokio::task::{JoinHandle, spawn_blocking};

pub type LeftBehindBaseline = BTreeMap<String, String>;

const MAX_DEPTH: usize = 6;
const MAX_DIRS: usize = 20_000;
const SKIPPED_DIRS: [&str; 1] = ["node_modules"];

fn file_signature(meta: &Metadata) -> String {
    let mtime_ms = meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1_000_000.0;
    format!("f:{}:{}:{}", meta.ino(), meta.size(), mtime_ms)
}

fn signature_of(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.is_dir() {
        return Some("d".to_owned());
    }
    meta.is_file().then(|| file_signature(&meta))
}

struct Entry {
    name: String,
    is_dir: bool,
    is_file: bool,
}

fn entries_of(dir: &Path) -> Vec<Entry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let kind = entry.file_type().ok()?;
            Some(Entry {
                name: entry.file_name().into_string().ok()?,
                is_dir: kind.is_dir(),
                is_file: kind.is_file(),
            })
        })
        .collect()
}

fn note_git(found: &mut BTreeMap<String, String>, work_dir: &Path, rel: &str, is_directory: bool) {
    let git = work_dir.join(rel);
    if let Some(own) = signature_of(&git) {
        found.insert(rel.to_owned(), own);
    }
    if !is_directory {
        return;
    }
    if let Some(config) = signature_of(&git.join("config")) {
        found.insert(format!("{rel}/config"), config);
    }
    for hook in entries_of(&git.join("hooks")) {
        if !hook.is_file {
            continue;
        }
        if let Some(sig) = signature_of(&git.join("hooks").join(&hook.name)) {
            found.insert(format!("{rel}/hooks/{}", hook.name), sig);
        }
    }
}

fn walk(
    found: &mut BTreeMap<String, String>,
    visited: &mut usize,
    work_dir: &Path,
    rel: &str,
    depth: usize,
) {
    let seen = *visited;
    *visited += 1;
    if seen >= MAX_DIRS {
        return;
    }
    let prefix = if rel.is_empty() {
        String::new()
    } else {
        format!("{rel}/")
    };
    let mut subdirs = Vec::new();
    for entry in entries_of(&work_dir.join(rel)) {
        if entry.name == ".git" {
            note_git(found, work_dir, &format!("{prefix}.git"), entry.is_dir);
        } else if entry.name == ".envrc" && entry.is_file {
            if let Some(sig) = signature_of(&work_dir.join(&prefix).join(".envrc")) {
                found.insert(format!("{prefix}.envrc"), sig);
            }
        } else if entry.is_dir && !SKIPPED_DIRS.contains(&entry.name.as_str()) && depth < MAX_DEPTH
        {
            subdirs.push(format!("{prefix}{}", entry.name));
        }
    }
    for sub in subdirs {
        walk(found, visited, work_dir, &sub, depth + 1);
    }
}

fn scan(work_dir: &Path) -> BTreeMap<String, String> {
    let mut found = BTreeMap::new();
    let mut visited = 0;
    walk(&mut found, &mut visited, work_dir, "", 0);
    found
}

fn changed_since(work_dir: &Path, baseline: &LeftBehindBaseline) -> Vec<String> {
    let changed: Vec<String> = scan(work_dir)
        .into_iter()
        .filter(|(rel, sig)| baseline.get(rel) != Some(sig))
        .map(|(rel, _)| rel)
        .collect();
    let new_repos: Vec<&String> = changed
        .iter()
        .filter(|rel| rel.ends_with("/.git") || rel.as_str() == ".git")
        .collect();
    let mut kept: Vec<String> = changed
        .iter()
        .filter(|rel| {
            !new_repos
                .iter()
                .any(|repo| *rel != *repo && rel.starts_with(&format!("{repo}/")))
        })
        .cloned()
        .collect();
    kept.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    kept
}

pub async fn left_behind_baseline(work_dir: &Path) -> LeftBehindBaseline {
    let work_dir = work_dir.to_path_buf();
    spawn_blocking(move || scan(&work_dir))
        .await
        .unwrap_or_default()
}

pub async fn left_behind_since(work_dir: &Path, baseline: &LeftBehindBaseline) -> Vec<String> {
    let work_dir = work_dir.to_path_buf();
    let baseline = baseline.clone();
    spawn_blocking(move || changed_since(&work_dir, &baseline))
        .await
        .unwrap_or_default()
}

type OnFound = Box<dyn FnOnce(Vec<String>) + Send>;

struct Pending {
    work_dir: PathBuf,
    baseline: JoinHandle<LeftBehindBaseline>,
    on_found: OnFound,
}

pub struct LeftBehindWatch {
    ended: AtomicBool,
    runtime: Handle,
    scanned: watch::Receiver<bool>,
    pending: Mutex<Option<Pending>>,
}

impl LeftBehindWatch {
    pub async fn baseline_taken(&self) {
        let mut scanned = self.scanned.clone();
        let _ = scanned.wait_for(|done| *done).await;
    }

    pub fn end(&self) {
        if self.ended.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(pending) = self.pending.lock().take() else {
            return;
        };
        self.runtime.spawn(async move {
            let Ok(before) = pending.baseline.await else {
                return;
            };
            let paths = left_behind_since(&pending.work_dir, &before).await;
            if !paths.is_empty() {
                (pending.on_found)(paths);
            }
        });
    }
}

pub fn watch_left_behind(
    work_dir: PathBuf,
    on_found: impl FnOnce(Vec<String>) + Send + 'static,
) -> LeftBehindWatch {
    let scan_dir = work_dir.clone();
    let (scanned_tx, scanned) = watch::channel(false);
    let baseline = tokio::task::spawn_blocking(move || {
        let taken = scan(&scan_dir);
        scanned_tx.send_replace(true);
        taken
    });
    LeftBehindWatch {
        ended: AtomicBool::new(false),
        runtime: Handle::current(),
        scanned,
        pending: Mutex::new(Some(Pending {
            work_dir,
            baseline,
            on_found: Box::new(on_found),
        })),
    }
}
