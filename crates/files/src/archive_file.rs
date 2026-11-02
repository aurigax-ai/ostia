use std::fs::{File, Metadata, OpenOptions};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use ostia_contract::files_api::ArchiveEntryProblem;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryProblem {
    Encrypted,
    Link,
    UnzipLimit,
    Gone,
    TooLarge,
    Unreadable,
}

impl EntryProblem {
    pub fn archive_reason(self) -> Option<ArchiveEntryProblem> {
        match self {
            Self::Encrypted => Some(ArchiveEntryProblem::Encrypted),
            Self::Link => Some(ArchiveEntryProblem::Link),
            Self::UnzipLimit => Some(ArchiveEntryProblem::UnzipLimit),
            Self::Gone => Some(ArchiveEntryProblem::Gone),
            Self::TooLarge | Self::Unreadable => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntryRead {
    Ok {
        data: Vec<u8>,
    },
    Failed {
        problem: EntryProblem,
        size: Option<u64>,
    },
}

#[derive(Debug)]
pub struct OpenedFile {
    pub file: File,
    pub stat: Metadata,
}

pub fn open_regular(path: &Path) -> Option<OpenedFile> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let stat = file.metadata().ok()?;
    stat.is_file().then_some(OpenedFile { file, stat })
}
