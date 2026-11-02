use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{path}: {source}", path = .path.display())]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("{path}: {source}", path = .path.display())]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("refusing to use {path}: {reason}", path = .path.display())]
    UnsafePath { path: PathBuf, reason: String },
    #[error("background task failed: {0}")]
    Task(String),
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn io_error(path: &Path) -> impl FnOnce(std::io::Error) -> Error + '_ {
    move |source| Error::Io {
        path: path.to_path_buf(),
        source,
    }
}
