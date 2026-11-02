use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use ostia_base::error::Result;
use ostia_base::js::static_regex;
use ostia_base::node_path::{self, join, normalize};
use parking_lot::Mutex;
use regex::Regex;
use sha2::{Digest, Sha256};

use crate::plugins_farm::remove_any;
use crate::srt_config::SSH_AGENT_SOCKET_NAME;

const SHORT_HASH_CHARS: usize = 10;

static INSTANCE_TMP_NAME: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[0-9]+$"));

type EnabledCheck = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Clone)]
pub struct KeptTmp {
    tmp_root: PathBuf,
    enabled: EnabledCheck,
}

impl KeptTmp {
    pub fn new(tmp_root: PathBuf, enabled: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self {
            tmp_root,
            enabled: Arc::new(enabled),
        }
    }

    pub fn tmp_root(&self) -> &Path {
        &self.tmp_root
    }

    fn enabled(&self) -> bool {
        (self.enabled)()
    }
}

#[derive(Clone)]
pub struct SandboxTmpDeps {
    pub tmp_root: PathBuf,
    pub pid: i32,
    pub kept: Option<KeptTmp>,
}

#[derive(Clone)]
pub struct SandboxTmpDirs {
    deps: SandboxTmpDeps,
    instance_tmp: PathBuf,
    tmp_dirs: Arc<Mutex<HashMap<String, PathBuf>>>,
}

fn short_hash(workspace_id: &str) -> String {
    let digest = hex::encode(Sha256::digest(workspace_id.as_bytes()));
    digest[..SHORT_HASH_CHARS].to_owned()
}

fn dirname(path: &Path) -> PathBuf {
    match path.parent() {
        Some(parent) if parent.as_os_str().is_empty() => PathBuf::from("."),
        Some(parent) => parent.to_path_buf(),
        None => path.to_path_buf(),
    }
}

fn instance_tmp_names(tmp_root: &Path) -> Vec<String> {
    fs::read_dir(tmp_root)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .filter(|name| INSTANCE_TMP_NAME.is_match(name))
                .collect()
        })
        .unwrap_or_default()
}

impl SandboxTmpDirs {
    pub fn new(deps: SandboxTmpDeps) -> Self {
        let instance_tmp = join(&deps.tmp_root, &deps.pid.to_string());
        Self {
            deps,
            instance_tmp,
            tmp_dirs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn tmp_dir(&self, workspace_id: &str) -> PathBuf {
        if let Some(chosen) = self.tmp_dirs.lock().get(workspace_id) {
            return chosen.clone();
        }
        let short = short_hash(workspace_id);
        let dir = match &self.deps.kept {
            Some(kept) if kept.enabled() => join(kept.tmp_root(), &short),
            _ => join(&self.instance_tmp, &short),
        };
        self.tmp_dirs
            .lock()
            .entry(workspace_id.to_owned())
            .or_insert(dir)
            .clone()
    }

    pub fn plugins_dir(&self, workspace_id: &str) -> PathBuf {
        let tmp_dir = self.tmp_dir(workspace_id);
        let name = tmp_dir
            .file_name()
            .unwrap_or(OsStr::new(""))
            .to_string_lossy();
        join(&dirname(&tmp_dir), &format!("{name}-plugins"))
    }

    pub fn plugins_data(&self, workspace_id: &str) -> PathBuf {
        join(&self.tmp_dir(workspace_id), "plugin-data")
    }

    pub fn adopt_kept_tmp(&self, workspace_id: &str, dir: PathBuf) {
        self.tmp_dirs.lock().insert(workspace_id.to_owned(), dir);
    }

    pub fn ssh_agent_socket(&self, workspace_id: &str) -> PathBuf {
        join(&self.tmp_dir(workspace_id), SSH_AGENT_SOCKET_NAME)
    }

    pub fn remove(&self, workspace_id: &str) -> Result<()> {
        remove_any(&self.tmp_dir(workspace_id))?;
        remove_any(&self.plugins_dir(workspace_id))?;
        self.tmp_dirs.lock().remove(workspace_id);
        Ok(())
    }

    pub fn clear_tmp(&self, including_kept: bool) -> Result<()> {
        remove_any(&self.instance_tmp)?;
        if including_kept && let Some(kept) = &self.deps.kept {
            remove_any(kept.tmp_root())?;
        }
        Ok(())
    }

    pub fn sweep_kept_tmp(&self, live_workspace_ids: &[&str]) -> Result<Vec<PathBuf>> {
        let Some(kept) = &self.deps.kept else {
            return Ok(Vec::new());
        };
        let live: Vec<PathBuf> = live_workspace_ids
            .iter()
            .flat_map(|id| [self.tmp_dir(id), self.plugins_dir(id)])
            .collect();
        let Ok(entries) = fs::read_dir(kept.tmp_root()) else {
            return Ok(Vec::new());
        };
        let names: Vec<_> = entries
            .filter_map(|entry| entry.ok().map(|entry| entry.file_name()))
            .collect();
        let mut removed = Vec::new();
        for name in names {
            let dir = normalize(&kept.tmp_root().join(name));
            if live.contains(&dir) {
                continue;
            }
            remove_any(&dir)?;
            removed.push(dir);
        }
        Ok(removed)
    }

    pub fn sweep_tmp(&self, alive: impl Fn(i32) -> bool) -> Result<Vec<PathBuf>> {
        let mut removed = Vec::new();
        for name in instance_tmp_names(&self.deps.tmp_root) {
            let pid = name.parse::<i32>().ok();
            if pid.is_some_and(|pid| pid == self.deps.pid || alive(pid)) {
                continue;
            }
            let dir = node_path::join(&self.deps.tmp_root, &name);
            remove_any(&dir)?;
            removed.push(dir);
        }
        Ok(removed)
    }
}
