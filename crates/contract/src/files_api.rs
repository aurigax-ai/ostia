#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsEntry {
    pub name: String,
    pub dir: bool,
    pub archive: bool,
    pub link: Option<String>,
    pub encrypted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FsKind {
    File,
    Dir,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchiveEntryProblem {
    Encrypted,
    Link,
    UnzipLimit,
    Gone,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FsBinaryResult {
    Ok { data: Vec<u8> },
    Denied,
    Unreadable,
    TooLarge { size: u64 },
    Archive { reason: ArchiveEntryProblem },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FsTextResult {
    Ok { text: String, version: String },
    Missing,
    Denied,
    Unreadable,
    Binary,
    TooLarge { size: u64 },
    Archive { reason: ArchiveEntryProblem },
}
