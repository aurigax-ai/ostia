use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileTarget {
    pub path: PathBuf,
    pub line: Option<u64>,
    pub column: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenFileError {
    NotFound,
    Directory,
    NotAFile,
    Unreadable,
    OutsideSandbox,
}
