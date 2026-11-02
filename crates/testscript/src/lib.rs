use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

static SCRIPTS: Mutex<()> = Mutex::new(());

pub type ScriptsGuard = MutexGuard<'static, ()>;

pub fn lock() -> ScriptsGuard {
    SCRIPTS.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn write_script(path: &Path, text: &str, mode: u32) -> io::Result<()> {
    fs::write(path, text)?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}
