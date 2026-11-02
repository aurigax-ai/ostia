use serde::{Deserialize, Serialize};

pub mod app_handler;
pub mod app_links;
pub mod archive_file;
pub mod archive_tree;
pub mod archives;
pub mod browse_providers;
pub mod browser_pages;
pub mod exclusive_transfer;
pub mod external_editor;
pub mod file_guard;
pub mod fs_binary;
pub mod fs_range;

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileOpResult {
    Ok {
        paths: Vec<String>,
    },
    Err {
        error: FileOpError,
        paths: Option<Vec<String>>,
        partial: Option<Vec<String>>,
    },
}
