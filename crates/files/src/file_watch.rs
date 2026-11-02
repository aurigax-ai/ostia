use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeChangeKind {
    Created,
    Changed,
    Deleted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeChange {
    pub path: PathBuf,
    pub kind: TreeChangeKind,
}
