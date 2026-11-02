use std::fs::{self, DirBuilder, OpenOptions, Permissions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use sha2::{Digest, Sha256};

use crate::error::{Error, Result, io_error};
use crate::js::static_regex;
use crate::process::is_running;
use crate::random::random_bytes;

#[derive(Clone, Copy, Debug, Default)]
pub struct AtomicWriteOptions {
    pub mode: Option<u32>,
    pub dir_mode: Option<u32>,
}

impl AtomicWriteOptions {
    pub const SECURE: Self = Self {
        mode: Some(0o600),
        dir_mode: Some(0o700),
    };
}

static TEMP_NAME: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^(.+)\.([0-9a-f]{8})\.([0-9]+)\.[0-9a-f]{16}\.tmp$"));

static HOST_TAG: LazyLock<String> = LazyLock::new(|| {
    let uname = rustix::system::uname();
    let digest = Sha256::digest(uname.nodename().to_bytes());
    hex::encode(digest.as_slice())[..8].to_owned()
});

fn temp_path(path: &Path) -> PathBuf {
    let suffix: [u8; 8] = random_bytes();
    let mut name = path.as_os_str().to_owned();
    name.push(format!(
        ".{}.{}.{}.tmp",
        HOST_TAG.as_str(),
        std::process::id(),
        hex::encode(suffix)
    ));
    PathBuf::from(name)
}

fn is_stale_temp(base: &str, name: &str) -> bool {
    let Some(captures) = TEMP_NAME.captures(name) else {
        return false;
    };
    if &captures[1] != base || &captures[2] != HOST_TAG.as_str() {
        return false;
    }
    match captures[3].parse::<u32>() {
        Ok(pid) if pid == std::process::id() => false,
        Ok(pid) => match i32::try_from(pid) {
            Ok(pid) => !is_running(pid),
            Err(_) => true,
        },
        Err(_) => true,
    }
}

fn remove_stale_temps(path: &Path, dir: &Path) -> Result<()> {
    let Some(base) = path.file_name().and_then(|name| name.to_str()) else {
        return Ok(());
    };
    for entry in fs::read_dir(dir).map_err(io_error(dir))? {
        let entry = entry.map_err(io_error(dir))?;
        let name = entry.file_name();
        if name.to_str().is_some_and(|name| is_stale_temp(base, name)) {
            let stale = entry.path();
            match fs::remove_file(&stale) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(io_error(&stale)(err)),
            }
        }
    }
    Ok(())
}

fn write_and_rename(tmp: &Path, path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(tmp)
        .map_err(io_error(tmp))?;
    let written = file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(io_error(tmp));
    drop(file);
    let renamed = written.and_then(|()| fs::rename(tmp, path).map_err(io_error(path)));
    if renamed.is_err() {
        let _ = fs::remove_file(tmp);
    }
    renamed
}

pub fn write_file_atomic(path: &Path, bytes: &[u8], options: AtomicWriteOptions) -> Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let dir = if dir.as_os_str().is_empty() {
        Path::new(".")
    } else {
        dir
    };
    DirBuilder::new()
        .recursive(true)
        .mode(options.dir_mode.unwrap_or(0o777))
        .create(dir)
        .map_err(io_error(dir))?;
    if let Some(mode) = options.dir_mode {
        fs::set_permissions(dir, Permissions::from_mode(mode)).map_err(io_error(dir))?;
    }
    remove_stale_temps(path, dir)?;
    let tmp = temp_path(path);
    write_and_rename(&tmp, path, bytes, options.mode.unwrap_or(0o666))
}

pub async fn write_file_atomic_async(
    path: PathBuf,
    bytes: Vec<u8>,
    options: AtomicWriteOptions,
) -> Result<()> {
    tokio::task::spawn_blocking(move || write_file_atomic(&path, &bytes, options))
        .await
        .map_err(|err| Error::Task(err.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::{HOST_TAG, is_stale_temp};

    fn temp(base: &str, host: &str, pid: &str) -> String {
        format!("{base}.{host}.{pid}.0123456789abcdef.tmp")
    }

    #[test]
    fn a_temp_of_a_dead_process_on_this_host_is_stale() {
        assert!(is_stale_temp(
            "s.json",
            &temp("s.json", &HOST_TAG, "2147483646")
        ));
    }

    #[test]
    fn a_temp_of_this_process_of_another_file_or_of_another_host_is_kept() {
        let own = std::process::id().to_string();
        assert!(!is_stale_temp("s.json", &temp("s.json", &HOST_TAG, &own)));
        assert!(!is_stale_temp(
            "s.json",
            &temp("t.json", &HOST_TAG, "2147483646")
        ));
        assert!(!is_stale_temp(
            "s.json",
            &temp("s.json", "00000000", "2147483646")
        ));
        assert!(!is_stale_temp("s.json", "s.json"));
    }
}
