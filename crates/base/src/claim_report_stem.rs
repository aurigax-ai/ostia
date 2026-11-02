use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::error::{Result, io_error};
use crate::node_path;

pub fn claim_report_stem(
    dir: &Path,
    mut stem_of: impl FnMut(&[String]) -> String,
) -> Result<PathBuf> {
    loop {
        let names = fs::read_dir(dir)
            .and_then(|entries| {
                entries
                    .map(|entry| {
                        entry.map(|found| found.file_name().to_string_lossy().into_owned())
                    })
                    .collect::<std::io::Result<Vec<String>>>()
            })
            .map_err(io_error(dir))?;
        let stem = node_path::join(dir, &stem_of(&names));
        let mut report = OsString::from(stem.as_os_str());
        report.push(".md");
        let report = PathBuf::from(report);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&report)
        {
            Ok(_) => return Ok(stem),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(io_error(&report)(error)),
        }
    }
}
