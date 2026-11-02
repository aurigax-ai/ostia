use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::APP_DIR_NAME;
use crate::discrete_gpu::without_gpu_launch_env;
use crate::error::{Result, io_error};
use crate::no_new_privs_relaunch::RELAUNCHED_ENV;
use crate::node_path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Darwin,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Darwin
        } else {
            Self::Linux
        }
    }
}

#[derive(Clone, Debug)]
pub struct Host {
    pub env: BTreeMap<String, String>,
    pub home: PathBuf,
    pub cwd: PathBuf,
    pub platform: Platform,
}

impl Host {
    pub fn current() -> Self {
        let env = std::env::vars_os()
            .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
            .collect();
        Self {
            env,
            home: std::env::home_dir().unwrap_or_else(|| PathBuf::from("/")),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
            platform: Platform::current(),
        }
    }

    pub fn child_env(&self) -> BTreeMap<String, String> {
        let mut env = without_gpu_launch_env(&self.env);
        env.remove(RELAUNCHED_ENV);
        env
    }

    pub fn var(&self, name: &str) -> Option<&str> {
        self.env
            .get(name)
            .map(String::as_str)
            .filter(|value| !value.is_empty())
    }

    pub fn app_var(&self, name: &str) -> Option<&str> {
        self.var(&format!("OSTIA_{name}"))
    }

    pub fn config_home(&self) -> PathBuf {
        self.var("XDG_CONFIG_HOME")
            .map_or_else(|| self.home.join(".config"), PathBuf::from)
    }

    pub fn data_home(&self) -> PathBuf {
        self.var("XDG_DATA_HOME")
            .map_or_else(|| self.home.join(".local").join("share"), PathBuf::from)
    }

    pub fn app_config_dir(&self) -> PathBuf {
        match self.platform {
            Platform::Darwin => self
                .home
                .join("Library")
                .join("Application Support")
                .join(APP_DIR_NAME),
            Platform::Linux => self.config_home().join(APP_DIR_NAME),
        }
    }

    pub fn ensure_app_config_dir(&self) -> Result<PathBuf> {
        let dir = self.app_config_dir();
        fs::create_dir_all(&dir).map_err(io_error(&dir))?;
        Ok(dir)
    }

    pub fn app_data_dir(&self) -> PathBuf {
        self.data_home().join(APP_DIR_NAME)
    }

    pub fn tmp_dir(&self) -> PathBuf {
        let raw = self
            .var("TMPDIR")
            .or_else(|| self.var("TMP"))
            .or_else(|| self.var("TEMP"))
            .unwrap_or("/tmp");
        let trimmed = if raw.len() > 1 {
            raw.strip_suffix('/').unwrap_or(raw)
        } else {
            raw
        };
        PathBuf::from(trimmed)
    }

    pub fn resolve(&self, path: &Path) -> PathBuf {
        node_path::resolve(path, &self.cwd)
    }
}
