use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use ostia_base::Host;
use ostia_base::js::locale_compare;
use ostia_base::node_path;
use ostia_base::path_guard::expand_home;
use ostia_contract::remote_folders::is_remote_path;
use ostia_sandbox::visibility::{
    SandboxReadRules, leads_into_sandbox, sandbox_entries, visible_in_sandbox,
};
use serde::Serialize;
use serde_json::Value;

pub const COMPLETION_ENTRIES_MAX: usize = 10_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CompletionEntry {
    pub name: String,
    pub dir: bool,
}

#[derive(Clone, Debug)]
pub struct CompletionPane {
    pub owners: HashSet<String>,
    pub local_prompt: bool,
    pub rules: Option<SandboxReadRules>,
}

#[derive(Clone)]
struct RawEntry {
    name: String,
    is_dir: bool,
    is_symlink: bool,
}

fn real_or_none(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

fn shell_folder(
    dir: &str,
    home: &Path,
    cwd: &Path,
    rules: Option<&SandboxReadRules>,
) -> Option<PathBuf> {
    let lexical = node_path::resolve(&expand_home(dir, home), cwd);
    let Some(rules) = rules else {
        return Some(lexical);
    };
    let real = real_or_none(&lexical)?;
    let text = real.to_str()?;
    (visible_in_sandbox(text, rules) || leads_into_sandbox(text, rules)).then_some(real)
}

fn first_entries(dir: &Path) -> Vec<RawEntry> {
    let Ok(reader) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    for entry in reader {
        let Ok(entry) = entry else {
            return Vec::new();
        };
        let kind = entry.file_type().ok();
        entries.push(RawEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: kind.is_some_and(|kind| kind.is_dir()),
            is_symlink: kind.is_some_and(|kind| kind.is_symlink()),
        });
        if entries.len() >= COMPLETION_ENTRIES_MAX {
            break;
        }
    }
    entries
}

fn links_to_folder(path: &Path, rules: Option<&SandboxReadRules>) -> bool {
    if let Some(rules) = rules {
        let visible = real_or_none(path)
            .as_deref()
            .and_then(Path::to_str)
            .is_some_and(|target| visible_in_sandbox(target, rules));
        if !visible {
            return false;
        }
    }
    fs::metadata(path).is_ok_and(|meta| meta.is_dir())
}

fn list_folder(
    dir: &str,
    home: &Path,
    cwd: &Path,
    rules: Option<&SandboxReadRules>,
) -> Vec<CompletionEntry> {
    let Some(folder) = shell_folder(dir, home, cwd, rules) else {
        return Vec::new();
    };
    let read = first_entries(&folder);
    let shown = match rules {
        None => read,
        Some(rules) => match folder.to_str() {
            Some(text) => sandbox_entries(text, &read, rules, |entry| entry.name.as_str()),
            None => Vec::new(),
        },
    };
    let mut entries: Vec<CompletionEntry> = shown
        .into_iter()
        .map(|entry| CompletionEntry {
            dir: if entry.is_symlink {
                links_to_folder(&folder.join(&entry.name), rules)
            } else {
                entry.is_dir
            },
            name: entry.name,
        })
        .collect();
    entries.sort_by(|a, b| {
        if a.dir == b.dir {
            locale_compare(&a.name, &b.name)
        } else if a.dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });
    entries
}

pub async fn completion_paths(
    host: &Host,
    pane_of: &impl Fn(&str) -> Option<CompletionPane>,
    sender_id: &str,
    pane_id: &Value,
    dir: &Value,
) -> Vec<CompletionEntry> {
    let (Some(pane_id), Some(dir)) = (pane_id.as_str(), dir.as_str()) else {
        return Vec::new();
    };
    if dir.is_empty() || dir.contains('\0') || is_remote_path(Some(dir)) {
        return Vec::new();
    }
    let Some(pane) = pane_of(pane_id) else {
        return Vec::new();
    };
    if !pane.owners.contains(sender_id) || !pane.local_prompt {
        return Vec::new();
    }
    let dir = dir.to_owned();
    let home = host.home.clone();
    let cwd = host.cwd.clone();
    tokio::task::spawn_blocking(move || list_folder(&dir, &home, &cwd, pane.rules.as_ref()))
        .await
        .unwrap_or_default()
}
