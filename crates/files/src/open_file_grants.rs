use std::collections::HashSet;
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};

use ostia_base::Result;
use ostia_base::host::Host;
use ostia_base::json_store::{SaveOptions, load_json, save_json};
use ostia_base::node_path::resolve;
use ostia_base::path_guard::{expand_home, resolve_safe};
use ostia_contract::archive_paths::is_archive_path;
use ostia_contract::open_files::{OpenFileError, OpenFileVerdict};
use parking_lot::Mutex;
use rustix::fs::Access;
use serde_json::json;

const OPEN_FILE_GRANTS_MAX: usize = 200;

pub struct OpenFileGrantsDeps {
    pub roots: Box<dyn Fn() -> Vec<String> + Send + Sync>,
    pub file: PathBuf,
    pub max: Option<usize>,
    pub host: Host,
}

#[derive(Clone, Copy, Debug)]
pub struct AdmitOptions {
    pub sandboxed: bool,
    pub remember: bool,
}

struct Located {
    real: PathBuf,
    stat: Metadata,
}

struct Grants {
    session: HashSet<String>,
    remembered: Vec<String>,
}

pub struct OpenFileGrants {
    deps: OpenFileGrantsDeps,
    grants: Mutex<Grants>,
}

fn stored_paths(file: &Path) -> Vec<String> {
    let Some(stored) = load_json(file) else {
        return Vec::new();
    };
    let Some(paths) = stored.get("paths").and_then(|paths| paths.as_array()) else {
        return Vec::new();
    };
    paths
        .iter()
        .filter_map(|path| path.as_str())
        .filter(|path| Path::new(path).is_absolute())
        .map(str::to_owned)
        .collect()
}

fn locate(path: &Path) -> Option<Located> {
    let real = fs::canonicalize(path).ok()?;
    let stat = fs::metadata(&real).ok()?;
    Some(Located { real, stat })
}

fn is_readable(path: &Path) -> bool {
    rustix::fs::access(path, Access::READ_OK).is_ok()
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn refused(path: String, error: OpenFileError) -> OpenFileVerdict {
    OpenFileVerdict::Refused { path, error }
}

impl OpenFileGrants {
    pub fn new(deps: OpenFileGrantsDeps) -> Self {
        let remembered = stored_paths(&deps.file);
        Self {
            deps,
            grants: Mutex::new(Grants {
                session: HashSet::new(),
                remembered,
            }),
        }
    }

    fn safe(&self, path: &str, roots: &[String]) -> Option<PathBuf> {
        let roots: Vec<&str> = roots.iter().map(String::as_str).collect();
        resolve_safe(path, &roots, &self.deps.host)
    }

    pub fn admit(&self, raw: &str, options: AdmitOptions) -> Result<OpenFileVerdict> {
        let expanded = expand_home(raw, &self.deps.host.home);
        if !expanded.is_absolute() {
            return Ok(refused(raw.to_owned(), OpenFileError::NotFound));
        }
        let roots = (self.deps.roots)();
        let inside = self.safe(&text(&expanded), &roots);
        let path = inside
            .clone()
            .unwrap_or_else(|| resolve(&expanded, &self.deps.host.cwd));
        if inside.is_none() && options.sandboxed {
            return Ok(refused(text(&path), OpenFileError::OutsideSandbox));
        }
        let found = locate(&path);
        if found.as_ref().is_some_and(|found| found.stat.is_dir()) {
            return Ok(refused(text(&path), OpenFileError::Directory));
        }
        if let Some(inside) = inside {
            return Ok(OpenFileVerdict::Admitted {
                path: text(&inside),
            });
        }
        let Some(found) = found else {
            return Ok(refused(text(&path), OpenFileError::NotFound));
        };
        if !found.stat.is_file() {
            return Ok(refused(text(&path), OpenFileError::NotAFile));
        }
        if !is_readable(&found.real) {
            return Ok(refused(text(&path), OpenFileError::Unreadable));
        }
        if self.safe(&text(&found.real), &roots).is_none() {
            self.grant(&text(&found.real), options.remember)?;
        }
        Ok(OpenFileVerdict::Admitted {
            path: text(&found.real),
        })
    }

    pub fn confine(&self, path: &str) -> Option<String> {
        if is_archive_path(Some(path)) {
            return None;
        }
        if let Some(safe) = self.safe(path, &(self.deps.roots)()) {
            return Some(text(&safe));
        }
        let resolved = resolve(Path::new(path), &self.deps.host.cwd);
        let resolved_text = text(&resolved);
        {
            let grants = self.grants.lock();
            if !grants.session.contains(&resolved_text)
                && !grants.remembered.contains(&resolved_text)
            {
                return None;
            }
        }
        let found = locate(&resolved)?;
        (found.real == resolved && found.stat.is_file()).then_some(resolved_text)
    }

    fn grant(&self, path: &str, remember: bool) -> Result<()> {
        let mut grants = self.grants.lock();
        if !remember {
            if !grants.remembered.iter().any(|known| known == path) {
                grants.session.insert(path.to_owned());
            }
            return Ok(());
        }
        let max = self.deps.max.unwrap_or(OPEN_FILE_GRANTS_MAX);
        let mut next: Vec<String> = grants
            .remembered
            .iter()
            .filter(|known| known.as_str() != path)
            .cloned()
            .collect();
        next.push(path.to_owned());
        let keep_from = if max == 0 {
            0
        } else {
            next.len().saturating_sub(max)
        };
        let kept = next.split_off(keep_from);
        grants.session.extend(next);
        grants.remembered = kept;
        save_json(
            &self.deps.file,
            &json!({ "paths": grants.remembered }),
            SaveOptions::SECURE,
        )
    }
}
