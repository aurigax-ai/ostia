use std::collections::{HashMap, HashSet};
use std::io::Error;

const TCC_DENIED: &str = "Operation not permitted";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProtectedFolder {
    Downloads,
    Documents,
}

pub const PROTECTED_FOLDERS: [ProtectedFolder; 2] =
    [ProtectedFolder::Downloads, ProtectedFolder::Documents];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FolderRead {
    Ok,
    Denied,
    Other,
}

pub type FolderReads = HashMap<ProtectedFolder, FolderRead>;

pub fn folder_read_of_error(error: &Error) -> FolderRead {
    match error.raw_os_error() {
        Some(libc::EPERM) => FolderRead::Denied,
        Some(_) => FolderRead::Other,
        None if error.to_string().contains(TCC_DENIED) => FolderRead::Denied,
        None => FolderRead::Other,
    }
}

pub fn folder_read_of_command(exit_code: i32, stderr: &str) -> FolderRead {
    if exit_code == 0 {
        FolderRead::Ok
    } else if stderr.contains(TCC_DENIED) {
        FolderRead::Denied
    } else {
        FolderRead::Other
    }
}

#[derive(Default)]
pub struct FolderAccessMonitor {
    readable: HashSet<ProtectedFolder>,
    reported: HashSet<Vec<ProtectedFolder>>,
}

impl FolderAccessMonitor {
    pub fn observe(&mut self, rounds: &[FolderReads]) -> Option<Vec<ProtectedFolder>> {
        for reads in rounds {
            for folder in PROTECTED_FOLDERS {
                if reads.get(&folder) == Some(&FolderRead::Ok) {
                    self.readable.insert(folder);
                }
            }
        }
        let blocked: Vec<ProtectedFolder> = PROTECTED_FOLDERS
            .into_iter()
            .filter(|folder| {
                self.readable.contains(folder)
                    && rounds
                        .iter()
                        .any(|reads| reads.get(folder) == Some(&FolderRead::Denied))
            })
            .collect();
        if blocked.is_empty() || !self.reported.insert(blocked.clone()) {
            return None;
        }
        Some(blocked)
    }
}
