use serde::{Deserialize, Serialize};

pub mod app_handler;
pub mod app_links;
pub mod archive_file;
pub mod archive_tree;
pub mod archives;
pub mod at_fs;
pub mod browse_providers;
pub mod browser_pages;
pub mod file_watch;
pub mod transfer_fs;
pub mod trash_mounts;
pub mod watched_files;
pub mod fuzzy_paths;
#[cfg(target_os = "macos")]
pub mod mac_at;
pub mod open_file_grants;
pub mod open_waits;
#[cfg(target_os = "linux")]
pub mod proc_at_fs;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileOpError {
    Outside,
    InvalidName,
    Exists,
    IntoItself,
    Sandboxed,
    NotMoved,
    Partial,
    NoTrash,
    Failed,
}
