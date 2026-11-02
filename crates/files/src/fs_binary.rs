use std::fs;
use std::path::PathBuf;

use ostia_contract::files_api::FsBinaryResult;

pub const FS_BINARY_MAX: u64 = 50 * 1024 * 1024;

pub fn read_binary_confined(
    path: &str,
    confine: impl Fn(&str) -> Option<PathBuf>,
    max: u64,
) -> FsBinaryResult {
    let Some(safe) = confine(path) else {
        return FsBinaryResult::Denied;
    };
    let Ok(stat) = fs::metadata(&safe) else {
        return FsBinaryResult::Unreadable;
    };
    if !stat.is_file() {
        return FsBinaryResult::Unreadable;
    }
    if stat.len() > max {
        return FsBinaryResult::TooLarge { size: stat.len() };
    }
    match fs::read(&safe) {
        Ok(data) if data.len() as u64 > max => FsBinaryResult::TooLarge {
            size: data.len() as u64,
        },
        Ok(data) => FsBinaryResult::Ok { data },
        Err(_) => FsBinaryResult::Unreadable,
    }
}
