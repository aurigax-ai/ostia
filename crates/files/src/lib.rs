use serde::{Deserialize, Serialize};

pub mod app_handler;
pub mod app_links;
pub mod archive_file;
pub mod archive_tree;
pub mod archives;
pub mod browse_providers;
pub mod browser_pages;

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
