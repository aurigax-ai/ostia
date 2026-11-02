use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::atomic_write::{AtomicWriteOptions, write_file_atomic, write_file_atomic_async};
use crate::error::{Error, Result};
use crate::host::Host;
use crate::js::js_trim;
use crate::{PRODUCT_NAME, node_path};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreScope {
    Project,
    Global,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SaveOptions {
    pub secure: bool,
}

impl SaveOptions {
    pub const SECURE: Self = Self { secure: true };

    fn atomic(self) -> AtomicWriteOptions {
        if self.secure {
            AtomicWriteOptions::SECURE
        } else {
            AtomicWriteOptions::default()
        }
    }
}

pub fn project_dir() -> String {
    format!(".{PRODUCT_NAME}")
}

pub fn store_path(host: &Host, name: &str, scope: StoreScope, work_dir: Option<&str>) -> PathBuf {
    match scope {
        StoreScope::Global => host.app_data_dir().join(format!("{name}.json")),
        StoreScope::Project => {
            let base = work_dir
                .filter(|dir| !js_trim(dir).is_empty())
                .map_or_else(|| host.cwd.clone(), PathBuf::from);
            node_path::join(&base, &format!("{}/{name}.json", project_dir()))
        }
    }
}

pub fn load_json(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()
}

pub fn save_json<T: Serialize>(path: &Path, data: &T, options: SaveOptions) -> Result<()> {
    let text = serde_json::to_string_pretty(data).map_err(|source| Error::Json {
        path: path.to_path_buf(),
        source,
    })?;
    write_file_atomic(path, text.as_bytes(), options.atomic())
}

pub async fn save_json_async<T: Serialize>(
    path: &Path,
    data: &T,
    options: SaveOptions,
) -> Result<()> {
    let text = serde_json::to_string(data).map_err(|source| Error::Json {
        path: path.to_path_buf(),
        source,
    })?;
    write_file_atomic_async(path.to_path_buf(), text.into_bytes(), options.atomic()).await
}
