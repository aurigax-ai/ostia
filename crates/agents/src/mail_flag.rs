use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use ostia_base::Result;
use ostia_base::atomic_write::{AtomicWriteOptions, write_file_atomic};
use ostia_base::error::io_error;
use parking_lot::Mutex;

fn remove_if_present(path: &std::path::Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(io_error(path)(error)),
        _ => Ok(()),
    }
}

#[derive(Default)]
struct Flags {
    paths: Vec<(String, PathBuf)>,
    written: HashMap<String, usize>,
    sequence: u64,
}

#[derive(Clone, Default)]
pub struct MailFlags {
    flags: Arc<Mutex<Flags>>,
}

impl MailFlags {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, external_id: &str, path: impl Into<PathBuf>) {
        let path = path.into();
        let mut flags = self.flags.lock();
        match flags.paths.iter_mut().find(|(id, _)| id == external_id) {
            Some(entry) => entry.1 = path,
            None => flags.paths.push((external_id.to_owned(), path)),
        }
        flags.written.remove(external_id);
    }

    pub fn forget(&self, external_id: &str) -> Result<()> {
        let mut flags = self.flags.lock();
        if let Some(index) = flags.paths.iter().position(|(id, _)| id == external_id) {
            remove_if_present(&flags.paths[index].1)?;
            flags.paths.remove(index);
        }
        flags.written.remove(external_id);
        Ok(())
    }

    pub fn sync(&self, counts: &HashMap<String, usize>) {
        let mut flags = self.flags.lock();
        let Flags {
            paths,
            written,
            sequence,
        } = &mut *flags;
        for (external_id, path) in paths.iter() {
            let count = counts.get(external_id).copied().unwrap_or(0);
            if written.get(external_id) == Some(&count) {
                continue;
            }
            *sequence += 1;
            let text = format!("{count}:{sequence}\n");
            let options = AtomicWriteOptions {
                mode: Some(0o600),
                dir_mode: None,
            };
            match write_file_atomic(path, text.as_bytes(), options) {
                Ok(()) => {
                    written.insert(external_id.clone(), count);
                }
                Err(_) => {
                    written.remove(external_id);
                }
            }
        }
    }
}
